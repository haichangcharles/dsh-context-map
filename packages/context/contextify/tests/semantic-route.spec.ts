import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildContextActionPacket, parseFastContextDecisionText, parseSemanticContextRoute,
  planSemanticContextRoute } from '../src/semantic-route.ts'
import { draftRouteAdvice } from '../src/draft-route.ts'
import { deriveContextStewardProfile } from '../src/context-steward-profile.ts'
import type { ContextFamilyGraph } from '../src/types.ts'

const main = SessionId('main')
const writing = SessionId('writing')
const research = SessionId('research')
const graph = {
  rootSessionId: main, activeSessionId: writing,
  sessions: [{ id: main, depth: 0 }, { id: writing, parentSessionId: main, depth: 1 },
    { id: research, parentSessionId: main, depth: 1, workState: 'parked' }],
  nodes: [
    { id: 'main:1', owner: { sessionId: main, seq: 1 }, role: 'user',
      preview: 'Plan an article', sessionIds: [main, writing, research] },
    { id: 'writing:1', owner: { sessionId: writing, seq: 1 }, role: 'user',
      preview: 'Write the introduction', sessionIds: [writing] },
    { id: 'research:1', owner: { sessionId: research, seq: 1 }, role: 'user',
      preview: 'Check official Web sources', sessionIds: [research] },
  ], edges: [],
} as unknown as ContextFamilyGraph
const base = { activeSessionId: writing, planRevision: 2, graphRevision: 'g2' }
const profile = deriveContextStewardProfile([], { branchDepth: 1 })
const packet = buildContextActionPacket({ graph, contents: {}, objective: 'Find supporting sources', base })
const scored = (intent: string, intentScore = 0.9, destinationScore = 0.9, evidenceScore = 0.1) => ({
  intent, intentScore, candidates: [{ sessionId: research, destinationScore, evidenceScore, supersededScore: 0 }],
})

describe('bounded semantic Context actions', () => {
  it('accepts legacy selection output and separates optional route scores', () => {
    const legacy = { include: [], exclude: [], archive: [] }
    expect(parseFastContextDecisionText(JSON.stringify(legacy), packet)).toEqual({ decision: legacy })
    const result = parseFastContextDecisionText(JSON.stringify({ ...legacy, route: scored('resume') }), packet)
    expect(result.decision).toEqual(legacy)
    expect(result.route?.intent).toBe('resume')
    expect(Object.isFrozen(result.route?.candidates)).toBe(true)
  })

  it('rejects invalid JSON, unsupported fields, and nonobjects', () => {
    for (const text of ['no response', '{bad}', '[]', '{"other":1}', '{"route":null}']) {
      expect(() => parseFastContextDecisionText(text, packet)).toThrow()
    }
    expect(() => parseSemanticContextRoute([], packet)).toThrow()
    expect(() => parseSemanticContextRoute({ ...scored('resume'), other: 1 }, packet)).toThrow()
    expect(() => parseSemanticContextRoute({ ...scored('resume'), candidates: 'bad' }, packet)).toThrow()
    expect(() => parseSemanticContextRoute({ ...scored('resume'), candidates: [null] }, packet)).toThrow()
    expect(() => parseSemanticContextRoute({ ...scored('resume'), candidates: [
      { ...scored('resume').candidates[0], extra: true },
    ] }, packet)).toThrow()
  })

  it('rejects foreign, active, duplicated or over-limit Session scores and unknown intent', () => {
    for (const sessionId of ['foreign', writing, 3]) {
      expect(() => parseSemanticContextRoute({ ...scored('resume'), candidates: [
        { ...scored('resume').candidates[0], sessionId },
      ] }, packet)).toThrow()
    }
    expect(() => parseSemanticContextRoute({ ...scored('resume'), candidates: [
      ...scored('resume').candidates, ...scored('resume').candidates,
    ] }, packet)).toThrow()
    expect(() => parseSemanticContextRoute({ ...scored('resume'), candidates: Array(9).fill({}) }, packet)).toThrow()
    expect(() => parseSemanticContextRoute(scored('launch'), packet)).toThrow()
  })

  it('accepts exact score endpoints but rejects missing, nonnumeric and nonfinite scores', () => {
    expect(parseSemanticContextRoute(scored('unknown', 0, 1, 0), packet).intentScore).toBe(0)
    for (const value of [undefined, NaN, Infinity, -0.1, 1.1, '0.9']) {
      for (const key of ['intentScore', 'destinationScore', 'evidenceScore', 'supersededScore']) {
        const route = scored('resume')
        const invalid = key === 'intentScore' ? { ...route, intentScore: value }
          : { ...route, candidates: [{ ...route.candidates[0], [key]: value }] }
        expect(() => parseSemanticContextRoute(invalid, packet)).toThrow()
      }
    }
  })

  it('uses destination scores for resume but keeps evidence imports on the current branch', () => {
    const resume = parseSemanticContextRoute(scored('resume'), packet)
    expect(planSemanticContextRoute({ packet, route: resume, profile })).toMatchObject({
      action: 'navigate', targetSessionId: research,
    })
    const reference = parseSemanticContextRoute(scored('reference', 0.9, 0.95, 0.95), packet)
    expect(planSemanticContextRoute({ packet, route: reference, profile,
      evidenceNodeIds: ['research:1', 'foreign'] })).toMatchObject({
      action: 'include', sourceNodeIds: ['research:1'],
    })
    expect(draftRouteAdvice({ graph, contents: {}, objective: packet.objective,
      base, profile, routePacket: packet, semanticRoute: reference })).toBeUndefined()
  })

  it('requires new-task confidence and never branches because a destination score is low', () => {
    for (const [intent, confidence] of [['unknown', 1], ['new-task', 0.79], ['resume', 0.79]] as const) {
      expect(planSemanticContextRoute({ packet, route: parseSemanticContextRoute(
        scored(intent, confidence, 0), packet), profile }).action).toBe('continue')
    }
    expect(planSemanticContextRoute({ packet, route: parseSemanticContextRoute(
      scored('new-task', 0.8, 0), packet), profile }).action).toBe('branch')
    expect(planSemanticContextRoute({ packet, route: parseSemanticContextRoute(
      scored('new-task', 0.9, 0.95), packet), profile }).action).toBe('navigate')
  })

  it('honors explicit mainline return or new topic before contrary semantic intent', () => {
    for (const [objective, action] of [['Return to the mainline', 'return'],
      ['New topic: arrange a conference trip', 'branch']] as const) {
      const exact = buildContextActionPacket({ graph, contents: {}, objective, base })
      const route = parseSemanticContextRoute(scored('reference', 0.9, 0.1), exact)
      expect(draftRouteAdvice({ graph, contents: {}, objective, base, profile,
        routePacket: exact, semanticRoute: route })).toMatchObject({ action })
    }
  })

  it('refuses stale packet revisions and superseded sources', () => {
    const route = parseSemanticContextRoute(scored('resume'), packet)
    expect(draftRouteAdvice({ graph, contents: {}, objective: packet.objective,
      base: { ...base, planRevision: 3 }, profile, routePacket: packet, semanticRoute: route })).toBeUndefined()
    const unsafe = parseSemanticContextRoute({ ...scored('resume'), candidates: [
      { ...scored('resume').candidates[0], supersededScore: 0.5 },
    ] }, packet)
    expect(planSemanticContextRoute({ packet, route: unsafe, profile }).action).toBe('continue')
  })

  it('requires visible, valid parent material for an inferred Return while honoring explicit Return', () => {
    const route = parseSemanticContextRoute({ intent: 'return', intentScore: 1,
      candidates: [{ sessionId: main, destinationScore: .95, evidenceScore: 0, supersededScore: .8 }] }, packet)
    expect(planSemanticContextRoute({ packet, route, profile }).action).toBe('continue')
    const hidden = buildContextActionPacket({ graph, contents: {}, objective: packet.objective, base,
      visibleNodeIds: ['writing:1'] })
    expect(planSemanticContextRoute({ packet: hidden, route: { ...route,
      candidates: [{ ...route.candidates[0]!, supersededScore: 0 }] }, profile }).action).toBe('continue')
    const explicit = { ...packet, explicitIntent: 'return' as const }
    expect(planSemanticContextRoute({ packet: explicit, route, profile })).toMatchObject({ action: 'return', targetSessionId: main })
  })

  it('uses the existing destination review threshold only when joint placement and selected graph evidence agree', () => {
    const route = parseSemanticContextRoute(scored('resume', .74, .74), packet)
    const input = { packet, route, profile, jointPlacement: true, selectedNodeIds: ['research:1'] }
    expect(planSemanticContextRoute(input)).toMatchObject({ action: 'navigate', targetSessionId: research })
    expect(planSemanticContextRoute({ ...input, jointPlacement: false }).action).toBe('continue')
    expect(planSemanticContextRoute({ ...input, selectedNodeIds: ['writing:1'] }).action).toBe('continue')
    expect(planSemanticContextRoute({ packet, route, profile, jointPlacement: true }).action).toBe('continue')
    expect(planSemanticContextRoute({ ...input, route: parseSemanticContextRoute(scored('resume', .74, .75), packet) }).action).toBe('continue')
    expect(planSemanticContextRoute({ ...input, route: parseSemanticContextRoute(scored('resume', .69, .69), packet) }).action).toBe('continue')
    expect(planSemanticContextRoute({ ...input, route: parseSemanticContextRoute(scored('new-task', .74, .1), packet) }).action).toBe('continue')
  })

  it('bounds packet Sessions, sources, Unicode text and draft while retaining native metadata', () => {
    const large = { ...graph,
      sessions: [graph.sessions[1], ...Array.from({ length: 12 }, (_, index) => ({
        id: SessionId('s' + String(index)), depth: 1, parentSessionId: main,
      }))],
      nodes: Array.from({ length: 12 * 20 }, (_, index) => ({
        ...graph.nodes[2], id: 'n' + String(index), owner: { sessionId: SessionId('s' + String(Math.floor(index / 20))), seq: index },
        sessionIds: [SessionId('s' + String(Math.floor(index / 20)))], preview: '界'.repeat(2000),
      })),
    } as ContextFamilyGraph
    const value = buildContextActionPacket({ graph: large, contents: {}, objective: '界'.repeat(5000), base })
    expect(value.candidates).toHaveLength(8)
    expect(Array.from(value.objective)).toHaveLength(4000)
    expect(value.candidates.every(candidate => candidate.nodes.length === 12
      && candidate.nodes.every(node => Array.from(node.content).length === 1200 && node.truncated))).toBe(true)
    expect(value.candidates[0]?.parentSessionId).toBe(main)
    expect(JSON.parse(JSON.stringify(value))).toEqual(value)
    expect(Object.isFrozen(value.candidates[0]?.nodes)).toBe(true)
  })

  it('retains typed source kind and handles root Sessions and unscored candidates', () => {
    const rootGraph = { ...graph, activeSessionId: main,
      nodes: graph.nodes.map(node => node.id === 'research:1' ? { ...node, sourceKind: 'web' as const } : node),
    }
    const value = buildContextActionPacket({ graph: rootGraph, contents: { 'research:1': 'Exact source' },
      objective: 'Use supporting sources', base: { ...base, activeSessionId: main },
      visibleNodeIds: ['research:1'] })
    expect(value.parentSessionId).toBeUndefined()
    expect(value.candidates.find(candidate => candidate.sessionId === research)?.nodes[0])
      .toMatchObject({ sourceKind: 'web', content: 'Exact source', truncated: false })
    const route = parseSemanticContextRoute({ intent: 'unknown', intentScore: 1, candidates: [] }, value)
    expect(planSemanticContextRoute({ packet: value, route, profile }).action).toBe('continue')
  })

  it('restricts evidence imports to model-visible candidate sources', () => {
    const value = buildContextActionPacket({ graph, contents: { 'research:1': 'Exact source' },
      objective: packet.objective, base, visibleNodeIds: ['main:1'] })
    expect(value.candidates.find(candidate => candidate.sessionId === research)?.nodes).toEqual([])
    const route = parseSemanticContextRoute(scored('reference', 1, 0, 1), value)
    expect(planSemanticContextRoute({ packet: value, route, profile,
      evidenceNodeIds: ['research:1'] }).action).toBe('continue')
  })

  it('accepts lifecycle advice and route scores in the same bounded Fast response', () => {
    const workStates = [{ sessionId: research, state: 'completed', reason: 'The source lookup is finished' }]
    const result = parseFastContextDecisionText(JSON.stringify({ include: [], exclude: [], archive: [],
      route: scored('reference'), workStates }), packet)
    expect(result.decision.workStates).toEqual(workStates)
    expect(result.route?.intent).toBe('reference')
  })


  it('includes bounded confirmed route examples without making historical targets legal', () => {
    const historical = SessionId('historical-target')
    const observations = Array.from({ length: 10 }, (_, index) => ({
      action: 'branch' as const, choice: 'accept' as const, origin: 'explicit-review' as const,
      objective: '界'.repeat(1000), branchDepth: 1, at: index,
      sourceSessionId: SessionId('historic-source'), sourceEventSeq: index,
      targetSessionId: historical,
    }))
    const value = buildContextActionPacket({ graph, contents: {}, objective: packet.objective, base,
      preferenceExamples: [...observations,
        { ...observations[0]!, action: 'include', at: 11 },
        { ...observations[0]!, action: 'release', at: 12 },
        { ...observations[0]!, action: 'park', undone: true, at: 13 },
        { action: 'navigate', choice: 'reject', origin: 'manual-action', branchDepth: 1, at: 14 },
      ] })
    expect(value.preferenceExamples).toHaveLength(8)
    expect(value.preferenceExamples?.[0]?.sourceEventSeq).toBe(3)
    expect(value.preferenceExamples?.[0]?.sourceSessionId).toBe('historic-source')
    expect(Array.from(value.preferenceExamples?.[0]?.objective ?? '')).toHaveLength(800)
    expect(Object.isFrozen(value.preferenceExamples)).toBe(true)
    expect(value.preferenceExamples?.at(-1)?.objective).toBeUndefined()
    expect(() => parseSemanticContextRoute({ ...scored('resume'), candidates: [
      { ...scored('resume').candidates[0], sessionId: historical },
    ] }, value)).toThrow(/unavailable/)
  })

  it('bounds historical task text and keeps source-only Branch examples', () => {
    const common = { action: 'branch' as const, choice: 'accept' as const, origin: 'manual-action' as const,
      branchDepth: 0, at: 1 }
    const value = buildContextActionPacket({ graph, contents: {}, objective: packet.objective, base,
      preferenceExamples: [{ ...common, routeContext: { source: '界'.repeat(900) } },
        { ...common, routeContext: { source: 'old task', target: '界'.repeat(900) } }] })
    expect(value.preferenceExamples?.[0]?.routeContext).toEqual({ source: '界'.repeat(800) })
    expect(value.preferenceExamples?.[1]?.routeContext?.target).toBe('界'.repeat(800))
  })

})

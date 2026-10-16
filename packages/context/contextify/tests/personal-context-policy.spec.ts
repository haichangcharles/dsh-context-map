import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm/brand'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  calibrateContextRecommendation,
  contextEditsFromFamily,
  contextEditEvidenceFromFamily,
  declinedContextActionsForObjective,
  contextPlanExamplesFromFamily,
  personalContextCandidateBonus,
  personalContextStyleAdvice,
} from '../src/personal-context-policy.ts'
import { validateRecommendation } from '../src/recommendation.ts'
import { projectSessionFamily } from '../src/family.ts'
import { contextPolicyObservationsFromFamily } from '../src/context-steward-profile.ts'
import type { ContextFamilyGraph, ContextFamilyInspection } from '../src/types.ts'

describe('personal Context candidate routing', () => {
  it('shrinks from explicit Include/Exclude edits and ignores unrelated objectives', () => {
    const positive = { objective: 'compare warranty coverage', content: 'vendor regional repair terms', mode: 'include' as const }
    const negative = { ...positive, mode: 'exclude' as const }
    expect(personalContextCandidateBonus('compare warranty coverage', positive.content, [])).toBe(0)
    expect(personalContextCandidateBonus('compare warranty coverage', positive.content, [positive])).toBeGreaterThan(0)
    expect(personalContextCandidateBonus('compare warranty coverage', positive.content, [negative])).toBeLessThan(0)
    expect(personalContextCandidateBonus('unrelated weather forecast', positive.content, [positive])).toBe(0)
  })

  it('learns source-specific review habits without applying Web edits to chat nodes', () => {
    const edits = ['camera', 'hotel', 'router', 'warranty'].map((topic, index) => ({
      objective: `compare ${topic}`, content: `web page ${String(index)}`,
      mode: 'exclude' as const, sourceKind: 'web' as const, onActiveBranch: true,
    }))
    expect(personalContextCandidateBonus('new task', 'different web page', edits, true, 'web'))
      .toBeLessThan(-0.08)
    expect(personalContextCandidateBonus('new task', 'different chat message', edits, true, 'chat'))
      .toBe(0)
    expect(personalContextCandidateBonus('new task', 'different worker report', edits, true, 'worker'))
      .toBe(0)
  })

  it('backs off from sparse joint cells to a stable source or path preference', () => {
    const sourceHabits = [
      ...['camera', 'hotel', 'router', 'warranty'].map(objective => ({
        objective, content: objective, mode: 'include' as const,
        sourceKind: 'web' as const, onActiveBranch: true,
      })),
      ...['flight', 'paper', 'laptop', 'garden'].map(objective => ({
        objective, content: objective, mode: 'exclude' as const,
        sourceKind: 'chat' as const, onActiveBranch: true,
      })),
    ]
    expect(personalContextStyleAdvice(sourceHabits, {
      sourceKind: 'web', onActiveBranch: true,
    })?.mode).toBe('include')
    expect(personalContextStyleAdvice(sourceHabits, {
      sourceKind: 'chat', onActiveBranch: true,
    })?.mode).toBe('exclude')
    expect(personalContextStyleAdvice(sourceHabits.slice(0, 3), {
      sourceKind: 'web', onActiveBranch: true,
    })).toBeNull()

    const pathHabits = ['chat', 'web', 'worker'].flatMap(sourceKind => [
      { objective: `${sourceKind} return`, content: sourceKind, mode: 'include' as const,
        sourceKind: sourceKind as 'chat' | 'web' | 'worker', onActiveBranch: true },
      { objective: `${sourceKind} new`, content: sourceKind, mode: 'exclude' as const,
        sourceKind: sourceKind as 'chat' | 'web' | 'worker', onActiveBranch: false },
    ])
    expect(personalContextStyleAdvice(pathHabits, {
      sourceKind: 'worker', onActiveBranch: false,
    })?.mode).toBe('exclude')
  })

  it('holds out whole review episodes when selecting a personalization axis', () => {
    const groups = [
      { episodeId: 'sheet-a', sourceKind: 'web' as const, onActiveBranch: true,
        mode: 'include' as const },
      { episodeId: 'sheet-b', sourceKind: 'web' as const, onActiveBranch: false,
        mode: 'exclude' as const },
      { episodeId: 'sheet-c', sourceKind: 'chat' as const, onActiveBranch: true,
        mode: 'exclude' as const },
    ]
    const edits = groups.flatMap(group => Array.from({ length: 3 }, (_, index) => ({
      objective: group.episodeId, content: `item ${String(index)}`, ...group,
    })))
    const candidate = { sourceKind: 'web' as const, onActiveBranch: true }
    expect(personalContextStyleAdvice(edits.map(({ episodeId: _episodeId, ...edit }) => edit),
      candidate)?.mode).toBe('include')
    expect(personalContextStyleAdvice(edits, candidate)).toBeNull()
  })

  it('learns distinct Web search and page-visit habits from reviewed edits', () => {
    const edits = ['camera', 'hotel', 'router', 'warranty', 'flight'].flatMap(objective => [
      { objective, content: 'search result', mode: 'exclude' as const,
        sourceKind: 'web' as const, webAction: 'web_search' as const, onActiveBranch: true },
      { objective, content: 'opened page', mode: 'include' as const,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const, onActiveBranch: true },
    ])
    expect(personalContextStyleAdvice(edits, {
      sourceKind: 'web', webAction: 'web_search', onActiveBranch: true,
    })?.mode).toBe('exclude')
    expect(personalContextStyleAdvice(edits, {
      sourceKind: 'web', webAction: 'web_fetch', onActiveBranch: true,
    })?.mode).toBe('include')
    expect(personalContextCandidateBonus('unrelated task', 'new search result', edits,
      true, 'web', 'web_search')).toBeLessThan(0)
    expect(personalContextCandidateBonus('unrelated task', 'new opened page', edits,
      true, 'web', 'web_fetch')).toBeGreaterThan(0)
    const calibrated = calibrateContextRecommendation({
      include: [],
      exclude: [{ nodeId: 'page', reason: 'generic' }], archive: [],
    }, 'new task', { search: 'new search result', page: 'new opened page' }, edits, [
      { id: 'search', reason: 'recent-active', active: true, included: true,
        sourceKind: 'web', webAction: 'web_search' },
      { id: 'page', reason: 'recent-active', active: true, included: true,
        sourceKind: 'web', webAction: 'web_fetch' },
    ])
    expect(calibrated.include).toEqual([])
    expect(calibrated.exclude.map(item => item.nodeId)).toEqual(['search'])
  })

  it('separates user-authored optional commitments from assistant-authored offers', () => {
    const edits = Array.from({ length: 6 }, (_, index) => [
      { objective: `shopping task ${String(index)}`, content: `my pending order ${String(index)}`,
        mode: 'include' as const, sourceKind: 'chat' as const,
        speakerRole: 'user' as const, onActiveBranch: false },
      { objective: `shopping task ${String(index)}`, content: `old optional offer ${String(index)}`,
        mode: 'exclude' as const, sourceKind: 'chat' as const,
        speakerRole: 'assistant' as const, onActiveBranch: false },
    ]).flat()
    const user = personalContextStyleAdvice(edits, {
      sourceKind: 'chat', speakerRole: 'user', onActiveBranch: false,
    })
    const assistant = personalContextStyleAdvice(edits, {
      sourceKind: 'chat', speakerRole: 'assistant', onActiveBranch: false,
    })
    expect(user?.mode).toBe('include')
    expect(assistant?.mode).toBe('exclude')
    const calibrated = calibrateContextRecommendation({
      include: [], exclude: [{ nodeId: 'user-note', reason: 'generic' }], archive: [],
    }, 'new shopping task', {
      'user-note': 'my pending order', 'assistant-offer': 'old optional offer',
    }, edits, [
      { id: 'user-note', reason: 'off-path-candidate', active: false, included: true,
        sourceKind: 'chat', role: 'user', lexicalScore: 0.2 },
      { id: 'assistant-offer', reason: 'off-path-candidate', active: false, included: false,
        sourceKind: 'chat', role: 'assistant', lexicalScore: 0.2 },
    ])
    expect(calibrated.exclude).toEqual([])

    const opposite = edits.map(edit => ({ ...edit,
      mode: edit.mode === 'include' ? 'exclude' as const : 'include' as const }))
    const oppositeCalibrated = calibrateContextRecommendation({
      include: [], exclude: [{ nodeId: 'user-note', reason: 'generic' }], archive: [],
    }, 'new shopping task', { 'user-note': 'my pending order' }, opposite, [
      { id: 'user-note', reason: 'distant-active-candidate', active: false, included: true,
        sourceKind: 'chat', role: 'user' },
    ])
    expect(personalContextStyleAdvice(opposite, {
      sourceKind: 'chat', speakerRole: 'user', onActiveBranch: false,
    })?.mode).toBe('exclude')
    expect(oppositeCalibrated.exclude.map(item => item.nodeId)).toEqual(['user-note'])
  })

  it('switches after five direct same-cell reversals without reacting to four corrections', () => {
    const cell = { sourceKind: 'web' as const, webAction: 'web_fetch' as const,
      onActiveBranch: false }
    const old = Array.from({ length: 8 }, (_, index) => ({
      objective: `old task ${String(index)}`, content: `old page ${String(index)}`,
      mode: 'include' as const, ...cell,
    }))
    const corrections = Array.from({ length: 5 }, (_, index) => ({
      objective: `new task ${String(index)}`, content: `new page ${String(index)}`,
      mode: 'exclude' as const, ...cell,
    }))
    expect(personalContextStyleAdvice([...old, ...corrections.slice(0, 4)], cell)?.mode)
      .not.toBe('exclude')
    expect(personalContextStyleAdvice([...old, ...corrections], cell))
      .toEqual({ mode: 'exclude', support: 5, axis: 'cell' })
    expect(personalContextStyleAdvice([...old, ...corrections], {
      ...cell, webAction: 'web_search',
    })?.mode).not.toBe('exclude')
    const batched = corrections.map(edit => ({ ...edit, weight: 0.5 }))
    expect(personalContextStyleAdvice([...old, ...batched], cell)?.mode)
      .not.toBe('exclude')
  })

  it('does not spend the bounded Exclude slots on already excluded active nodes', () => {
    const edits = Array.from({ length: 6 }, (_, index) => ({
      objective: `task ${String(index)}`, content: `page ${String(index)}`,
      mode: 'exclude' as const, sourceKind: 'web' as const,
      webAction: 'web_fetch' as const, onActiveBranch: true,
    }))
    const candidates = [
      { id: 'already-1', reason: 'explicit-override', active: true, included: false,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const },
      { id: 'already-2', reason: 'explicit-override', active: true, included: false,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const },
      { id: 'current', reason: 'recent-active', active: true, included: true,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const },
    ]
    expect(calibrateContextRecommendation({ exclude: [], include: [], archive: [] },
      'new task', { current: 'current page' }, edits, candidates).exclude)
      .toEqual([{ nodeId: 'current',
        reason: 'Your earlier reviewed Context edits favored excluding this source type on the active branch.' }])
  })

  it('does not turn old chat exclusions into automatic exclusions of a later correction', () => {
    const edits = Array.from({ length: 5 }, (_, index) => ({
      objective: `Revise laptop requirement ${String(index)}`,
      content: `old laptop requirement ${String(index)}`,
      mode: 'exclude' as const, sourceKind: 'chat' as const, onActiveBranch: true,
    }))
    const candidates = [
      { id: 'old', reason: 'distant-active-candidate', active: true, included: true,
        sourceKind: 'chat' as const, lexicalScore: 0.3 },
      { id: 'current', reason: 'distant-active-candidate', active: true, included: true,
        sourceKind: 'chat' as const, lexicalScore: 0.3 },
    ]
    expect(calibrateContextRecommendation({ include: [], exclude: [], archive: [] },
      'Revise laptop requirement', {
        old: 'old laptop screen must be 17 inches',
        current: 'current laptop screen is now 13 inches',
      }, edits, candidates).exclude).toEqual([])
  })

  it('uses a strong Web action habit for a relevant off-path candidate even when the residual is small', () => {
    const edits = ['camera', 'hotel', 'router', 'warranty', 'flight'].flatMap(objective => [
      { objective, content: 'search result', mode: 'exclude' as const,
        sourceKind: 'web' as const, webAction: 'web_search' as const, onActiveBranch: false },
      { objective, content: 'opened page', mode: 'include' as const,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const, onActiveBranch: false },
    ])
    const empty = { exclude: [], include: [], archive: [] }
    const candidates = [
      { id: 'relevant', reason: 'off-path-candidate', active: false, included: false,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const, lexicalScore: 0.3 },
      { id: 'unrelated', reason: 'off-path-candidate', active: false, included: false,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const, lexicalScore: 0.2 },
    ]
    expect(personalContextStyleAdvice(edits, {
      sourceKind: 'web', webAction: 'web_fetch', onActiveBranch: false,
    })?.mode).toBe('include')
    expect(calibrateContextRecommendation(empty, 'a new task',
      { relevant: 'opened page about this task', unrelated: 'unrelated page' }, edits, candidates).include)
      .toEqual([{ nodeId: 'relevant',
        reason: 'Similar earlier reviewed Context choices favored including this material.' }])
  })

  it('ranks bounded personalized Includes by task relevance as well as preference', () => {
    const edits = ['one', 'two', 'three', 'four', 'five'].map(objective => ({
      objective, content: 'earlier observed page', mode: 'include' as const,
      sourceKind: 'web' as const, webAction: 'web_fetch' as const, onActiveBranch: false,
    }))
    const candidates = [
      { id: 'older', reason: 'off-path-candidate', active: false, included: false,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const, lexicalScore: 0.06 },
      { id: 'current', reason: 'off-path-candidate', active: false, included: false,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const, lexicalScore: 0.4 },
      { id: 'other', reason: 'off-path-candidate', active: false, included: false,
        sourceKind: 'web' as const, webAction: 'web_fetch' as const, lexicalScore: 0.08 },
    ]
    const result = calibrateContextRecommendation({ include: [], exclude: [], archive: [] },
      'current task', { older: 'earlier observed page', current: 'current task observed page',
        other: 'another observed page' }, edits, candidates)
    expect(result.include.map(item => item.nodeId)[0]).toBe('current')
  })

  it('recovers a Web action from an actual reviewed Session choice', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('reviewed-web-action'))
      const callId = CallId('reviewed-search')
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Compare the cited sources' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('assistant/message', { stream: [], turn: 1, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'web_search', arguments: '{}' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step: 1, callId,
        name: 'web_search', arguments: '{}' })
      const result = session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId,
          content: [{ type: 'text', text: 'Exploratory search results' }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('contextify/node-choice', {
        origin: 'direct', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
        mutations: [{ nodeId: `${session.id}:${String(result.seq)}`, mode: 'exclude' }],
      })
      const inspection = { meta: session.header, events: session.snapshotEvents(),
        inheritedEventCount: session.inheritedEventCount }
      const graph = projectSessionFamily({ activeSessionId: session.id, sessions: [inspection] })
      const edits = contextEditsFromFamily(graph, new Map([[session.id, inspection]]))
      expect(edits).toHaveLength(1)
      expect(edits[0]?.episodeId).toMatch(/^reviewed-web-action:\d+$/)
      expect(edits.map(({ episodeId: _episodeId, ...edit }) => edit))
        .toEqual([{ objective: 'Compare the cited sources', content: 'Exploratory search results',
          mode: 'exclude', sourceKind: 'web', speakerRole: 'tool',
          webAction: 'web_search', onActiveBranch: true }])
    } finally { await ctx.fiber.dispose() }
  })

  it('prunes active Web evidence and imports only source-bound off-path Web candidates', () => {
    const negative = Array.from({ length: 6 }, (_, index) => ({
      objective: `task ${String(index)}`, content: `page ${String(index)}`,
      mode: 'exclude' as const, sourceKind: 'web' as const, onActiveBranch: true,
    }))
    const empty = { exclude: [], include: [], archive: [] }
    const active = { id: 'active-web', reason: 'active-path', active: true,
      included: true, sourceKind: 'web' as const }
    expect(calibrateContextRecommendation(empty, 'new task',
      { 'active-web': 'new source' }, negative, [active]).exclude)
      .toEqual([{ nodeId: 'active-web',
        reason: 'Your earlier reviewed Context edits favored excluding this source type on the active branch.' }])
    const positive = negative.map(edit => ({ ...edit, mode: 'include' as const,
      onActiveBranch: false }))
    const offPath = { ...active, id: 'off-path-web', reason: 'off-path-candidate',
      active: false, included: false, lexicalScore: 1 }
    expect(calibrateContextRecommendation(empty, 'new task',
      { 'off-path-web': 'new source' }, positive, [offPath])).toEqual(empty)
    const sourceBound = { ...offPath, id: 'source-bound-web',
      webAction: 'web_fetch' as const, lexicalScore: 0.3 }
    const fetchEdits = positive.map(edit => ({ ...edit, webAction: 'web_fetch' as const }))
    expect(calibrateContextRecommendation(empty, 'new task',
      { 'source-bound-web': 'new source' }, fetchEdits, [sourceBound]).include)
      .toEqual([{ nodeId: 'source-bound-web',
        reason: 'Similar earlier reviewed Context choices favored including this material.' }])
  })

  it('filters a generic recommendation that opposes a matching direct edit', () => {
    const contents = { matching: 'vendor regional repair terms', unrelated: 'battery chemistry comparison' }
    const decision = {
      exclude: [{ nodeId: 'matching', reason: 'generic selection' },
        { nodeId: 'unrelated', reason: 'generic selection' }],
      include: [], archive: [],
    }
    const edits = [{ objective: 'warranty coverage comparison',
      content: contents.matching, mode: 'include' as const }]
    expect(calibrateContextRecommendation(decision, 'warranty coverage comparison', contents, edits))
      .toEqual({ ...decision, exclude: [{ nodeId: 'unrelated', reason: 'generic selection' }] })
    expect(calibrateContextRecommendation(decision, 'weather forecast', contents, edits))
      .toEqual(decision)
  })

  it('proposes a matching off-path Include from a direct edit, but leaves unrelated or explicit nodes alone', () => {
    const contents = {
      matching: 'vendor regional repair terms',
      unrelated: 'battery chemistry comparison',
      explicit: 'vendor regional repair terms',
    }
    const edits = [{ objective: 'compare warranty coverage',
      content: contents.matching, mode: 'include' as const, onActiveBranch: false }]
    const empty = { exclude: [], include: [], archive: [] }
    const candidates = [
      { id: 'matching', reason: 'off-path-candidate' as const, active: false, included: false },
      { id: 'unrelated', reason: 'off-path-candidate' as const, active: false, included: false },
      { id: 'explicit', reason: 'explicit-override' as const, active: false, included: false },
    ]
    expect(calibrateContextRecommendation(empty, 'compare warranty coverage', contents, edits, candidates))
      .toEqual({ ...empty, include: [{ nodeId: 'matching',
        reason: 'Similar earlier reviewed Context choices favored including this material.' }] })
    expect(calibrateContextRecommendation(empty, 'weather forecast', contents, edits, candidates))
      .toEqual(empty)
  })

  it('generalizes repeated off-path Include style with shrinkage and keeps conflicting edits conservative', () => {
    const goals = ['warranty coverage', 'battery comparison', 'hotel cancellation',
      'router security', 'camera purchase', 'research evidence']
    const edits = goals.map((objective, index) => ({
      objective, content: `old source ${String(index)}`, mode: 'include' as const,
      onActiveBranch: false,
    }))
    const one = personalContextCandidateBonus('new unrelated request', 'different old material', edits.slice(0, 1), false)
    const three = personalContextCandidateBonus('new unrelated request', 'different old material', edits.slice(0, 3), false)
    const six = personalContextCandidateBonus('new unrelated request', 'different old material', edits, false)
    expect(one).toBe(0)
    expect(three).toBe(0)
    expect(six).toBeGreaterThan(0.08)
    const opposed = edits.map((edit, index) => ({ ...edit,
      mode: index % 2 === 0 ? 'include' as const : 'exclude' as const }))
    expect(Math.abs(personalContextCandidateBonus('new unrelated request', 'different old material', opposed, false)))
      .toBeLessThan(0.06)
    const empty = { exclude: [], include: [], archive: [] }
    const candidate = { id: 'old', reason: 'off-path-candidate', active: false, included: false }
    expect(calibrateContextRecommendation(empty, 'new unrelated request',
      { old: 'different old material' }, edits, [candidate])).toEqual(empty)
    expect(calibrateContextRecommendation(empty, 'new unrelated request',
      { old: 'different old material' }, edits, [{ ...candidate, lexicalScore: 0.2 }]).include)
      .toHaveLength(1)
  })

  it('recognizes four direct cross-topic Include corrections as an off-path organization rule', () => {
    const edits = ['camera', 'hotel', 'warranty', 'router'].map((topic, index) => ({
      objective: `compare ${topic}`, content: `older result ${String(index)}`,
      mode: 'include' as const, onActiveBranch: false,
    }))
    const candidate = { id: 'prior', reason: 'off-path-candidate', active: false,
      included: false, lexicalScore: 0.1 }
    const base = { exclude: [{ nodeId: 'prior', reason: 'generic' }], include: [], archive: [] }
    const result = calibrateContextRecommendation(base, 'find a different product',
      { prior: 'another old result' }, edits, [candidate])
    expect(result.exclude).toEqual([])
    expect(result.include).toHaveLength(1)
    expect(calibrateContextRecommendation(base, 'find a different product',
      { prior: 'another old result' }, edits.slice(0, 3), [candidate])).toEqual(base)
  })

  it('does not count every node in one accepted batch as a separate style observation', () => {
    const batch = Array.from({ length: 2 }, (_, index) => ({
      objective: `different earlier task ${String(index)}`,
      content: `different earlier result ${String(index)}`,
      mode: 'include' as const, onActiveBranch: false, weight: 0.5,
    }))
    expect(personalContextCandidateBonus('new unrelated request', 'new unrelated result',
      [...batch, ...batch, ...batch], false)).toBe(0)
    expect(personalContextCandidateBonus('new unrelated request', 'new unrelated result',
      [...batch, ...batch, ...batch, ...batch], false)).toBeGreaterThan(0)
  })

  it('transfers a Chinese direct Include to a similar later goal', () => {
    const first = {
      objective: '比较相机的续航', content: '相机续航网页测评', mode: 'include',
      onActiveBranch: false,
    } as const
    const objective = '继续比较相机续航'
    const candidate = '相机续航测评网页'
    expect(personalContextCandidateBonus(objective, candidate, [first], false)).toBeGreaterThan(0)
    expect(personalContextCandidateBonus(objective, candidate, [
      first,
      { ...first, objective: '相机续航比较', content: '相机电池续航测评' },
      { ...first, objective: '比较两台相机续航', content: '相机续航实测报告' },
      { ...first, objective: '比较相机续航', content: '相机续航测评结果' },
    ], false)).toBeGreaterThan(0.08)
  })

  it('passes a personal Include through graph validation without overriding an explicit Exclude', () => {
    const rootId = SessionId('personal-root')
    const siblingId = SessionId('personal-sibling')
    const graph: ContextFamilyGraph = {
      rootSessionId: rootId, activeSessionId: rootId,
      sessions: [
        { id: rootId, seedLength: 0, depth: 0, tipNodeId: null },
        { id: siblingId, parentSessionId: rootId, seedLength: 0, depth: 1, tipNodeId: 'source' },
      ],
      nodes: [{ id: 'source', owner: { sessionId: siblingId, seq: 0 }, role: 'assistant',
        preview: 'vendor regional repair terms', time: 0, branchAtSeq: null,
        sessionIds: [siblingId], activeEventSeq: null }],
      edges: [],
    }
    const decision = calibrateContextRecommendation({ exclude: [], include: [], archive: [] },
      'compare warranty coverage', { source: 'vendor regional repair terms' },
      [{ objective: 'compare warranty coverage', content: 'vendor regional repair terms',
        mode: 'include', onActiveBranch: false }],
      [{ id: 'source', reason: 'off-path-candidate', active: false, included: false }])
    const validation = {
      mode: 'fast' as const,
      base: { planRevision: 0, graphRevision: 'g', activeSessionId: rootId },
      graph, effectiveIncludedNodeIds: [], explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
    }
    expect(validateRecommendation(decision, validation).addedNodeIds).toEqual(['source'])
    expect(validateRecommendation(decision, { ...validation,
      explicitExcludedNodeIds: ['source'] }).addedNodeIds).toEqual([])
  })

  it('uses changed direct Client edits once across inherited Session prefixes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('context-policy-root'))
      root.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'compare warranty coverage' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      root.append('contextify/node-choice', {
        origin: 'direct', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
        mutations: [{ nodeId: 'repair-node', mode: 'include' }],
      })
      root.append('contextify/node-choice', {
        origin: 'recommendation', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 2, afterPlanRevision: 3, graphRevision: 'g',
        mutations: [{ nodeId: 'other-node', mode: 'exclude' }],
      })
      root.append('contextify/node-choice', {
        origin: 'direct', changed: true,
        beforePlanRevision: 3, afterPlanRevision: 4, graphRevision: 'g',
        mutations: [{ nodeId: 'other-node', mode: 'exclude' }],
      })
      const events = root.snapshotEvents()
      const childId = SessionId('context-policy-child')
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: root.id,
        sessions: [
          { id: root.id, seedLength: 0, depth: 0, tipNodeId: null },
          { id: childId, parentSessionId: root.id, seedLength: events.length, depth: 1, tipNodeId: null },
        ],
        nodes: [{ id: 'repair-node', owner: { sessionId: root.id, seq: 0 }, role: 'user',
          preview: 'vendor regional repair terms', time: 0, branchAtSeq: null,
          sessionIds: [root.id, childId], activeEventSeq: 0 }],
        edges: [],
      }
      const inspections = new Map<SessionId, ContextFamilyInspection>([
        [root.id, { meta: root.header, events, inheritedEventCount: 0 }],
        [childId, { meta: { ...root.header, id: childId, parentSession: root.id },
          events, inheritedEventCount: events.length }],
      ])
      const edits = contextEditsFromFamily(graph, inspections)
      expect(edits).toHaveLength(1)
      expect(edits[0]?.episodeId).toMatch(/^context-policy-root:\d+$/)
      expect(edits.map(({ episodeId: _episodeId, ...edit }) => edit))
        .toEqual([{ objective: 'compare warranty coverage',
          content: 'vendor regional repair terms', mode: 'include',
          speakerRole: 'user', onActiveBranch: true }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('learns from an accepted reviewed selection and gives one batch one total observation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('context-reviewed-root'))
      root.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'compare regional warranty coverage' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      root.append('contextify/node-choice', {
        origin: 'recommendation', changed: false, uiOrigin: 'contextify-client',
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
        mutations: [{ nodeId: 'repair-node', mode: 'natural' },
          { nodeId: 'battery-node', mode: 'exclude' }],
        proposal: { currentNodeIds: [], proposedNodeIds: ['repair-node'],
          selection: [{ nodeId: 'repair-node', action: 'include' },
            { nodeId: 'battery-node', action: 'exclude' }] },
      })
      root.append('contextify/node-choice', {
        origin: 'recommendation', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 2, afterPlanRevision: 3, graphRevision: 'g',
        mutations: [{ nodeId: 'repair-node', mode: 'include' }],
      })
      const events = root.snapshotEvents()
      const childId = SessionId('context-reviewed-child')
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: root.id,
        sessions: [{ id: root.id, seedLength: 0, depth: 0, tipNodeId: null },
          { id: childId, parentSessionId: root.id, seedLength: events.length,
            depth: 1, tipNodeId: null }],
        nodes: [
          { id: 'repair-node', owner: { sessionId: root.id, seq: 0 }, role: 'assistant',
            preview: 'regional repair terms', time: 0, branchAtSeq: null,
            sessionIds: [root.id, childId], activeEventSeq: 0 },
          { id: 'battery-node', owner: { sessionId: root.id, seq: 1 }, role: 'assistant',
            preview: 'battery chemistry', time: 1, branchAtSeq: null,
            sessionIds: [root.id, childId], activeEventSeq: 1 },
        ], edges: [],
      }
      const inspections = new Map<SessionId, ContextFamilyInspection>([
        [root.id, { meta: root.header, events, inheritedEventCount: 0 }],
        [childId, { meta: { ...root.header, id: childId, parentSession: root.id },
          events, inheritedEventCount: events.length }],
      ])
      const edits = contextEditsFromFamily(graph, inspections)
      expect(new Set(edits.map(edit => edit.episodeId)).size).toBe(1)
      expect(edits[0]?.episodeId).toMatch(/^context-reviewed-root:\d+$/)
      expect(edits.map(({ episodeId: _episodeId, ...edit }) => edit)).toEqual([
        { objective: 'compare regional warranty coverage', content: 'regional repair terms',
          mode: 'include', speakerRole: 'assistant', onActiveBranch: true, weight: 0.5 },
        { objective: 'compare regional warranty coverage', content: 'battery chemistry',
          mode: 'exclude', speakerRole: 'assistant', onActiveBranch: true, weight: 0.5 },
      ])
      expect(personalContextCandidateBonus('compare regional warranty coverage',
        'regional repair terms', edits)).toBeGreaterThan(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not turn Keep current on a proposed Include into a confirmed Exclude edit', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('context-declined-include-root'))
      root.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'compare regional warranty coverage' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      root.append('contextify/node-choice', {
        origin: 'recommendation', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
        mutations: [{ nodeId: 'repair-node', mode: 'include' }],
        proposal: { currentNodeIds: [], proposedNodeIds: ['repair-node', 'offer-node'],
          selection: [{ nodeId: 'repair-node', action: 'include' },
            { nodeId: 'offer-node', action: 'include' }] },
      })
      root.append('contextify/recommendation-reviewed', {
        mode: 'fast', base: { activeSessionId: root.id, planRevision: 1, graphRevision: 'g' },
        objective: 'compare regional warranty coverage',
        selection: [{ nodeId: 'repair-node', action: 'include' },
          { nodeId: 'offer-node', action: 'include' }],
        acceptedNodeIds: ['repair-node'], declinedNodeIds: ['offer-node'],
        uiOrigin: 'contextify-client',
      })
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: root.id,
        sessions: [{ id: root.id, seedLength: 0, depth: 0, tipNodeId: null }],
        nodes: [
          { id: 'repair-node', owner: { sessionId: root.id, seq: 0 }, role: 'assistant',
            preview: 'regional repair terms', time: 0, branchAtSeq: null,
            sessionIds: [root.id], activeEventSeq: 0 },
          { id: 'offer-node', owner: { sessionId: root.id, seq: 1 }, role: 'assistant',
            preview: 'optional offer', time: 1, branchAtSeq: null,
            sessionIds: [root.id], activeEventSeq: 1 },
        ], edges: [],
      }
      const inspections = new Map<SessionId, ContextFamilyInspection>([
        [root.id, { meta: root.header, events: root.snapshotEvents(), inheritedEventCount: 0 }],
      ])
      const evidence = contextEditEvidenceFromFamily(graph, inspections)
      expect(evidence[0]?.edit.episodeId).toMatch(/^context-declined-include-root:\d+$/)
      expect(evidence.map((item) => {
        const { episodeId: _episodeId, ...edit } = item.edit
        return edit
      })).toEqual([{
        objective: 'compare regional warranty coverage', content: 'regional repair terms',
        mode: 'include', speakerRole: 'assistant', onActiveBranch: true, weight: 0.5,
      }])
      expect(contextPolicyObservationsFromFamily(graph, inspections).map(item => item.choice))
        .toEqual(['accept', 'reject'])
      const inspection = inspections.get(root.id)
      expect([...declinedContextActionsForObjective(inspection,
        'compare regional warranty coverage')]).toEqual(['include:offer-node'])
      expect([...declinedContextActionsForObjective(inspection,
        'compare a different purchase')]).toEqual([])
      root.append('contextify/recommendation-reviewed', {
        mode: 'fast', base: { activeSessionId: root.id, planRevision: 2, graphRevision: 'g2' },
        objective: 'compare regional warranty coverage',
        selection: [{ nodeId: 'offer-node', action: 'include' }],
        acceptedNodeIds: ['offer-node'], declinedNodeIds: [],
        uiOrigin: 'contextify-client',
      })
      expect([...declinedContextActionsForObjective({ meta: root.header,
        events: root.snapshotEvents(), inheritedEventCount: 0 },
      'compare regional warranty coverage')]).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('remembers dismissed item declines for the same objective without inventing style edits', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('context-dismissed-repeat'))
      const objective = 'Write the introduction'
      const base = { activeSessionId: root.id, planRevision: 1, graphRevision: 'g' }
      const data = { mode: 'fast' as const, base, objective,
        selection: [{ nodeId: 'page', action: 'include' as const },
          { nodeId: 'chat', action: 'exclude' as const }], archiveNodeIds: [] }
      root.append('contextify/recommendation-dismissed', {
        ...data, declinedNodeIds: ['page'], uiOrigin: 'contextify-client',
      })
      root.append('contextify/recommendation-dismissed', { ...data, uiOrigin: 'contextify-client' })
      const inspection = () => ({ meta: root.header, events: root.snapshotEvents(), inheritedEventCount: 0 })
      expect([...declinedContextActionsForObjective(inspection(), ' write  THE introduction ')])
        .toEqual(['include:page'])
      expect([...declinedContextActionsForObjective(inspection(), 'Plan a different task')]).toEqual([])
      const graph: ContextFamilyGraph = { rootSessionId: root.id, activeSessionId: root.id,
        sessions: [{ id: root.id, depth: 0, seedLength: 0, tipNodeId: null }], nodes: [], edges: [] }
      expect(contextEditEvidenceFromFamily(graph, new Map([[root.id, inspection()]]))).toEqual([])
      root.append('contextify/recommendation-reviewed', {
        mode: 'fast', base, objective, selection: [{ nodeId: 'page', action: 'include' }],
        acceptedNodeIds: ['page'], declinedNodeIds: [], uiOrigin: 'contextify-client',
      })
      expect([...declinedContextActionsForObjective(inspection(), objective)]).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('extracts an accepted two-node Context delta once, not a no-op or partial batch', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('context-plan-example-root'))
      root.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'continue the camera on the new budget' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const selection = [
        { nodeId: 'old-budget', action: 'exclude' as const },
        { nodeId: 'new-budget', action: 'include' as const },
      ]
      const mutations = [
        { nodeId: 'old-budget', mode: 'exclude' as const },
        { nodeId: 'new-budget', mode: 'natural' as const },
      ]
      for (const changed of [false, true]) root.append('contextify/node-choice', {
        origin: 'recommendation', changed, uiOrigin: 'contextify-client',
        beforePlanRevision: changed ? 2 : 1, afterPlanRevision: changed ? 3 : 2,
        graphRevision: 'g', mutations,
        proposal: { currentNodeIds: ['old-budget'],
          proposedNodeIds: ['new-budget'], selection },
      })
      root.append('contextify/recommendation-reviewed', {
        mode: 'fast', base: { activeSessionId: root.id, planRevision: 2, graphRevision: 'g' },
        objective: 'Draft the new camera plan', selection,
        acceptedNodeIds: selection.map(item => item.nodeId), declinedNodeIds: [],
        uiOrigin: 'contextify-client',
      })
      root.append('contextify/node-choice', {
        origin: 'recommendation', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 3, afterPlanRevision: 4, graphRevision: 'g',
        mutations: [{ nodeId: 'old-budget', mode: 'exclude' },
          { nodeId: 'new-budget', mode: 'natural' }],
        proposal: { currentNodeIds: ['old-budget'], proposedNodeIds: ['new-budget'],
          selection: [{ nodeId: 'old-budget', action: 'exclude' },
            { nodeId: 'missing-node', action: 'include' }] },
      })
      root.append('contextify/node-choice', {
        origin: 'recommendation', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 4, afterPlanRevision: 5, graphRevision: 'g', mutations,
        proposal: { currentNodeIds: ['old-budget', 'new-budget'],
          proposedNodeIds: ['new-budget'], selection },
      })
      const events = root.snapshotEvents()
      const childId = SessionId('context-plan-example-child')
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: root.id,
        sessions: [{ id: root.id, seedLength: 0, depth: 0, tipNodeId: null },
          { id: childId, parentSessionId: root.id, seedLength: events.length,
            depth: 1, tipNodeId: null }],
        nodes: [
          { id: 'old-budget', owner: { sessionId: root.id, seq: 0 }, role: 'user',
            preview: 'the old camera budget is 600', time: 0, branchAtSeq: null,
            sessionIds: [root.id, childId], activeEventSeq: 0 },
          { id: 'new-budget', owner: { sessionId: root.id, seq: 1 }, role: 'user',
            preview: 'the new camera budget is 900', time: 1, branchAtSeq: null,
            sessionIds: [root.id, childId], activeEventSeq: 1 },
        ], edges: [],
      }
      const inspections = new Map<SessionId, ContextFamilyInspection>([
        [root.id, { meta: root.header, events, inheritedEventCount: 0 }],
        [childId, { meta: { ...root.header, id: childId, parentSession: root.id },
          events, inheritedEventCount: events.length }],
      ])
      expect(contextPlanExamplesFromFamily(graph, inspections)).toEqual([{
        sourceSessionId: root.id, sourceEventSeq: 2, at: events[2]!.time,
        objective: 'Draft the new camera plan',
        choices: [
          { content: 'the old camera budget is 600', action: 'exclude',
            beforeIncluded: true, afterIncluded: false, speakerRole: 'user', onActiveBranch: true },
          { content: 'the new camera budget is 900', action: 'include',
            beforeIncluded: false, afterIncluded: true, speakerRole: 'user', onActiveBranch: true },
        ],
      }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('orders direct Context cases by event time rather than Session map order', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('context-case-root'))
      const child = ctx.sessions.create(SessionId('context-case-child'))
      root.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'compare warranty coverage' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      root.append('contextify/node-choice', {
        origin: 'direct', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
        mutations: [{ nodeId: 'repair-node', mode: 'include' }],
      })
      child.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'compare battery life' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      child.append('contextify/node-choice', {
        origin: 'direct', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
        mutations: [{ nodeId: 'battery-node', mode: 'exclude' }],
      })
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: child.id,
        sessions: [{ id: root.id, seedLength: 0, depth: 0, tipNodeId: null },
          { id: child.id, parentSessionId: root.id, seedLength: 0, depth: 1, tipNodeId: null }],
        nodes: [
          { id: 'repair-node', owner: { sessionId: root.id, seq: 0 }, role: 'user',
            preview: 'regional repair terms', time: 0, branchAtSeq: null,
            sessionIds: [root.id], activeEventSeq: 0 },
          { id: 'battery-node', owner: { sessionId: child.id, seq: 0 }, role: 'user',
            preview: 'battery comparison', time: 1, branchAtSeq: null,
            sessionIds: [child.id], activeEventSeq: 0 },
        ], edges: [],
      }
      const inspections = new Map<SessionId, ContextFamilyInspection>([
        [child.id, { meta: { ...child.header, parentSession: root.id },
          events: child.snapshotEvents().map(event => ({ ...event, time: event.time + 1000 })),
          inheritedEventCount: 0 }],
        [root.id, { meta: root.header, events: root.snapshotEvents(), inheritedEventCount: 0 }],
      ])
      expect(contextEditsFromFamily(graph, inspections).map(edit => edit.mode))
        .toEqual(['include', 'exclude'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextFamilyGraph, ContextFamilyGraphNode } from '../src/types.ts'
import {
  buildFastRecommendationInput,
  FAST_RECOMMENDATION_DISTANT_ACTIVE_LIMIT,
  FAST_RECOMMENDATION_EXAMPLE_CHARS,
  FAST_RECOMMENDATION_MAX_NODES,
  FAST_RECOMMENDATION_OFF_PATH_LIMIT,
  FAST_RECOMMENDATION_OFF_PATH_WEB_FLOOR,
  FAST_RECOMMENDATION_PLAN_EXAMPLES,
  FAST_RECOMMENDATION_PREFERENCE_EXAMPLES,
} from '../src/fast-recommendation.ts'

const root = 'fast-root' as SessionId
const active = 'fast-active' as SessionId
const sibling = 'fast-sibling' as SessionId

function node(
  id: string,
  role: 'user' | 'assistant',
  preview: string,
  sessionIds: readonly SessionId[],
  time: number,
): ContextFamilyGraphNode {
  return {
    id,
    owner: { sessionId: sessionIds.at(-1)!, seq: time },
    role,
    preview,
    time,
    branchAtSeq: time + 1,
    sessionIds,
    activeEventSeq: sessionIds.includes(active) ? time : null,
  }
}

function fixture(extraOffPath = 0): ContextFamilyGraph {
  const nodes = [
    node('n1', 'user', 'root product objective', [root, active, sibling], 1),
    node('n2', 'assistant', 'shared architecture answer', [root, active, sibling], 2),
    node('n3', 'user', 'active turn one', [active], 3),
    node('n4', 'assistant', 'active answer one', [active], 4),
    node('n5', 'user', 'active turn two', [active], 5),
    node('n6', 'assistant', 'active answer two', [active], 6),
    node('n7', 'user', 'observability tracing comparison', [sibling], 7),
    node('n8', 'assistant', 'compare trace sampling designs', [sibling], 8),
    node('n9', 'user', 'explicitly blocked unrelated finance note', [sibling], 9),
    ...Array.from({ length: extraOffPath }, (_, index) => node(
      `bulk-${String(index)}`,
      index % 2 === 0 ? 'user' : 'assistant',
      `unrelated branch material ${String(index)}`,
      [sibling],
      10 + index,
    )),
  ]
  const edges = [
    { id: 'e1', source: 'n1', target: 'n2', sessionIds: [root, active, sibling] },
    { id: 'e2', source: 'n2', target: 'n3', sessionIds: [active] },
    { id: 'e3', source: 'n3', target: 'n4', sessionIds: [active] },
    { id: 'e4', source: 'n4', target: 'n5', sessionIds: [active] },
    { id: 'e5', source: 'n5', target: 'n6', sessionIds: [active] },
    { id: 'e6', source: 'n2', target: 'n7', sessionIds: [sibling] },
    { id: 'e7', source: 'n7', target: 'n8', sessionIds: [sibling] },
    { id: 'e8', source: 'n8', target: 'n9', sessionIds: [sibling] },
    ...Array.from({ length: extraOffPath }, (_, index) => ({
      id: `bulk-edge-${String(index)}`,
      source: index === 0 ? 'n9' : `bulk-${String(index - 1)}`,
      target: `bulk-${String(index)}`,
      sessionIds: [sibling],
    })),
  ]
  return {
    rootSessionId: root,
    activeSessionId: active,
    sessions: [
      { id: root, seedLength: 0, depth: 0, tipNodeId: 'n2' },
      { id: active, parentSessionId: root, seedLength: 2, depth: 1, tipNodeId: 'n6' },
      { id: sibling, parentSessionId: root, seedLength: 2, depth: 1, tipNodeId: nodes.at(-1)!.id },
    ],
    nodes,
    edges,
  }
}

describe('Fast Context recommendation routing', () => {
  it('routes source-bound off-path Web evidence but not unbound Web results', () => {
    const base = fixture()
    const web = { ...node('sibling-web', 'assistant', 'publisher policy page', [sibling], 10),
      role: 'tool' as const, sourceKind: 'web' as const, webAction: 'web_fetch' as const }
    const unbound: ContextFamilyGraphNode = { ...node('sibling-unbound', 'assistant',
      'publisher policy page', [sibling], 11), role: 'tool', sourceKind: 'web' }
    const graph = { ...base, nodes: [...base.nodes, web, unbound] }
    const input = buildFastRecommendationInput({ graph,
      contents: {}, objective: 'publisher policy page',
      effectiveIncludedNodeIds: base.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] })
    expect(input.nodes.find(item => item.id === web.id)).toMatchObject({
      reason: 'off-path-candidate', sourceKind: 'web', webAction: 'web_fetch',
    })
    expect(input.nodes.some(item => item.id === unbound.id)).toBe(false)
  })

  it('keeps a bounded Web source slate when similar old chat turns fill the off-path budget', () => {
    const base = fixture(60)
    const web = Array.from({ length: 6 }, (_, index) => ({
      ...node(`old-web-${String(index)}`, 'assistant', `archived source ${String(index)}`,
        [sibling], 100 + index),
      role: 'tool' as const, sourceKind: 'web' as const, webAction: 'web_fetch' as const,
    }))
    const graph = { ...base, nodes: [...base.nodes, ...web] }
    const input = buildFastRecommendationInput({
      graph, contents: {}, objective: 'unrelated branch material',
      effectiveIncludedNodeIds: base.nodes.filter(item => item.sessionIds.includes(active))
        .map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
    })
    const offPath = input.nodes.filter(item => item.reason === 'off-path-candidate')
    expect(offPath).toHaveLength(FAST_RECOMMENDATION_OFF_PATH_LIMIT)
    expect(offPath.filter(item => item.sourceKind === 'web'))
      .toHaveLength(FAST_RECOMMENDATION_OFF_PATH_WEB_FLOOR)
    expect(offPath.some(item => item.sourceKind !== 'web')).toBe(true)
  })

  it('keeps recent active context, branch pivots, explicit overrides, and relevant off-path nodes', () => {
    const graph = fixture()
    const input = buildFastRecommendationInput({
      graph,
      contents: Object.fromEntries(graph.nodes.map(item => [item.id, `full ${item.preview}`])),
      objective: 'compare observability tracing approaches',
      effectiveIncludedNodeIds: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'],
      explicitIncludedNodeIds: [],
      explicitExcludedNodeIds: ['n9'],
    })

    expect(input.nodes.filter(item => item.reason === 'recent-active').map(item => item.id))
      .toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'])
    expect(input.nodes.find(item => item.id === 'n2')?.reason).toBe('recent-active')
    expect(input.nodes.find(item => item.id === 'n9')?.reason).toBe('explicit-override')
    expect(input.nodes.find(item => item.id === 'n7')).toMatchObject({
      reason: 'off-path-candidate',
      included: false,
      active: false,
    })
    expect(input.nodes.map(item => item.id)).toEqual(graph.nodes
      .filter(item => input.nodes.some(candidate => candidate.id === item.id))
      .map(item => item.id))
  })

  it('enforces the total and off-path candidate bounds deterministically', () => {
    const graph = fixture(60)
    const first = buildFastRecommendationInput({
      graph,
      contents: {},
      objective: 'unrelated branch material',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [],
      explicitExcludedNodeIds: [],
    })
    const second = buildFastRecommendationInput({
      graph,
      contents: {},
      objective: 'unrelated branch material',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [],
      explicitExcludedNodeIds: [],
    })

    expect(first.nodes.length).toBeLessThanOrEqual(FAST_RECOMMENDATION_MAX_NODES)
    expect(first.nodes.filter(item => item.reason === 'off-path-candidate').length)
      .toBeLessThanOrEqual(FAST_RECOMMENDATION_OFF_PATH_LIMIT)
    expect(first).toEqual(second)
  })

  it('keeps a competitive source from another sibling when one branch fills the ranking', () => {
    const graph = fixture()
    const other = 'fast-other' as SessionId
    const repetitive = Array.from({ length: 16 }, (_, index) => node(
      `camera-${String(index)}`, 'assistant', 'camera battery comparison', [sibling], 20 + index,
    ))
    const alternative = node('other-warranty', 'assistant',
      'camera battery regional warranty', [other], 40)
    const expanded: ContextFamilyGraph = {
      ...graph,
      sessions: [...graph.sessions,
        { id: other, parentSessionId: root, seedLength: 2, depth: 1, tipNodeId: alternative.id }],
      nodes: [...graph.nodes, ...repetitive, alternative],
      edges: [...graph.edges,
        { id: 'other-edge', source: 'n2', target: alternative.id, sessionIds: [other] }],
    }
    const input = buildFastRecommendationInput({
      graph: expanded, contents: {}, objective: 'camera battery comparison',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active))
        .map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
    })
    expect(input.nodes.find(item => item.id === alternative.id)?.reason)
      .toBe('off-path-candidate')
    expect(input.nodes.filter(item => item.reason === 'off-path-candidate'))
      .toHaveLength(FAST_RECOMMENDATION_OFF_PATH_LIMIT)
  })

  it('recovers a related off-path node from a prior direct Include preference', () => {
    const graph = fixture(60)
    const contents = { 'bulk-59': 'vendor regional repair terms' }
    const request = {
      graph, contents, objective: 'warranty coverage comparison',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
    }
    expect(buildFastRecommendationInput(request).nodes.map(item => item.id)).not.toContain('bulk-59')
    expect(buildFastRecommendationInput({
      ...request,
      preferenceEdits: [{
        objective: 'warranty coverage comparison',
        content: 'vendor regional repair terms',
        mode: 'include' as const,
      }],
    }).nodes.map(item => item.id)).toContain('bulk-59')
  })

  it('scores a Chinese off-path source against a Chinese objective', () => {
    const base = fixture(20)
    const graph = { ...base, nodes: base.nodes.map(item => item.id === 'n7'
      ? { ...item, preview: '相机续航测评网页' }
      : item) }
    const input = buildFastRecommendationInput({
      graph, contents: {}, objective: '继续比较相机续航',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
    })
    expect(input.nodes.find(item => item.id === 'n7')?.lexicalScore).toBeGreaterThan(0.1)
  })

  it('surfaces an old active-path constraint during a long conversation without dropping recent turns', () => {
    const base = fixture(20)
    const activeNodes = Array.from({ length: 40 }, (_, index) => node(
      `long-${String(index)}`, index % 2 === 0 ? 'user' : 'assistant',
      index === 2 ? 'old laptop screen must be 17 inches'
        : index === 30 ? 'corrected laptop screen is 13 inches'
          : `unrelated conversation step ${String(index)}`,
      [active], 100 + index,
    ))
    const graph = { ...base, nodes: [...base.nodes, ...activeNodes] }
    const input = buildFastRecommendationInput({ graph, contents: {},
      objective: 'use the corrected laptop screen size',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
    })
    expect(input.nodes.find(item => item.id === 'long-2')?.reason).toBe('distant-active-candidate')
    expect(input.nodes.find(item => item.id === 'long-30')?.reason).toBe('distant-active-candidate')
    expect(input.nodes.some(item => item.id === 'long-39' && item.reason === 'recent-active')).toBe(true)
    expect(input.nodes.filter(item => item.reason === 'distant-active-candidate').length)
      .toBeLessThanOrEqual(FAST_RECOMMENDATION_DISTANT_ACTIVE_LIMIT)
    expect(input.nodes.length).toBeLessThanOrEqual(FAST_RECOMMENDATION_MAX_NODES)
    expect(input.nodes.filter(item => item.reason === 'off-path-candidate').length)
      .toBe(FAST_RECOMMENDATION_OFF_PATH_LIMIT)
  })

  it('recalls a lexically different old active-path source from a confirmed personal choice', () => {
    const base = fixture(20)
    const old = node('old-repair', 'user', 'vendor repair terms', [active], 70)
    const filler = Array.from({ length: 30 }, (_, index) => node(
      `later-${String(index)}`, index % 2 === 0 ? 'user' : 'assistant',
      `unrelated design step ${String(index)}`, [active], 100 + index,
    ))
    const graph = { ...base, nodes: [...base.nodes, old, ...filler] }
    const request = {
      graph, contents: {}, objective: 'regional warranty comparison',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active))
        .map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
    }
    expect(buildFastRecommendationInput(request).nodes.map(item => item.id)).not.toContain(old.id)
    const personalized = buildFastRecommendationInput({ ...request,
      rankingEdits: [{ objective: 'regional warranty comparison', content: 'vendor repair terms',
        mode: 'include' as const, sourceKind: 'chat' as const, onActiveBranch: true }],
    })
    expect(personalized.nodes.find(item => item.id === old.id)?.reason)
      .toBe('distant-active-candidate')
    expect(personalized.nodes.length).toBeLessThanOrEqual(FAST_RECOMMENDATION_MAX_NODES)
  })

  it('keeps a small active branch entry visible on return even when the new objective has no shared words', () => {
    const base = fixture(20)
    const oldBranch = Array.from({ length: 18 }, (_, index) => node(
      `return-${String(index)}`, index % 2 === 0 ? 'user' : 'assistant',
      index === 2 ? 'old still-open book description' : `historic episode ${String(index)}`,
      [active], 100 + index,
    ))
    const graph = { ...base,
      nodes: [...base.nodes.filter(item => !['n3', 'n4', 'n5', 'n6'].includes(item.id)), ...oldBranch],
      edges: [...base.edges.filter(item => !['e2', 'e3', 'e4', 'e5'].includes(item.id)),
        { id: 'return-start', source: 'n2', target: 'return-0', sessionIds: [active] },
        ...oldBranch.slice(1).map((item, index) => ({ id: `return-${String(index)}`,
          source: oldBranch[index]!.id, target: item.id, sessionIds: [active] }))],
    }
    const input = buildFastRecommendationInput({ graph, contents: {},
      objective: 'complete checkout',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] })
    expect(input.nodes.find(item => item.id === 'return-2')?.reason).toBe('branch-entry')
    expect(input.nodes.find(item => item.id === 'return-17')?.reason).toBe('recent-active')
    expect(input.nodes.length).toBeLessThanOrEqual(FAST_RECOMMENDATION_MAX_NODES)
    expect(input.nodes.filter(item => item.reason === 'off-path-candidate').length)
      .toBe(FAST_RECOMMENDATION_OFF_PATH_LIMIT)
  })

  it('shows a bounded mix of relevant and recent confirmed choices', () => {
    const graph = fixture()
    const edits = [
      { objective: 'laptop screen choice', content: 'old screen 17 inches',
        mode: 'exclude' as const, sourceKind: 'chat' as const, onActiveBranch: true },
      { objective: 'unrelated camera lens', content: 'lens data', mode: 'include' as const },
      { objective: 'laptop screen update', content: 'x'.repeat(300),
        mode: 'exclude' as const, speakerRole: 'assistant' as const },
      { objective: 'batch laptop screen', content: 'batch data', mode: 'exclude' as const, weight: 0.5 },
      { objective: 'unrelated hotel', content: 'hotel data', mode: 'include' as const },
      { objective: 'unrelated train', content: 'train data', mode: 'exclude' as const },
    ]
    const input = buildFastRecommendationInput({ graph, contents: {},
      objective: 'laptop screen',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [], preferenceEdits: edits })
    expect(input.preferenceExamples).toHaveLength(FAST_RECOMMENDATION_PREFERENCE_EXAMPLES)
    expect(input.preferenceExamples.map(item => item.objective)).toEqual([
      'laptop screen update', 'batch laptop screen', 'unrelated hotel', 'unrelated train',
    ])
    expect(input.preferenceExamples[0]?.content).toHaveLength(FAST_RECOMMENDATION_EXAMPLE_CHARS)
    expect(input.preferenceExamples[0]?.speakerRole).toBe('assistant')
    expect(input.preferenceExamples[1]?.weight).toBe(0.5)
  })

  it('carries known historical ownership without inventing it for legacy examples', () => {
    const graph = fixture()
    const edits = [
      { objective: 'camera', content: 'shared constraint', mode: 'include' as const,
        onActiveBranch: true, ownerRelation: 'ancestor-task' as const },
      { objective: 'camera', content: 'legacy example', mode: 'exclude' as const },
    ]
    const input = buildFastRecommendationInput({ graph, contents: {}, objective: 'camera',
      effectiveIncludedNodeIds: [], explicitIncludedNodeIds: [], explicitExcludedNodeIds: [], preferenceEdits: edits })
    expect(input.preferenceExamples).toEqual(edits)
  })

  it('preserves fractional review weight when a confirmed multi-item choice enters the packet', () => {
    const graph = fixture()
    const input = buildFastRecommendationInput({ graph, contents: {},
      objective: 'laptop screen',
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
      preferenceEdits: [{ objective: 'laptop screen', content: 'keep the current screen requirement',
        mode: 'include', weight: 0.5 }],
    })
    expect(input.preferenceExamples).toEqual([{ objective: 'laptop screen',
      content: 'keep the current screen requirement', mode: 'include', weight: 0.5 }])
  })

  it('keeps a confirmed multi-node decision together as one bounded plan example', () => {
    const graph = fixture()
    const planExamples = [
      { objective: 'camera budget revision', choices: [
        { content: 'old budget', action: 'exclude' as const,
          beforeIncluded: true, afterIncluded: false, onActiveBranch: true },
        { content: 'new budget', action: 'include' as const,
          beforeIncluded: false, afterIncluded: true, onActiveBranch: true },
      ] },
      { objective: 'unrelated hotel booking', choices: [
        { content: 'hotel room', action: 'include' as const,
          beforeIncluded: false, afterIncluded: true, onActiveBranch: false },
        { content: 'old hotel', action: 'exclude' as const,
          beforeIncluded: true, afterIncluded: false, onActiveBranch: false },
      ] },
      { objective: 'unrelated train booking', choices: [
        { content: 'x'.repeat(250), action: 'include' as const,
          beforeIncluded: false, afterIncluded: true, onActiveBranch: false },
        { content: 'old route', action: 'exclude' as const,
          beforeIncluded: true, afterIncluded: false, onActiveBranch: false },
      ] },
      { objective: 'camera budget oversized', choices: Array.from({ length: 5 }, () => ({
        content: 'too many choices', action: 'include' as const,
        beforeIncluded: false, afterIncluded: true, onActiveBranch: true,
      })) },
      { objective: 'camera budget unchanged', choices: [
        { content: 'old budget', action: 'exclude' as const,
          beforeIncluded: true, afterIncluded: false, onActiveBranch: true },
        { content: 'new budget', action: 'include' as const,
          beforeIncluded: true, afterIncluded: true, onActiveBranch: true },
      ] },
    ]
    const input = buildFastRecommendationInput({ graph, contents: {},
      objective: 'camera budget', planExamples,
      effectiveIncludedNodeIds: graph.nodes.filter(item => item.sessionIds.includes(active)).map(item => item.id),
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] })
    expect(input.planExamples).toHaveLength(FAST_RECOMMENDATION_PLAN_EXAMPLES)
    expect(input.planExamples.map(item => item.objective)).toEqual([
      'camera budget revision', 'unrelated train booking',
    ])
    expect(input.planExamples[0]?.choices.map(choice => choice.action)).toEqual(['exclude', 'include'])
    expect(input.planExamples[1]?.choices[0]?.content).toHaveLength(FAST_RECOMMENDATION_EXAMPLE_CHARS)
  })
  it('rejects mandatory overrides beyond the bound before ranking optional sources', () => {
    const graph = fixture(40)
    expect(() => buildFastRecommendationInput({ graph, contents: {}, objective: '',
      effectiveIncludedNodeIds: [], explicitIncludedNodeIds: graph.nodes.map(item => item.id),
      explicitExcludedNodeIds: [] })).toThrow(/mandatory candidates/)
  })

  it('retains a bounded entry slate across several resumed branch pivots', () => {
    const nodes = Array.from({ length: 40 }, (_, index) =>
      node(`entry-${String(index)}`, index % 2 ? 'assistant' : 'user', 'unrelated entry', [active], index))
    const sideNodes = [0, 10, 20].map(index => node(`side-${String(index)}`, 'user', 'unrelated side', [sibling], 100 + index))
    const edges = nodes.slice(1).map((item, index) => ({ id: `chain-${String(index)}`,
      source: nodes[index]!.id, target: item.id, sessionIds: [active] }))
    for (const [index, side] of sideNodes.entries()) edges.push({ id: `pivot-${String(index)}`,
      source: nodes[index * 10]!.id, target: side.id, sessionIds: [sibling] })
    const graph = { ...fixture(), nodes: [...nodes, ...sideNodes], edges }
    const input = buildFastRecommendationInput({ graph, contents: {}, objective: '',
      effectiveIncludedNodeIds: nodes.map(item => item.id), explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] })
    expect(input.nodes.filter(item => item.reason === 'branch-entry')).toHaveLength(6)
    expect(input.nodes.find(item => item.id === 'entry-21')?.reason).toBe('branch-entry')
    const tight = buildFastRecommendationInput({ graph, contents: {}, objective: '',
      effectiveIncludedNodeIds: nodes.map(item => item.id),
      explicitIncludedNodeIds: nodes.slice(-20).map(item => item.id), explicitExcludedNodeIds: [] })
    expect(tight.nodes.filter(item => item.reason === 'branch-entry')).toEqual([])
  })

  it('reserves off-path capacity when old matching requirements fill the active candidate slate', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => node(`old-${String(index)}`, 'user',
      index < 16 && index % 4 === 0 ? 'camera budget' : 'camera budget correction', [active], index))
    const graph = { ...fixture(), nodes, edges: [] }
    for (const mandatory of [18, 19, 0]) {
      const input = buildFastRecommendationInput({ graph, contents: {}, objective: 'camera budget',
        effectiveIncludedNodeIds: nodes.map(item => item.id),
        explicitIncludedNodeIds: nodes.slice(nodes.length - mandatory).map(item => item.id), explicitExcludedNodeIds: [] })
      expect(input.nodes.length).toBeLessThanOrEqual(FAST_RECOMMENDATION_MAX_NODES)
      expect(input.nodes.filter(item => item.reason === 'distant-active-candidate').length)
        .toBeLessThanOrEqual(FAST_RECOMMENDATION_DISTANT_ACTIVE_LIMIT)
      expect(input.nodes.some(item => item.reason === 'distant-active-candidate')).toBe(true)
    }
  })

  it('abstains from lexical ranking on empty text and skips inconsistent plan examples', () => {
    const graph = fixture()
    const request = { graph, contents: { n7: '' }, objective: 'camera budget',
      effectiveIncludedNodeIds: [], explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] }
    const input = buildFastRecommendationInput({ ...request, planExamples: [
      { objective: 'camera budget', choices: [
        { content: 'old', action: 'include', beforeIncluded: true, afterIncluded: false, onActiveBranch: true },
        { content: 'new', action: 'include', beforeIncluded: false, afterIncluded: true, onActiveBranch: true },
      ] },
    ] })
    expect(input.planExamples).toEqual([])
    expect(input.nodes.find(item => item.id === 'n7')?.lexicalScore).toBe(0)
  })

  it('chooses recent equally relevant plan examples without leaking stale examples', () => {
    const choices = [
      { content: 'old', action: 'exclude' as const, beforeIncluded: true, afterIncluded: false, onActiveBranch: true },
      { content: 'new', action: 'include' as const, beforeIncluded: false, afterIncluded: true, onActiveBranch: true },
    ]
    const input = buildFastRecommendationInput({ graph: fixture(), contents: {}, objective: 'camera budget',
      effectiveIncludedNodeIds: [], explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
      planExamples: [
        { objective: 'camera budget extra', choices },
        { objective: 'camera budget', choices },
        { objective: 'camera budget', choices: choices.map(choice => ({ ...choice, content: `latest ${choice.content}` })) },
      ] })
    expect(input.planExamples).toHaveLength(2)
    expect(input.planExamples.at(-1)?.choices[0]?.content).toBe('latest old')
    expect(input.planExamples.some(example => example.objective === 'camera budget extra')).toBe(false)
  })

  it('keeps competing chat and Web evidence bounded when one branch is already represented', () => {
    const base = fixture()
    const web: ContextFamilyGraphNode = { ...node('web-policy', 'assistant', 'publisher policy', [sibling], 11),
      sourceKind: 'web', role: 'tool', webAction: 'web_fetch' }
    const orphan: ContextFamilyGraphNode = { ...web, id: 'partial-web', sessionIds: [] }
    const graph = { ...base, nodes: [...base.nodes, web, orphan],
      edges: [...base.edges, { id: 'uninspected-endpoint', source: 'n3', target: 'missing-node', sessionIds: [active] }] }
    const input = buildFastRecommendationInput({ graph, contents: { n7: 'publisher policy' },
      objective: 'publisher policy', effectiveIncludedNodeIds: [], explicitIncludedNodeIds: [],
      explicitExcludedNodeIds: [] })
    expect(input.nodes.find(item => item.id === web.id)?.webAction).toBe('web_fetch')
    expect(input.nodes.find(item => item.id === orphan.id)?.graphDistance).toBeNull()
    expect(input.nodes.some(item => item.id === 'missing-node')).toBe(false)
  })

  it('stops the reserved Web slate at four independent branches and tolerates missing depth metadata', () => {
    const base = fixture()
    const web = Array.from({ length: 5 }, (_, index): ContextFamilyGraphNode => ({
      ...node(`independent-web-${String(index)}`, 'assistant', 'publisher policy',
        [`uninspected-web-${String(index)}` as SessionId], index + 30),
      role: 'tool', sourceKind: 'web', webAction: 'web_fetch',
    }))
    const input = buildFastRecommendationInput({ graph: { ...base, nodes: [...base.nodes, ...web] },
      contents: {}, objective: 'publisher policy', effectiveIncludedNodeIds: [],
      explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] })
    expect(input.nodes.filter(item => item.sourceKind === 'web')).toHaveLength(5)
    expect(input.nodes.filter(item => item.sourceKind === 'web').every(item => item.sessionDepths.length === 0))
      .toBe(true)
    expect(input.nodes.length).toBeLessThanOrEqual(FAST_RECOMMENDATION_MAX_NODES)
  })

  it('keeps verified Web action and branch metadata on a displayed preference example', () => {
    const input = buildFastRecommendationInput({ graph: fixture(), contents: {}, objective: 'policy',
      effectiveIncludedNodeIds: [], explicitIncludedNodeIds: [], explicitExcludedNodeIds: [],
      preferenceEdits: [{ objective: 'policy', content: 'verified prior page', mode: 'include',
        sourceKind: 'web', webAction: 'web_fetch', onActiveBranch: false }] })
    expect(input.preferenceExamples[0]).toMatchObject({ sourceKind: 'web', webAction: 'web_fetch', onActiveBranch: false })
  })

  it('marks a confirmed temporary exclusion as restorable without changing current selection', () => {
    const input = buildFastRecommendationInput({ graph: fixture(), contents: {}, objective: 'return to the budget',
      effectiveIncludedNodeIds: [], explicitIncludedNodeIds: [], explicitExcludedNodeIds: ['n9'],
      reviewableExcludedNodeIds: ['n9'] })
    expect(input.nodes.find(item => item.id === 'n9')).toMatchObject({ included: false, reviewableExcluded: true })
    expect(input.nodes.find(item => item.id === 'n8')).not.toHaveProperty('reviewableExcluded')
  })
})

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextFamilyGraph, ContextRecommendationBase } from '../src/types.ts'
import {
  buildRecommendationInput,
  parseRecommendationDecisionText,
  validateRecommendation,
} from '../src/recommendation.ts'

const root = 'recommend-root' as SessionId
const base: ContextRecommendationBase = {
  planRevision: 3,
  graphRevision: 'family-20',
  activeSessionId: root,
}
const graph: ContextFamilyGraph = {
  rootSessionId: root,
  activeSessionId: root,
  sessions: [{ id: root, seedLength: 0, depth: 0, tipNodeId: 'root:2' }],
  nodes: [
    {
      id: 'root:1', owner: { sessionId: root, seq: 1 }, role: 'user', preview: 'old requirement',
      time: 1, branchAtSeq: 3, sessionIds: [root], activeEventSeq: 1,
    },
    {
      id: 'root:2', owner: { sessionId: root, seq: 2 }, role: 'assistant', preview: 'new answer',
      time: 2, branchAtSeq: 3, sessionIds: [root], activeEventSeq: 2,
    },
  ],
  edges: [{ id: 'edge', source: 'root:1', target: 'root:2', sessionIds: [root] }],
}
const validationContext = {
  mode: 'fast' as const,
  base,
  graph,
  effectiveIncludedNodeIds: ['root:1', 'root:2'],
  explicitIncludedNodeIds: [] as string[],
  explicitExcludedNodeIds: [] as string[],
}

describe('Contextify recommendation protocol', () => {
  it('builds a bounded prompt input with exact content and topology metadata', () => {
    const input = buildRecommendationInput({
      graph,
      contents: { 'root:1': 'full old requirement', 'root:2': 'full new answer' },
      effectiveIncludedNodeIds: ['root:1', 'root:2'],
    })

    expect(input.nodes).toMatchObject([
      { id: 'root:1', content: 'full old requirement', included: true, outgoing: ['root:2'] },
      { id: 'root:2', content: 'full new answer', included: true, incoming: ['root:1'] },
    ])
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(96_000)
  })

  it('parses one fenced three-list decision and normalizes missing lists', () => {
    expect(parseRecommendationDecisionText(`analysis ignored\n\`\`\`json
      {"exclude":[{"nodeId":"root:2","reason":"Superseded"}]}
    \`\`\``)).toEqual({
      exclude: [{ nodeId: 'root:2', reason: 'Superseded' }],
      include: [],
      archive: [],
    })
  })

  it('normalizes three action lists into complete Current and Proposed versions', () => {
    const proposal = validateRecommendation({
      include: [{ nodeId: 'root:1', reason: 'Already selected' }],
      exclude: [
        { nodeId: 'root:2', reason: 'Superseded' },
        { nodeId: 'root:2', reason: 'Superseded' },
      ],
      archive: [{
        nodeId: 'root:1', reason: 'Conflicts with the newer answer',
        placeholderText: 'Agent-authored text must be ignored',
      }],
    }, { ...validationContext, mode: 'deep' })

    expect(proposal.mode).toBe('deep')
    expect(proposal.base).toEqual(base)
    expect(proposal.currentNodeIds).toEqual(['root:1', 'root:2'])
    expect(proposal.proposedNodeIds).toEqual(['root:1'])
    expect(proposal.addedNodeIds).toEqual([])
    expect(proposal.removedNodeIds).toEqual(['root:2'])
    expect(proposal.selection).toHaveLength(1)
    expect(proposal.selection[0]?.nodeId).toBe('root:2')
    expect(proposal.archive).toEqual([{
      nodeId: 'root:1', category: 'obsolete', reason: 'Conflicts with the newer answer',
      evidenceNodeIds: [],
    }])
    expect(Object.isFrozen(proposal)).toBe(true)
  })

  it('treats an omitted advisory archive list as no archive candidates', () => {
    const proposal = validateRecommendation({
      exclude: [{ nodeId: 'root:2', reason: 'Superseded' }],
    }, validationContext)

    expect(proposal.removedNodeIds).toEqual(['root:2'])
    expect(proposal.archive).toEqual([])
  })

  it('keeps Fast review limited to request-level selection when a model suggests Archive', () => {
    const proposal = validateRecommendation({
      exclude: [{ nodeId: 'root:2', reason: 'Not needed for the next reply' }],
      archive: [{ nodeId: 'root:1', reason: 'Irrelevant to the current objective' }],
    }, validationContext)
    expect(proposal.removedNodeIds).toEqual(['root:2'])
    expect(proposal.archive).toEqual([])
  })

  it('permits active Web exclusion and source-bound sibling import without archiving evidence', () => {
    const web = { ...graph.nodes[0]!, id: 'root:web', role: 'tool' as const,
      sourceKind: 'web' as const, preview: 'fetched page' }
    const withWeb = { ...validationContext, graph: { ...graph,
      nodes: [...graph.nodes, web] },
    effectiveIncludedNodeIds: [...validationContext.effectiveIncludedNodeIds, web.id] }
    expect(validateRecommendation({ exclude: [{ nodeId: web.id, reason: 'stale page' }] },
      withWeb).removedNodeIds).toEqual([web.id])
    expect(() => validateRecommendation({ archive: [{ nodeId: web.id, reason: 'obsolete' }] },
      withWeb)).toThrow(/evidence rather than a conversation message/)
    const sibling = 'recommend-sibling' as SessionId
    const offPath = { ...web, id: 'sibling:web', owner: { sessionId: sibling, seq: 1 },
      sessionIds: [sibling], activeEventSeq: null }
    const withSibling = { ...validationContext, graph: { ...graph,
      nodes: [...graph.nodes, offPath] } }
    expect(validateRecommendation({ include: [{ nodeId: offPath.id, reason: 'copy' }] },
      withSibling).addedNodeIds).toEqual([])
    const sourceBound = { ...offPath, id: 'sibling:bound-web', webAction: 'web_fetch' as const }
    const withBound = { ...validationContext, graph: { ...graph,
      nodes: [...graph.nodes, sourceBound] } }
    expect(validateRecommendation({ include: [{ nodeId: sourceBound.id, reason: 'reuse page' }] },
      withBound).addedNodeIds).toEqual([sourceBound.id])
  })

  it.each([
    ['unknown node', { exclude: [{ nodeId: 'missing', reason: 'x' }] }],
    ['conflicting selection', {
      exclude: [{ nodeId: 'root:1', reason: 'x' }],
      include: [{ nodeId: 'root:1', reason: 'y' }],
    }],
    ['unknown archive node', { archive: [{ nodeId: 'missing', reason: 'x' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => validateRecommendation(value, validationContext)).toThrow()
  })

  it('preserves explicit Include pins and Exclude blocks while accepting other changes', () => {
    const proposal = validateRecommendation({
      exclude: [
        { nodeId: 'root:1', reason: 'Do not reverse this explicit Include' },
        { nodeId: 'root:2', reason: 'Remove the natural active-path answer' },
      ],
      include: [],
      archive: [],
    }, {
      ...validationContext,
      explicitIncludedNodeIds: ['root:1'],
    })

    expect(proposal.selection).toMatchObject([{
      nodeId: 'root:2', action: 'exclude', reason: 'Remove the natural active-path answer',
    }])
  })

  it('filters attempts to reverse explicit modes after validating unknown and conflicting actions', () => {
    const pinned = validateRecommendation({
      exclude: [{ nodeId: 'root:1', reason: 'Model disagrees with the user pin' }],
      include: [],
      archive: [],
    }, {
      ...validationContext,
      explicitIncludedNodeIds: ['root:1'],
    })
    expect(pinned.selection).toEqual([])

    const blocked = validateRecommendation({
      exclude: [],
      include: [{ nodeId: 'root:2', reason: 'Model disagrees with the user block' }],
      archive: [],
    }, {
      ...validationContext,
      effectiveIncludedNodeIds: [],
      explicitExcludedNodeIds: ['root:2'],
    })
    expect(blocked.selection).toEqual([])

    expect(() => validateRecommendation({
      exclude: [{ nodeId: 'root:1', reason: 'x' }],
      include: [{ nodeId: 'root:1', reason: 'y' }],
      archive: [],
    }, {
      ...validationContext,
      explicitIncludedNodeIds: ['root:1'],
    })).toThrow(/conflicting actions/)
  })

  it('offers restoration only for a previously reviewed temporary Exclude', () => {
    const restore = validateRecommendation({
      exclude: [],
      include: [{ nodeId: 'root:2', reason: 'The user returned to this open item' }],
      archive: [],
    }, {
      ...validationContext,
      effectiveIncludedNodeIds: [],
      explicitExcludedNodeIds: ['root:2'],
      reviewableExcludedNodeIds: ['root:2'],
    })
    expect(restore.selection).toMatchObject([{ nodeId: 'root:2', action: 'include' }])
    expect(restore.addedNodeIds).toEqual(['root:2'])
  })

  it('rejects graph snapshots larger than the review boundary', () => {
    const tooLarge = {
      ...graph,
      nodes: Array.from({ length: 501 }, (_, index) => ({
        ...graph.nodes[0]!,
        id: `root:${String(index)}`,
        owner: { sessionId: root, seq: index },
      })),
    }
    expect(() => buildRecommendationInput({
      graph: tooLarge,
      contents: {},
      effectiveIncludedNodeIds: [],
    })).toThrow(/500/)
  })

  it('parses one optional bounded native task-state advice alongside legacy selection', () => {
    const value = { include: [], exclude: [], archive: [], workStates: [
      { sessionId: root, state: 'parked', reason: 'The user deferred this task to tomorrow' },
    ] }
    const parsed = parseRecommendationDecisionText(JSON.stringify(value))
    expect(parsed).toEqual(value)
    expect(Object.isFrozen(parsed.workStates)).toBe(true)
    expect(Object.isFrozen(parsed.workStates?.[0])).toBe(true)
    expect(validateRecommendation(parsed, validationContext).workStates).toEqual(value.workStates)
    expect(parseRecommendationDecisionText('{}')).toEqual({ include: [], exclude: [], archive: [] })
  })

  it('rejects foreign, unsupported, oversized, and malformed lifecycle advice and removes state no-ops', () => {
    const advice = { sessionId: root, state: 'completed', reason: 'The source lookup has concluded' }
    expect(() => validateRecommendation({ workStates: [{ ...advice, sessionId: 'foreign' }] }, validationContext))
      .toThrow(/unavailable/)
    for (const value of [null, 'bad', [null], [{ ...advice, state: 'archived' }],
      [advice, advice], [{ ...advice, reason: '' }], [{ ...advice, sessionId: '' }],
      [{ ...advice, reason: 'x'.repeat(501) }], [{ ...advice, extra: true }]]) {
      expect(() => parseRecommendationDecisionText(JSON.stringify({ workStates: value }))).toThrow()
      expect(() => validateRecommendation({ workStates: value }, validationContext)).toThrow()
    }
    const completed = { ...validationContext, graph: { ...graph,
      sessions: graph.sessions.map(session => ({ ...session, workState: 'completed' as const })),
    } }
    expect(validateRecommendation({ workStates: [advice] }, completed).workStates).toBeUndefined()
    expect(validateRecommendation({ workStates: [] }, validationContext).workStates).toBeUndefined()
    for (const state of ['open', 'parked', 'completed'] as const) {
      expect(validateRecommendation({ workStates: [{ ...advice, state }] }, validationContext).workStates)
        .toMatchObject([{ state }])
    }
  })

  it.each([
    ['missing JSON', 'plain explanation', /did not contain JSON/],
    ['broken JSON', '{"include":}', /invalid JSON/],
    ['foreign field', '{"override":true}', /unsupported/],
    ['invalid reason type', '{"include":[{"nodeId":"root:1","reason":2}]}', /must be a string/],
  ])('rejects a classifier response with %s', (_label, text, error) => {
    expect(() => parseRecommendationDecisionText(text)).toThrow(error)
  })

  it('rejects foreign decision fields and duplicate archive requests before proposing edits', () => {
    expect(() => validateRecommendation({ override: true }, validationContext)).toThrow(/unsupported/)
    expect(() => validateRecommendation({ archive: [
      { nodeId: 'root:1', reason: 'old' }, { nodeId: 'root:1', reason: 'old again' },
    ] }, { ...validationContext, mode: 'deep' })).toThrow(/duplicated/)
  })

  it('projects absent content, unknown Session depth and multiple edges without inventing source text', () => {
    const unknown = 'uninspected-session' as SessionId
    const input = buildRecommendationInput({
      graph: { ...graph, nodes: graph.nodes.map(node => ({ ...node, sessionIds: [root, unknown] })),
        edges: [...graph.edges, { ...graph.edges[0]!, id: 'reverse', source: 'root:2', target: 'root:1' }] },
      contents: {}, effectiveIncludedNodeIds: [],
    })
    expect(input.nodes.map(node => [node.content, node.sessionDepths])).toEqual([
      ['old requirement', [0]], ['new answer', [0]],
    ])
    expect(input.nodes[0]?.incoming).toEqual(['root:2'])
    expect(input.nodes[0]?.outgoing).toEqual(['root:2'])
    expect(buildRecommendationInput({ graph: { ...graph, nodes: [], edges: [] },
      contents: {}, effectiveIncludedNodeIds: [] }).nodes).toEqual([])
  })

  it('shrinks high-volume Unicode content while preserving the full graph and its serialized budget', () => {
    const nodes = Array.from({ length: 120 }, (_, index) => ({ ...graph.nodes[0]!,
      id: `budget:${String(index)}`, preview: '🧭'.repeat(1200) }))
    const input = buildRecommendationInput({ graph: { ...graph, nodes, edges: [] },
      contents: {}, effectiveIncludedNodeIds: [] })
    expect(input.nodes).toHaveLength(nodes.length)
    expect(JSON.stringify(input).length).toBeLessThanOrEqual(96_000)
    expect(input.nodes.some(node => node.truncated)).toBe(true)
    expect(input.nodes.every(node => !node.content.includes('\uFFFD'))).toBe(true)
    expect(input.nodes.every(node => /^🧭*$/u.test(node.content))).toBe(true)
  })

  it('rejects oversized topology instead of dropping graph identities or edges', () => {
    const nodes = Array.from({ length: 500 }, (_, index) => ({ ...graph.nodes[0]!,
      id: `${'long-source-'.repeat(40)}${String(index)}`, preview: '' }))
    expect(() => buildRecommendationInput({ graph: { ...graph, nodes, edges: [] },
      contents: {}, effectiveIncludedNodeIds: [] })).toThrow(/topology/)
    expect(() => buildRecommendationInput({ graph: { ...graph,
      activeSessionId: 'x'.repeat(96_001) as SessionId, nodes: [], edges: [] },
    contents: {}, effectiveIncludedNodeIds: [] })).toThrow(/topology/)
  })

  it('retains fan-out and fan-in topology in the bounded review projection', () => {
    const third = { ...graph.nodes[1]!, id: 'root:3', owner: { sessionId: root, seq: 3 } }
    const input = buildRecommendationInput({ graph: { ...graph, nodes: [...graph.nodes, third],
      edges: [...graph.edges,
        { id: 'to-third-a', source: 'root:1', target: third.id, sessionIds: [root] },
        { id: 'to-third-b', source: 'root:2', target: third.id, sessionIds: [root] },
      ] }, contents: {}, effectiveIncludedNodeIds: [] })
    expect(input.nodes[0]?.outgoing).toEqual(['root:2', 'root:3'])
    expect(input.nodes[2]?.incoming).toEqual(['root:1', 'root:2'])
  })

  it('retains typed Web sources in classifier-visible evidence metadata', () => {
    const web = { ...graph.nodes[0]!, sourceKind: 'web' as const, webAction: 'web_fetch' as const }
    const input = buildRecommendationInput({ graph: { ...graph, nodes: [web], edges: [] },
      contents: {}, effectiveIncludedNodeIds: [] })
    expect(input.nodes[0]).toMatchObject({ sourceKind: 'web', webAction: 'web_fetch' })
  })
})

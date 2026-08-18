import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextFamilyGraph, ContextRecommendationBase } from '../src/types.ts'
import {
  buildRecommendationInput,
  validateRecommendation,
} from '../src/recommendation.ts'

const root = 'recommend-root' as SessionId
const base: ContextRecommendationBase = {
  planRevision: 3,
  graphAsOfSeq: 20,
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

  it('validates a review-only selection and cleanup proposal', () => {
    const proposal = validateRecommendation({
      selection: [{ nodeId: 'root:1', action: 'exclude', reason: 'Superseded', confidence: 'high' }],
      cleanup: [{
        nodeId: 'root:1', category: 'obsolete', reason: 'Conflicts with the newer answer',
        evidenceNodeIds: ['root:2'], placeholderText: '[Removed obsolete requirement]',
      }],
    }, { base, graph, effectiveIncludedNodeIds: ['root:1', 'root:2'] })

    expect(proposal.base).toEqual(base)
    expect(proposal.selection).toHaveLength(1)
    expect(proposal.cleanup).toHaveLength(1)
    expect(Object.isFrozen(proposal)).toBe(true)
  })

  it.each([
    ['unknown node', { selection: [{ nodeId: 'missing', action: 'exclude', reason: 'x', confidence: 'high' }], cleanup: [] }],
    ['duplicate selection', { selection: [
      { nodeId: 'root:1', action: 'exclude', reason: 'x', confidence: 'high' },
      { nodeId: 'root:1', action: 'exclude', reason: 'y', confidence: 'low' },
    ], cleanup: [] }],
    ['invalid evidence', { selection: [], cleanup: [{
      nodeId: 'root:1', category: 'conflict', reason: 'x', evidenceNodeIds: ['missing'], placeholderText: '[Removed]',
    }] }],
    ['empty placeholder', { selection: [], cleanup: [{
      nodeId: 'root:1', category: 'redundant', reason: 'x', evidenceNodeIds: [], placeholderText: '',
    }] }],
    ['no-op include', { selection: [
      { nodeId: 'root:1', action: 'include', reason: 'already included', confidence: 'medium' },
    ], cleanup: [] }],
  ])('rejects %s', (_label, value) => {
    expect(() => validateRecommendation(value, {
      base, graph, effectiveIncludedNodeIds: ['root:1', 'root:2'],
    })).toThrow()
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
})

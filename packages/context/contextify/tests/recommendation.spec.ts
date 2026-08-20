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
    }, validationContext)

    expect(proposal.mode).toBe('fast')
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

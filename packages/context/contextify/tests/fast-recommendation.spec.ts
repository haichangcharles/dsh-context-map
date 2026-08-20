import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextFamilyGraph, ContextFamilyGraphNode } from '../src/types.ts'
import {
  buildFastRecommendationInput,
  FAST_RECOMMENDATION_MAX_NODES,
  FAST_RECOMMENDATION_OFF_PATH_LIMIT,
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
})

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { carryRouteScope, planRouteScope } from '../src/route-scope.ts'
import { createInitialContextPlan } from '../src/plan.ts'
import type { ContextFamilyGraph, ContextPlanSnapshot, ContextRecommendationProposal } from '../src/types.ts'

const root = SessionId('scope-root')
const side = SessionId('scope-side')
const graph = { activeSessionId: root, rootSessionId: root,
  sessions: [{ id: root, depth: 0 }, { id: side, depth: 1, parentSessionId: root }], edges: [],
  nodes: [{ id: 'root:1', owner: { sessionId: root, seq: 1 }, role: 'user', sessionIds: [root, side], sourceKind: 'chat' },
    { id: 'side:1', owner: { sessionId: side, seq: 1 }, role: 'user', sessionIds: [side], sourceKind: 'chat' }],
} as unknown as ContextFamilyGraph
const plan = createInitialContextPlan()
const proposal = (ids: readonly string[]): ContextRecommendationProposal => ({ mode: 'fast',
  base: { activeSessionId: side, planRevision: 1, graphRevision: 'original' },
  currentNodeIds: ['root:1', 'side:1'], proposedNodeIds: ids, addedNodeIds: [], removedNodeIds: [], selection: [], archive: [] })
const carry = (ids: readonly string[], targetPlan: ContextPlanSnapshot = plan, targetGraph = graph) => carryRouteScope({
  proposal: proposal(ids), sourcePlan: plan, plan: targetPlan, graph: targetGraph, graphRevision: 'destination' })

describe('portable reviewed scope', () => {
  it('bases a sibling on its parent Plan while retaining explicit pins and reviewed edits', () => {
    const input = { graph, parentSessionId: root, parentPlan: plan, sourcePlan: plan, proposal: proposal(['root:1', 'side:1']) }
    expect(planRouteScope(input)).toEqual(['root:1'])
    expect(planRouteScope({ ...input, affirmedNodeIds: ['side:1'], excludedNodeIds: ['root:1'] })).toEqual(['side:1'])
    expect(planRouteScope({ ...input, parentPlan: { ...plan, excluded: [{ nodeId: 'root:1', eventSeq: 1 }] },
      sourcePlan: { ...plan, included: [{ nodeId: 'side:1', snapshotSeq: 1, position: 1 }] },
      proposal: { ...input.proposal, selection: [{ action: 'include', nodeId: 'root:1', reason: 'Needed', confidence: 'high' }] } }))
      .toEqual(['root:1', 'side:1'])
    expect(planRouteScope({ ...input, selectedNodeIds: [],
      parentPlan: { ...plan, included: [{ nodeId: 'side:1', snapshotSeq: 1, position: 1 }] } })).toEqual(['side:1'])
    expect(planRouteScope({ ...input, selectedNodeIds: ['root:1', 'side:1'],
      parentPlan: { ...plan, excluded: [{ nodeId: 'root:1', eventSeq: 1 }] } })).toEqual(['side:1'])
  })

  it('does not expand a replaced parent source during a sibling fork', () => {
    expect(() => planRouteScope({ graph, parentSessionId: root, parentPlan: { ...plan,
      replacements: [{ nodeId: 'root:1', snapshotSeq: 1, originalEventSeq: 1,
        role: 'user', kind: 'placeholder', reason: 'Archived' }] }, sourcePlan: plan, proposal: proposal([]) }))
      .toThrow('replaced')
  })

  it('keeps all validated source IDs, imports sibling evidence and retains decision provenance', () => {
    const original = { ...proposal(['root:1', 'side:1']), personalization: { enabled: false, reviewer: 'jev' as const, examples: [] } }
    const result = carryRouteScope({ proposal: original, sourcePlan: plan, graph, plan, graphRevision: 'destination' })
    expect(result.proposedNodeIds).toEqual(['root:1', 'side:1'])
    expect(result.selection).toMatchObject([{ nodeId: 'side:1', action: 'include' }])
    expect(result.sourceBase).toEqual(original.base)
    expect(result.personalization).toBe(original.personalization)
  })

  it('rejects missing and replaced sources before preparing any mutation', () => {
    expect(() => carry(['missing'])).toThrow('unavailable')
    expect(() => carry(['root:1'], { ...plan, replacements: [{ nodeId: 'root:1', snapshotSeq: 1,
      originalEventSeq: 1, role: 'user', kind: 'placeholder', reason: 'Archived' }] })).toThrow('replaced')
  })

  it('preserves destination Include and Exclude pins instead of weakening the approved set', () => {
    expect(() => carry(['root:1'], { ...plan, included: [{ nodeId: 'side:1', snapshotSeq: 1, position: 1 }] }))
      .toThrow('conflicts')
    expect(() => carry(['root:1'], { ...plan, excluded: [{ nodeId: 'root:1', eventSeq: 1 }] })).toThrow('conflicts')
  })

  it('refuses an unsupported worker import and accepts an explicitly empty scope', () => {
    const unsupported = { ...graph, nodes: graph.nodes.map(node => node.id === 'side:1' ? { ...node, sourceKind: 'worker' as const } : node) }
    expect(() => carry(['side:1'], plan, unsupported)).toThrow('conflicts')
    expect(carry([]).proposedNodeIds).toEqual([])
  })
})

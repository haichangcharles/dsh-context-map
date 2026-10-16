/** Portable reviewed selection for an existing native destination; no inference or mutation. */
import type { ContextFamilyGraph, ContextPlanSnapshot, ContextRecommendationProposal } from './types.ts'
import { validateRecommendation } from './recommendation.ts'

/** Revalidate a complete source selection against the destination's manual choices.
 * @param input - Original proposal, source Plan, unchanged graph and destination Plan.
 * @returns A destination-bound proposal with the original decision's provenance.
 */
export function carryRouteScope(input: {
  readonly proposal: ContextRecommendationProposal
  readonly sourcePlan: ContextPlanSnapshot
  readonly graph: ContextFamilyGraph
  readonly plan: ContextPlanSnapshot
  readonly graphRevision: string
}): ContextRecommendationProposal {
  const { proposal, sourcePlan, graph, plan, graphRevision } = input
  const desired = new Set(proposal.proposedNodeIds)
  const known = new Set(graph.nodes.map(node => node.id))
  if ([...desired].some(id => !known.has(id))
    || [...sourcePlan.replacements, ...plan.replacements].some(item => desired.has(item.nodeId))) {
    throw new Error('Carried Context contains an unavailable or replaced source')
  }
  const effective = new Set(graph.nodes.filter(node => node.sessionIds.includes(graph.activeSessionId)).map(node => node.id))
  for (const item of plan.excluded) effective.delete(item.nodeId)
  for (const item of plan.included) effective.add(item.nodeId)
  const item = (nodeId: string) => ({ nodeId, reason: 'Approved Context carried with the draft.' })
  const rebased = validateRecommendation({
    include: [...desired].filter(id => !effective.has(id)).map(item),
    exclude: [...effective].filter(id => !desired.has(id)).map(item), archive: [],
  }, { mode: proposal.mode,
    base: { activeSessionId: graph.activeSessionId, planRevision: plan.revision, graphRevision },
    graph, effectiveIncludedNodeIds: [...effective],
    explicitIncludedNodeIds: plan.included.map(item => item.nodeId),
    explicitExcludedNodeIds: plan.excluded.map(item => item.nodeId) })
  if (rebased.proposedNodeIds.length !== desired.size || rebased.proposedNodeIds.some(id => !desired.has(id))) {
    throw new Error('Carried Context conflicts with the destination manual scope')
  }
  return Object.freeze({ ...rebased, sourceBase: proposal.base,
    ...(proposal.personalization === undefined ? {} : { personalization: proposal.personalization }) })
}

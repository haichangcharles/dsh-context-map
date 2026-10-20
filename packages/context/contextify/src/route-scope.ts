/** Portable reviewed selection for an existing native destination; no inference or mutation. */
import type { ContextFamilyGraph, ContextPlanSnapshot, ContextRecommendationProposal } from './types.ts'
import { validateRecommendation } from './recommendation.ts'

/** A destination replacement cannot be carried as its unmodified original source. */
export class ContextRouteScopeReplacementError extends Error {}

/** Collect current owned sources along a native task's ancestry, beyond its fork snapshot.
 * @param graph - Frozen family authority.
 * @param sessionId - Validated native destination or fork parent.
 * @returns Canonical graph source IDs in stable graph order.
 */
export function taskAndAncestorNodeIds(graph: ContextFamilyGraph, sessionId: ContextFamilyGraph['activeSessionId']): readonly string[] {
  const owners = new Set<ContextFamilyGraph['activeSessionId']>()
  let current: ContextFamilyGraph['activeSessionId'] | undefined = sessionId
  while (current !== undefined && !owners.has(current)) {
    owners.add(current)
    current = graph.sessions.find(session => session.id === current)?.parentSessionId
  }
  return Object.freeze(graph.nodes.filter(node => owners.has(node.owner.sessionId)).map(node => node.id))
}

/** Build the destination scope from its saved Plan and explicitly reviewed evidence.
 * @param input - Native family, destination Plan, source Plan and validated source review.
 * @returns Canonical source IDs without implicitly importing the old branch's Natural history.
 */
export function planRouteScope(input: {
  readonly graph: ContextFamilyGraph
  readonly parentSessionId: ContextFamilyGraph['activeSessionId']
  readonly parentPlan: ContextPlanSnapshot
  readonly sourcePlan: ContextPlanSnapshot
  readonly proposal: ContextRecommendationProposal
  readonly affirmedNodeIds?: readonly string[]
  readonly excludedNodeIds?: readonly string[]
  /** Host-confirmed explicit policy; source IDs still come only from native authority. */
  readonly wholeTask?: boolean
  /** Complete reviewed preservation set; overrides Natural history as the initial scope. */
  readonly selectedNodeIds?: readonly string[]
}): readonly string[] {
  const selected = new Set(input.selectedNodeIds ?? (input.wholeTask === true ? taskAndAncestorNodeIds(input.graph, input.parentSessionId)
    : input.graph.nodes.filter(node => node.sessionIds.includes(input.parentSessionId)).map(node => node.id)))
  for (const item of [...input.parentPlan.excluded, ...input.sourcePlan.excluded]) selected.delete(item.nodeId)
  for (const item of [...input.parentPlan.included, ...input.sourcePlan.included]) selected.add(item.nodeId)
  for (const id of input.affirmedNodeIds ?? []) selected.add(id)
  for (const id of input.excludedNodeIds ?? []) selected.delete(id)
  for (const item of input.proposal.selection) {
    if (item.action === 'include') selected.add(item.nodeId)
    else selected.delete(item.nodeId)
  }
  if (input.parentPlan.replacements.some(item => selected.has(item.nodeId))) {
    throw new ContextRouteScopeReplacementError('Proposed fork Context contains a replaced parent source')
  }
  return Object.freeze(input.graph.nodes.filter(node => selected.has(node.id)).map(node => node.id))
}

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
    ...(proposal.scopePolicy === undefined ? {} : { scopePolicy: proposal.scopePolicy }),
    ...(proposal.personalization === undefined ? {} : { personalization: proposal.personalization }) })
}

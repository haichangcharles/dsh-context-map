/** Complete explicit preservation from native ownership, separate from task placement. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GoalRouteAssignment } from './goal-route.ts'
import type { ContextFamilyGraph, ContextFamilyInspection } from './types.ts'

/** A complete Host-resolved base; model exceptions are confined to the reviewed slate. */
export interface GoalPreservationScope {
  readonly sessionId: SessionId
  readonly assignment: 'new' | 'existing'
  readonly mode: 'task-owned' | 'task-lineage'
  readonly nodeIds: readonly string[]
}

/** Resolve explicit preservation from original headers and verified owned event suffixes.
 * @param assignment - Validated known destination and preservation mode.
 * @param graph - Same frozen native family used for review.
 * @param inspections - Same family inspections, never model-supplied lineage.
 * @returns Complete preservation base, or null when required provenance is unavailable.
 */
export function resolveGoalPreservationScope(
  assignment: Exclude<GoalRouteAssignment, { assignment: 'unknown' }> & { retention: 'task-owned' | 'task-lineage' },
  graph: ContextFamilyGraph,
  inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
): GoalPreservationScope | null {
  const owners = new Set<SessionId>()
  let current: SessionId | undefined = assignment.sessionId
  while (current !== undefined) {
    const inspection = inspections.get(current)
    if (inspection === undefined || owners.has(current)) return null
    owners.add(current)
    if (assignment.retention === 'task-owned') break
    current = inspection.meta.parentSession
  }
  if (assignment.assignment === 'new' && assignment.retention === 'task-owned') owners.clear()
  const nodes = graph.nodes.filter(node => owners.has(node.owner.sessionId))
  for (const node of nodes) {
    const owner = inspections.get(node.owner.sessionId)
    if (owner === undefined || node.owner.seq < owner.inheritedEventCount
      || owner.events[node.owner.seq] === undefined) return null
  }
  return Object.freeze({ sessionId: assignment.sessionId, assignment: assignment.assignment, mode: assignment.retention,
    nodeIds: Object.freeze(nodes.map(node => node.id)) })
}

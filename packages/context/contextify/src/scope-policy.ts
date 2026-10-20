/** Complete policy approval over existing native events, without inferred partial-mask labels. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph, ContextFamilyInspection, ContextRecommendationBase,
  ContextRecommendationProposal, ContextScopePolicyExample, ContextScopePolicyReview } from './types.ts'
import { resolveGoalPreservationScope, type GoalPreservationScope } from './goal-retention.ts'
import { contextPlanFeedbackStates } from './plan.ts'

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === new Set(a).size && b.length === new Set(b).size
    && a.length === b.length && a.every(id => b.includes(id))
}
function policyKey(policy: Omit<ContextScopePolicyReview, 'key'>, base: ContextRecommendationBase, ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([policy.reviewId, policy.mode, policy.assignment, policy.sessionId,
    policy.sourceCount, base.activeSessionId, base.planRevision, base.graphRevision, [...ids].sort()])).digest('hex')
}

/** Describe only distinguishable complete native bases, without model exceptions.
 * @param input - Server-owned goal base, frozen graph, original headers and final proposed history.
 * @returns A display descriptor, or undefined for empty, ambiguous, exceptional or replaced scopes.
 */
export function buildScopePolicyReview(input: {
  readonly reviewId: string
  readonly preservation: GoalPreservationScope
  readonly base: ContextRecommendationBase
  readonly proposedNodeIds: readonly string[]
  readonly graph: ContextFamilyGraph
  readonly inspections: ReadonlyMap<SessionId, ContextFamilyInspection>
  readonly replacedNodeIds: readonly string[]
}): ContextScopePolicyReview | undefined {
  const p = input.preservation
  if (p.nodeIds.length === 0 || !sameSet(p.nodeIds, input.proposedNodeIds)
    || input.replacedNodeIds.some(id => p.nodeIds.includes(id))) return undefined
  const canonical = resolveGoalPreservationScope({ goal: '', assignment: p.assignment, sessionId: p.sessionId, retention: p.mode }, input.graph, input.inspections)
  if (canonical === null || !sameSet(canonical.nodeIds, p.nodeIds)) return undefined
  const alternate = resolveGoalPreservationScope({ goal: '', assignment: p.assignment, sessionId: p.sessionId,
    retention: p.mode === 'task-owned' ? 'task-lineage' : 'task-owned' }, input.graph, input.inspections)
  if (alternate === null || sameSet(p.nodeIds, alternate.nodeIds)) return undefined
  const descriptor = { reviewId: input.reviewId, mode: p.mode, assignment: p.assignment,
    sessionId: p.sessionId, sourceCount: p.nodeIds.length }
  return Object.freeze({ ...descriptor, key: policyKey(descriptor, input.base, p.nodeIds) })
}

/** Match a declared display acknowledgement to the exact fully applied pending scope.
 * @param input - Existing pending proposal, actual effective set, changed state and Client acknowledgement.
 * @returns Optional event metadata; missing/wrong acknowledgement never changes legacy actions.
 */
export function approvedScopePolicy(input: {
  readonly proposal: ContextRecommendationProposal
  readonly displayedPolicyKey?: string
  readonly uiOrigin?: 'contextify-client'
  readonly enabled: boolean
  readonly changed: boolean
  readonly declinedNodeIds: readonly string[]
  readonly effectiveNodeIds: readonly string[]
}): ContextScopePolicyReview | undefined {
  const p = input.proposal.scopePolicy
  if (!input.enabled || !input.changed || input.uiOrigin !== 'contextify-client' || p === undefined
    || input.displayedPolicyKey !== p.key || input.declinedNodeIds.length > 0
    || input.proposal.selection.length === 0 || !sameSet(input.proposal.proposedNodeIds, input.effectiveNodeIds)) return undefined
  return p
}

function validPolicy(value: unknown): value is ContextScopePolicyReview {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const p = value as Record<string, unknown>
  return typeof p.reviewId === 'string' && p.reviewId.length > 0 && p.reviewId.length <= 128
    && typeof p.key === 'string' && /^[a-f0-9]{64}$/.test(p.key)
    && (p.mode === 'task-owned' || p.mode === 'task-lineage')
    && (p.assignment === 'new' || p.assignment === 'existing')
    && typeof p.sessionId === 'string' && p.sessionId.length > 0
    && typeof p.sourceCount === 'number' && Number.isSafeInteger(p.sourceCount) && p.sourceCount > 0
}

/** Project at most four complete approvals from owned, still-active native Plan history.
 * @param inspections - Actual family logs; inherited copies are excluded.
 * @param watermarks - Existing Profile reset cursors; raw logs are unchanged.
 * @returns Event-referenced historical choices, never current destination authority.
 */
export function scopePolicyExamplesFromInspections(
  inspections: readonly ContextFamilyInspection[], watermarks: ReadonlyMap<SessionId, number>,
): readonly ContextScopePolicyExample[] {
  const result: ContextScopePolicyExample[] = []
  for (const inspection of inspections) {
    const owned = inspection.events.slice(inspection.inheritedEventCount)
    const { stateByPlanRevision, undoneStates } = contextPlanFeedbackStates(owned)
    for (const [index, event] of owned.entries()) {
      if (event.type !== 'contextify/recommendation-reviewed' || event.data.scopePolicy === undefined
        || event.data.uiOrigin !== 'contextify-client' || event.data.base.activeSessionId !== inspection.meta.id || event.seq <= (watermarks.get(inspection.meta.id) ?? -1)) continue
      const p = event.data.scopePolicy, previous = owned[index - 1]
      if (!validPolicy(p) || previous?.type !== 'contextify/node-choice' || previous.data.origin !== 'recommendation'
        || previous.data.uiOrigin !== 'contextify-client' || !previous.data.changed || previous.data.proposal === undefined) continue
      const proposal = previous.data.proposal, after = stateByPlanRevision.get(previous.data.afterPlanRevision)
      if (after === undefined || after === stateByPlanRevision.get(previous.data.beforePlanRevision) || undoneStates.has(after)
        || previous.data.beforePlanRevision !== event.data.base.planRevision
        || event.data.declinedNodeIds.length > 0 || event.data.selection.length === 0
        || !sameSet(event.data.acceptedNodeIds, event.data.selection.map(item => item.nodeId))
        || JSON.stringify(proposal.selection) !== JSON.stringify(event.data.selection)
        || !sameSet(proposal.proposedNodeIds, proposal.proposedNodeIds) || p.sourceCount !== proposal.proposedNodeIds.length
        || p.key !== policyKey(p, event.data.sourceBase ?? event.data.base, proposal.proposedNodeIds)) continue
      const objective = Array.from(event.data.objective ?? '').slice(0, 200).join('')
      if (!objective.trim() || !Number.isFinite(event.time)) continue
      result.push(Object.freeze({ sourceSessionId: inspection.meta.id, sourceEventSeq: event.seq,
        at: event.time, objective, mode: p.mode, assignment: p.assignment }))
    }
  }
  return Object.freeze([...new Map(result.map(row => [`${row.sourceSessionId}:${String(row.sourceEventSeq)}`, row])).values()].sort((a, b) => a.at - b.at || a.sourceSessionId.localeCompare(b.sourceSessionId)
    || a.sourceEventSeq - b.sourceEventSeq).slice(-4))
}

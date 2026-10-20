/** Complete policy approval over existing native events, without inferred partial-mask labels. */
import { createHash } from 'node:crypto'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph, ContextFamilyInspection, ContextRecommendationBase,
  ContextRecommendationProposal, ContextScopePolicyExample, ContextScopePolicyReview } from './types.ts'
import { resolveGoalPreservationScope, type GoalPreservationScope } from './goal-retention.ts'
import { contextPlanFeedbackStates, nextPlan, normalizeContextPlanSnapshot } from './plan.ts'
import { jaccardOverlap } from './lexical-tokens.ts'

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

/** Local native-state consistency, not authentication of the producer or original source. */
function appliedReviewMatches(events: readonly SessionEvent[], index: number,
  review: Extract<SessionEvent, { type: 'contextify/recommendation-reviewed' }>,
  choice: Extract<SessionEvent, { type: 'contextify/node-choice' }>): boolean {
  const priorEvents = events.slice(0, index)
  const planIndex = priorEvents.findLastIndex(event => event.type === 'contextify/plan')
  const planEvent = priorEvents[planIndex]
  if (planEvent?.type !== 'contextify/plan') return false
  const actual = normalizeContextPlanSnapshot(planEvent.data)
  const beforeEvent = priorEvents.slice(0, planIndex).findLast(event => event.type === 'contextify/plan')
  if (beforeEvent?.type !== 'contextify/plan') return false
  const before = normalizeContextPlanSnapshot(beforeEvent.data)
  if (actual === null || before === null || before.revision !== choice.data.beforePlanRevision
    || actual.revision !== choice.data.afterPlanRevision || actual.revision !== before.revision + 1) return false
  if (sameSet(before.excluded.map(item => item.nodeId), actual.excluded.map(item => item.nodeId))
    && sameSet(before.included.map(item => item.nodeId), actual.included.map(item => item.nodeId))) return false
  const input: unknown = choice.data.mutations
  if (!Array.isArray(input) || !input.every((item: unknown): item is typeof choice.data.mutations[number] => {
    const node = item !== null && typeof item === 'object' ? item as Record<string, unknown> : null
    return node !== null && typeof node.nodeId === 'string'
      && (node.mode === 'natural' || node.mode === 'include' || node.mode === 'exclude')
  })) return false
  const mutations = input
  if (!sameSet(mutations.map(item => item.nodeId), review.data.acceptedNodeIds)) return false
  let excluded = [...before.excluded], included = [...before.included]
  for (const mutation of mutations) {
    if (!review.data.selection.some(item => item.nodeId === mutation.nodeId
      && item.action === (mutation.mode === 'exclude' ? 'exclude' : 'include'))) return false
    excluded = excluded.filter(item => item.nodeId !== mutation.nodeId)
    included = included.filter(item => item.nodeId !== mutation.nodeId)
    const colon = mutation.nodeId.lastIndexOf(':')
    if (colon < 1) return false
    const suffix = mutation.nodeId.slice(colon + 1)
    if (mutation.mode === 'exclude') {
      const item = actual.excluded.find(item => item.nodeId === mutation.nodeId)
      const source = item === undefined ? undefined : priorEvents.slice(0, planIndex).find(event => event.seq === item.eventSeq)
      if (item === undefined || suffix !== String(item.eventSeq) || source?.surfaceOp !== 'append'
        || !['user/message', 'assistant/message', 'tool/result'].includes(source.type)) return false
      excluded.push(item)
    } else if (mutation.mode === 'include') {
      const item = actual.included.find(item => item.nodeId === mutation.nodeId)
      const snapshot = item === undefined ? undefined : priorEvents.slice(0, planIndex).find(event => event.seq === item.snapshotSeq)
      if (item === undefined || snapshot?.type !== 'context/compiler-snapshot' || snapshot.data.id !== mutation.nodeId) return false
      const provenance = snapshot.data.provenance
      if (provenance?.provider !== 'contextify' || !provenance.sourceId
        || !Number.isSafeInteger(provenance.sourceSeq) || provenance.sourceSeq < 0
        || suffix !== String(provenance.sourceSeq)
        || provenance.contentHash !== createHash('sha256').update(JSON.stringify(snapshot.data.message)).digest('hex')) return false
      included.push(item)
    }
  }
  return JSON.stringify(nextPlan(before, { excluded, included, replacements: before.replacements })) === JSON.stringify(actual)
}

/** Project at most four complete approvals from owned, still-active native Plan history.
 * @param inspections - Actual family logs; inherited copies are excluded.
 * @param watermarks - Existing Profile reset cursors; raw logs are unchanged.
 * @param objective - Current goal selects up to two relevant cases before recent fill; omission returns recent history.
 * @returns Event-referenced choices corroborated by their historical Plan; never current destination authority.
 */
export function scopePolicyExamplesFromInspections(
  inspections: readonly ContextFamilyInspection[], watermarks: ReadonlyMap<SessionId, number>,
  objective?: string,
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
        || p.key !== policyKey(p, event.data.sourceBase ?? event.data.base, proposal.proposedNodeIds)
        || !appliedReviewMatches(inspection.events, inspection.inheritedEventCount + index - 1, event, previous)) continue
      const objective = Array.from(event.data.objective ?? '').slice(0, 200).join('')
      if (!objective.trim() || !Number.isFinite(event.time)) continue
      result.push(Object.freeze({ sourceSessionId: inspection.meta.id, sourceEventSeq: event.seq,
        at: event.time, objective, mode: p.mode, assignment: p.assignment }))
    }
  }
  const ordered = [...new Map(result.map(row => [`${row.sourceSessionId}:${String(row.sourceEventSeq)}`, row])).values()]
    .sort((a, b) => a.at - b.at || a.sourceSessionId.localeCompare(b.sourceSessionId) || a.sourceEventSeq - b.sourceEventSeq)
  if (objective === undefined) return Object.freeze(ordered.slice(-4))
  const relevant = ordered.map((row, index) => ({ row, index, score: jaccardOverlap(objective, row.objective) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index).slice(0, 2).map(item => item.row)
  const selected = [...new Set([...relevant, ...ordered.toReversed()])].slice(0, 4)
  return Object.freeze(ordered.filter(row => selected.includes(row)))
}

/** Identify temporary Excludes that the user accepted from an earlier review. */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/**
 * A later Agent may suggest restoring a reviewed Exclude, while direct user
 * exclusions and archived replacements remain protected. This reads only
 * source-identifiable, UI-confirmed events; it never changes the current Plan.
 * @param events - Native Session events containing the reviewed choices.
 * @param currentExcludedNodeIds - Nodes currently excluded by the Plan.
 * @param archivedNodeIds - Nodes with archived semantics that must stay protected.
 * @returns Reviewed temporary exclusions that may be proposed for restoration.
 */
export function reviewableRecommendationExclusions(
  events: readonly SessionEvent[],
  currentExcludedNodeIds: readonly string[],
  archivedNodeIds: readonly string[],
): readonly string[] {
  const archived = new Set(archivedNodeIds)
  const unresolved = new Set(currentExcludedNodeIds.filter(id => !archived.has(id)))
  const reviewable = new Set<string>()
  for (let index = events.length - 1; index >= 0 && unresolved.size > 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'contextify/node-choice') continue
    const matching = event.data.mutations.filter(mutation => unresolved.has(mutation.nodeId))
    if (matching.length === 0) continue
    const review = events[index + 1]
    for (const mutation of matching) {
      unresolved.delete(mutation.nodeId)
      if (event.data.origin !== 'recommendation' || !event.data.changed
        || event.data.uiOrigin !== 'contextify-client' || mutation.mode !== 'exclude'
        || review?.type !== 'contextify/recommendation-reviewed'
        || review.data.uiOrigin !== 'contextify-client'
        || review.data.base.planRevision !== event.data.beforePlanRevision
        || !review.data.acceptedNodeIds.includes(mutation.nodeId)) continue
      reviewable.add(mutation.nodeId)
    }
  }
  return currentExcludedNodeIds.filter(id => reviewable.has(id))
}

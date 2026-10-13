/** Explicit partial feedback from durable Context recommendation reviews. */
import type { ContextFamilyInspection } from './types.ts'

type ReviewEvent = Extract<ContextFamilyInspection['events'][number], {
  type: 'contextify/recommendation-reviewed' | 'contextify/recommendation-dismissed'
}>

/** One labeled item; omitted items remain undecided. */
export interface ContextReviewFeedback {
  readonly nodeId: string
  readonly action: 'include' | 'exclude'
  readonly choice: 'accept' | 'reject'
  readonly displayedIndex: number
  readonly weight: number
}

/**
 * Validate persisted review feedback without labeling unchosen alternatives.
 * @param event - A resolved sheet or explicit sheet closure from a native log.
 * @returns Ordered confirmed items, with total weight at most one per sheet.
 */
export function contextReviewFeedback(event: ReviewEvent): readonly ContextReviewFeedback[] {
  if (event.data.uiOrigin !== 'contextify-client') return []
  const selection = event.data.selection
  const ids = new Set(selection.map(item => item.nodeId))
  const declinedIds = event.data.declinedNodeIds ?? []
  const declined = new Set(declinedIds)
  const acceptedIds = event.type === 'contextify/recommendation-reviewed'
    ? event.data.acceptedNodeIds : []
  const accepted = new Set(acceptedIds)
  if (selection.length === 0 || ids.size !== selection.length
    || declined.size !== declinedIds.length || accepted.size !== acceptedIds.length
    || [...declined, ...accepted].some(id => !ids.has(id))
    || [...accepted].some(id => declined.has(id))
    || (event.type === 'contextify/recommendation-reviewed'
      && accepted.size + declined.size !== selection.length)) return []
  return selection.flatMap((item, displayedIndex) => {
    if (!accepted.has(item.nodeId) && !declined.has(item.nodeId)) return []
    return [{ ...item, choice: accepted.has(item.nodeId) ? 'accept' as const : 'reject' as const,
      displayedIndex, weight: 1 / selection.length }]
  })
}

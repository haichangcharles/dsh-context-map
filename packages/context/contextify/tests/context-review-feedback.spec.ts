import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { contextReviewFeedback } from '../src/context-review-feedback.ts'
import type { ContextFamilyInspection } from '../src/types.ts'

describe('explicit Context review feedback', () => {
  it('does not label an unmarked Remote dismissal as a user review', () => {
    const event: Extract<ContextFamilyInspection['events'][number], {
      type: 'contextify/recommendation-dismissed'
    }> = { seq: SessionSeq(0), time: 0, type: 'contextify/recommendation-dismissed', data: {
      mode: 'fast', base: { activeSessionId: SessionId('feedback'), planRevision: 1, graphRevision: 'g' },
      selection: [{ nodeId: 'page', action: 'include' }], archiveNodeIds: [], declinedNodeIds: ['page'],
    } }
    expect(contextReviewFeedback(event)).toEqual([])
  })
})

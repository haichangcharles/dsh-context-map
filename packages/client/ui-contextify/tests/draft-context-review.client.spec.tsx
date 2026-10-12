// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftContextReview } from '../src/client/DraftContextReview.tsx'

afterEach(cleanup)

const t = (key: string) => ({
  'action.reviewDraft': 'Review context for draft',
  'action.reviewingDraft': 'Reviewing context…',
}[key] ?? key)

describe('draft Context review', () => {
  it('runs only on explicit click and preserves the unsent draft', async () => {
    const review = vi.fn(async () => {})
    const openMap = vi.fn()
    const discard = vi.fn()
    const input = { draft: 'Use the earlier Web evidence', draftRev: 4, phase: 'plain' as const }
    const { rerender } = render(<DraftContextReview input={input} review={review}
      openMap={openMap} discard={discard} t={t as never} />)
    expect(review).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Review context for draft' }))
    await act(async () => {})
    expect(review).toHaveBeenCalledWith(input.draft)
    expect(openMap).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
    rerender(<DraftContextReview input={{ ...input, draft: '' }} review={review}
      openMap={openMap} discard={discard} t={t as never} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('drops a completed proposal if the draft changed while scoring', async () => {
    let resolve!: () => void
    const review = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const openMap = vi.fn()
    const discard = vi.fn()
    const input = { draft: 'Continue the old plan', draftRev: 1, phase: 'plain' as const }
    const { rerender } = render(<DraftContextReview input={input} review={review}
      openMap={openMap} discard={discard} t={t as never} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review context for draft' }))
    rerender(<DraftContextReview input={{ ...input, draft: 'Start a new outline', draftRev: 2 }}
      review={review} openMap={openMap} discard={discard} t={t as never} />)
    await act(async () => { resolve() })
    expect(discard).toHaveBeenCalledOnce()
    expect(openMap).not.toHaveBeenCalled()
  })
})

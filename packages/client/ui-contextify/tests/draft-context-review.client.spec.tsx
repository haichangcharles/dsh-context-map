// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stewardTestTranslator } from './test-locale.client.ts'
import { DraftContextReview } from '../src/client/DraftContextReview.tsx'

afterEach(cleanup)

const t = stewardTestTranslator()

describe('draft Context review', () => {
  it('runs only on explicit click and preserves the unsent draft', async () => {
    const review = vi.fn(async () => {})
    const openMap = vi.fn()
    const discard = vi.fn()
    const input = { draft: 'Use the earlier Web evidence', draftRev: 4,
      phase: 'plain' as const, attachmentIds: [], occurrences: [], queue: [] }
    const { rerender } = render(<DraftContextReview input={input} review={review}
      openMap={openMap} discard={discard} t={t} />)
    expect(review).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Review context for draft' }))
    await act(async () => {})
    expect(review).toHaveBeenCalledWith(input.draft, 'local')
    expect(openMap).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
    rerender(<DraftContextReview input={{ ...input, draft: '' }} review={review}
      openMap={openMap} discard={discard} t={t} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('makes Fast draft review explicit without scoring when opening its menu', async () => {
    const review = vi.fn(async () => {})
    const input = { draft: 'Compare these Web sources', draftRev: 4,
      phase: 'plain' as const, attachmentIds: [], occurrences: [], queue: [] }
    render(<DraftContextReview input={input} review={review} openMap={vi.fn()} discard={vi.fn()} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Draft review mode' }))
    expect(review).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fast review for draft' }))
    await act(async () => {})
    expect(review).toHaveBeenCalledWith(input.draft, 'fast')
  })

  it('drops a completed proposal if the draft changed while scoring', async () => {
    let resolve!: () => void
    const review = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const openMap = vi.fn()
    const discard = vi.fn()
    const input = { draft: 'Continue the old plan', draftRev: 1,
      phase: 'plain' as const, attachmentIds: [], occurrences: [], queue: [] }
    const { rerender } = render(<DraftContextReview input={input} review={review}
      openMap={openMap} discard={discard} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review context for draft' }))
    rerender(<DraftContextReview input={{ ...input, draft: 'Start a new outline', draftRev: 2 }}
      review={review} openMap={openMap} discard={discard} t={t} />)
    await act(async () => { resolve() })
    expect(discard).toHaveBeenCalledOnce()
    expect(openMap).not.toHaveBeenCalled()
  })
})

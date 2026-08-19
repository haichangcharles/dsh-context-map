// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { BranchSuggestionCard } from '../src/client/BranchSuggestionCard.tsx'

afterEach(cleanup)

const suggestion = {
  id: 'suggestion-1', sourceSessionId: 'source' as SessionId, turn: 2,
  boundaryBefore: 3, boundaryAfter: 7,
  input: { sessionId: 'source' as SessionId, seq: 4 },
  output: { sessionId: 'source' as SessionId, seq: 6 },
  inputPreview: 'side topic', outputPreview: 'side answer',
  confidence: 0.9, reason: 'Parallel topic', planRevision: 1, graphRevision: 'family-7',
}

describe('BranchSuggestionCard', () => {
  it('keeps the decision non-modal and moves only after explicit confirmation', async () => {
    const keep = vi.fn()
    const move = vi.fn(async () => {})
    render(<BranchSuggestionCard suggestion={suggestion} pending={false} keep={keep} move={move} />)
    expect(screen.getByText('Move this Q&A to a new branch?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move to new branch' }))
    await waitFor(() => { expect(move).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }))
    expect(keep).toHaveBeenCalledOnce()
  })
})

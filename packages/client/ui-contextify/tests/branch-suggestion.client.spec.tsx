// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { stewardTestTranslator } from './test-locale.client.ts'
import { BranchSuggestionCard } from '../src/client/BranchSuggestionCard.tsx'
import { BranchSuggestionTail } from '../src/client/BranchSuggestionTail.tsx'
import type { ContextifyControllerSnapshot } from '../src/client/controller.ts'

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
  it('shows Chinese controls without translating the Agent-authored reason', () => {
    render(<BranchSuggestionCard t={stewardTestTranslator('zh')} suggestion={suggestion}
      pending={false} keep={vi.fn(async () => {})} move={vi.fn(async () => {})} />)
    expect(screen.getByRole('complementary', { name: '分支建议' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '移到新分支' })).toBeTruthy()
    expect(screen.getByText('Parallel topic')).toBeTruthy()
  })

  it('keeps the decision non-modal and moves only after explicit confirmation', async () => {
    const keep = vi.fn(async () => {})
    const move = vi.fn(async () => {})
    render(<BranchSuggestionCard t={stewardTestTranslator()} suggestion={suggestion} pending={false} keep={keep} move={move} />)
    expect(screen.getByText('Move this Q&A to a new branch?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Move to new branch' }))
    await waitFor(() => { expect(move).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }))
    await waitFor(() => { expect(keep).toHaveBeenCalledOnce() })
  })

  it('renders through the matching completed turn tail and declines other turns', () => {
    const snapshot = {
      pending: false,
      view: { branchSuggestion: suggestion },
    } as ContextifyControllerSnapshot
    const useContextify = ((selector: (value: ContextifyControllerSnapshot) => unknown) =>
      selector(snapshot)) as SnapshotSelectorHook<ContextifyControllerSnapshot>
    const move = vi.fn(async () => {})
    const keep = vi.fn(async () => {})
    const { rerender } = render(
      <BranchSuggestionTail t={stewardTestTranslator()} matched={suggestion.output.seq} useContextify={useContextify}
        keepBranchSuggestion={keep} moveBranchSuggestion={move} />,
    )
    expect(screen.getByRole('complementary', { name: 'Branch suggestion' })).toBeTruthy()

    rerender(<BranchSuggestionTail t={stewardTestTranslator()} matched={suggestion.output.seq + 1} useContextify={useContextify}
      keepBranchSuggestion={keep} moveBranchSuggestion={move} />)
    expect(screen.queryByRole('complementary', { name: 'Branch suggestion' })).toBeNull()
  })

  it('keeps the card visible when recording Keep fails', async () => {
    const snapshot = { pending: false, view: { branchSuggestion: suggestion } } as ContextifyControllerSnapshot
    const useContextify = ((selector: (value: ContextifyControllerSnapshot) => unknown) =>
      selector(snapshot)) as SnapshotSelectorHook<ContextifyControllerSnapshot>
    const keep = vi.fn(async () => { throw new Error('Could not save choice') })
    render(<BranchSuggestionTail t={stewardTestTranslator()} matched={suggestion.output.seq} useContextify={useContextify}
      keepBranchSuggestion={keep} moveBranchSuggestion={vi.fn(async () => {})} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep here' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('Could not save choice') })
    expect(screen.getByRole('complementary', { name: 'Branch suggestion' })).toBeTruthy()
  })
})

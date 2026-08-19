/** Non-modal decision card shown beside the completed assistant output. */
import { useState } from 'react'
import type { ContextBranchSuggestion } from '@deepseek-ai/dsh-contextify/types'
import css from './BranchSuggestionCard.module.css'

export function BranchSuggestionCard({ suggestion, pending, keep, move }: {
  readonly suggestion: ContextBranchSuggestion
  readonly pending: boolean
  readonly keep: () => void
  readonly move: () => Promise<void>
}) {
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <aside className={css.card} aria-label="Branch suggestion">
    <strong>Move this Q&amp;A to a new branch?</strong>
    <p>{suggestion.reason}</p>
    <div>
      <button type="button" disabled={pending || moving} onClick={keep}>Keep here</button>
      <button type="button" disabled={pending || moving} onClick={() => {
        setMoving(true); setError(null)
        void move().catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause))
        })
          .finally(() => { setMoving(false) })
      }}>Move to new branch</button>
    </div>
    {error !== null && <p role="alert">{error}</p>}
  </aside>
}

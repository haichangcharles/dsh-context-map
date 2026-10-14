/** Non-modal decision card shown beside the completed assistant output. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import './locales.ts'
import { useState } from 'react'
import type { ContextBranchSuggestion } from '@deepseek-ai/dsh-contextify/types'
import css from './BranchSuggestionCard.module.css'

export function BranchSuggestionCard({ suggestion, pending, keep, move, t }: PropsLocale<'contextifySteward'> & {
  readonly suggestion: ContextBranchSuggestion
  readonly pending: boolean
  readonly keep: () => Promise<void>
  readonly move: () => Promise<void>
}) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<void>): void => {
    setWorking(true); setError(null)
    void action().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { setWorking(false) })
  }
  return <aside className={css.card} aria-label={t('copy.branchSuggestion')}>
    <strong>{t('copy.moveThisQAToANewBranch')}</strong>
    <p>{suggestion.reason}</p>
    <div>
      <button type="button" disabled={pending || working} onClick={() => { run(keep) }}>{t('copy.keepHere')}</button>
      <button type="button" disabled={pending || working} onClick={() => { run(move) }}>{t('copy.moveToNewBranch')}</button>
    </div>
    {error !== null && <p role="alert">{error}</p>}
  </aside>
}

/** Explicit, draft-bound Context review entry above the chat composer. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { InputZone } from '@deepseek-ai/dsh-client-ui-conversation/client'
import './steward-locales.ts'
import css from './DraftContextReview.module.css'

/** Actions supplied by the shared Contextify controller and right panel. */
export interface DraftContextReviewInjected {
  readonly review: (objective: string) => Promise<void>
  readonly discard: () => void
  readonly openMap: () => void
}

/** The owner draft is never submitted or rewritten by this review entry. */
export type DraftContextReviewProps = Pick<InputZone, 'input'>
  & DraftContextReviewInjected & PropsLocale<'contextifySteward'>

/**
 * Invoke bounded review only on click, invalidating advice if the draft moves.
 * @param props - Current composer draft and review-only Controller actions.
 * @returns A draft-scoped button or nothing when the composer is empty.
 */
export function DraftContextReview({ input, review, discard, openMap, t }: DraftContextReviewProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef(input)
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  inputRef.current = input
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const objective = input.draft.trim()
  if (objective.length === 0 || input.phase !== 'plain') return null
  const run = async () => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    const draftRevision = input.draftRev
    try {
      await review(objective)
      if (!mounted.current) return
      if (inputRef.current.draftRev !== draftRevision
        || inputRef.current.draft.trim() !== objective) {
        discard()
      } else openMap()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      pendingRef.current = false
      if (mounted.current) setPending(false)
    }
  }
  return <div className={css.dock} data-contextify-draft-review="true">
    <button className={css.action} type="button" disabled={pending} onClick={() => { void run() }}>
      {t(pending ? 'action.reviewingDraft' : 'action.reviewDraft')}
    </button>
    {error !== null && <span className={css.error} role="alert">{error}</span>}
  </div>
}

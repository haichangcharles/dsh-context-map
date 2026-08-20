/** In-flow Branch decision for one completed Harness Turn. */
import { memo, useState } from 'react'
import type { HostObservable, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextifyControllerSnapshot } from './controller.ts'
import { BranchSuggestionCard } from './BranchSuggestionCard.tsx'

export interface BranchSuggestionTailInjected {
  readonly hooks: { readonly contextify: HostObservable<ContextifyControllerSnapshot> }
  readonly moveBranchSuggestion: (suggestionId: string) => Promise<void>
}

type BranchSuggestionTailProps = InjectFace<BranchSuggestionTailInjected> & {
  /** Closing assistant sequence selected by the native turnTail slot. */
  readonly matched: number
}

/** Render only the suggestion owned by this exact completed assistant output. */
export const BranchSuggestionTail = memo(function BranchSuggestionTail({
  matched, useContextify, moveBranchSuggestion,
}: BranchSuggestionTailProps) {
  const [dismissedSuggestionId, setDismissedSuggestionId] = useState<string | null>(null)
  const snapshot = useContextify(value => value)
  const suggestion = snapshot.view?.branchSuggestion
  if (suggestion === undefined || suggestion.output.seq !== matched
    || suggestion.id === dismissedSuggestionId) return null
  return <BranchSuggestionCard
    suggestion={suggestion}
    pending={snapshot.pending}
    keep={() => { setDismissedSuggestionId(suggestion.id) }}
    move={() => moveBranchSuggestion(suggestion.id)}
  />
})

/** Chat-side controls over the same durable Context Plan as the graph. */
import { memo } from 'react'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMessageRef } from '@deepseek-ai/dsh-contextify/types'
import type { ContextifyControllerSnapshot } from './controller.ts'
import type { ContextNodeMode } from './ContextMapNode.tsx'
import css from './ContextMessageAction.module.css'

/** Injected controller source and mutations for either message-action slot. */
export interface ContextMessageActionInjected {
  readonly hooks: { readonly contextify: HostObservable<ContextifyControllerSnapshot> }
  readonly setNodeMode: (node: ContextMessageRef, mode: ContextNodeMode) => Promise<void>
  readonly locate: (nodeId: string) => void
}

interface ContextMessageActionProps extends Omit<ContextMessageActionInjected, 'hooks'> {
  readonly seq: number
  readonly useContextify: SnapshotSelectorHook<ContextifyControllerSnapshot>
}

/** Natural/Include/Exclude and locate actions beside one Chat message. */
export const ContextMessageAction = memo(function ContextMessageAction({
  seq, useContextify, setNodeMode, locate,
}: ContextMessageActionProps) {
  const snapshot = useContextify(value => value)
  const node = snapshot.graph?.nodes.find(candidate => candidate.activeEventSeq === seq)
  if (node === undefined) return null
  const mode: ContextNodeMode = snapshot.view?.plan.excluded.some(item => item.nodeId === node.id) === true
    ? 'exclude'
    : snapshot.view?.plan.included.some(item => item.nodeId === node.id) === true
      ? 'include'
      : 'natural'
  return <span className={css.root} aria-label={`Context for ${node.preview}`}>
    {(['natural', 'include', 'exclude'] as const).map(candidate => (
      <button
        type="button"
        key={candidate}
        data-active={mode === candidate || undefined}
        disabled={snapshot.pending || mode === candidate}
        aria-label={`${candidate} context for ${node.preview}`}
        onClick={() => { void setNodeMode(node.owner, candidate).catch(() => {}) }}
      >{candidate === 'natural' ? 'Auto' : candidate === 'include' ? 'Use' : 'Skip'}</button>
    ))}
    <button type="button" aria-label={`Locate ${node.preview} in Context Map`} onClick={() => { locate(node.id) }}>Map</button>
  </span>
})

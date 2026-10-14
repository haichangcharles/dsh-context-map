/** Chat-side controls over the same durable Context Plan as the graph. */
import { memo } from 'react'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { HostObservable, PropsLocale, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ContextMessageRef } from '@deepseek-ai/dsh-contextify/types'
import type { ContextifyControllerSnapshot } from './controller.ts'
import type { ContextNodeMode } from './ContextMapNode.tsx'
import './locales.ts'
import css from './ContextMessageAction.module.css'

/** Injected controller source and mutations for either message-action slot. */
export interface ContextMessageActionInjected {
  readonly hooks: { readonly contextify: HostObservable<ContextifyControllerSnapshot> }
  readonly setNodeMode: (node: ContextMessageRef, mode: ContextNodeMode) => Promise<void>
  readonly locate: (nodeId: string) => void
}

interface ContextMessageActionProps extends Omit<ContextMessageActionInjected, 'hooks'>, PropsLocale<'contextifySteward'> {
  readonly seq: number
  readonly useContextify: SnapshotSelectorHook<ContextifyControllerSnapshot>
}

/** Natural/Include/Exclude and locate actions beside one Chat message. */
export const ContextMessageAction = memo(function ContextMessageAction({
  seq, useContextify, setNodeMode, locate, t,
}: ContextMessageActionProps) {
  const node = useContextify(value => value.graph?.nodes.find(candidate => candidate.activeEventSeq === seq), deepEqualJson)
  const mode = useContextify((value): ContextNodeMode => value.view?.plan.excluded.some(item => item.nodeId === node?.id) === true
    ? 'exclude'
    : value.view?.plan.included.some(item => item.nodeId === node?.id) === true
      ? 'include'
      : 'natural')
  const pending = useContextify(value => value.pending)
  if (node === undefined) return null
  return <span className={css.root} aria-label={t('copy.contextFor', { p0: node.preview })}>
    {(['natural', 'include', 'exclude'] as const).map(candidate => (
      <button
        type="button"
        key={candidate}
        data-active={mode === candidate || undefined}
        disabled={pending || mode === candidate}
        aria-label={t('copy.contextFor2', { p0: candidate, p1: node.preview })}
        onClick={() => { void setNodeMode(node.owner, candidate).catch(() => {}) }}
      >{candidate === 'natural' ? t('copy.auto') : candidate === 'include' ? t('copy.use') : t('copy.skip')}</button>
    ))}
    <button type="button" aria-label={t('copy.locateInContextMap', { p0: node.preview })} onClick={() => { locate(node.id) }}>{t('copy.map')}</button>
  </span>
})

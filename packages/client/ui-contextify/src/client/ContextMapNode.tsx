/** One message-level Context Map node rendered inside React Flow. */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ContextFamilyGraphNode, ContextMessageRef } from '@deepseek-ai/dsh-contextify/types'
import css from './ContextMapPanel.module.css'

export type ContextNodeMode = 'natural' | 'include' | 'exclude'

/** Renderer data attached after deterministic layout. */
export interface ContextMapNodeData extends Record<string, unknown> {
  readonly record: ContextFamilyGraphNode
  readonly mode: ContextNodeMode
  readonly sessionLabel: string
  readonly active: boolean
  readonly focused: boolean
  readonly searchMatch: boolean
  readonly onMode: (ref: ContextMessageRef, mode: ContextNodeMode) => void
  readonly onBranch: (record: ContextFamilyGraphNode) => void
  readonly onNavigate: (record: ContextFamilyGraphNode) => void
  readonly onLocate: (record: ContextFamilyGraphNode) => void
}

/** Compact role, preview, Session, status, and direct actions card. */
export const ContextMapNode = memo(function ContextMapNode({ data, selected, sourcePosition, targetPosition }: NodeProps) {
  const value = data as ContextMapNodeData
  const record = value.record
  const preview = record.preview || '(empty message)'
  return (
    <article
      className={css.mapNode}
      aria-label={`${record.role === 'user' ? 'User' : 'Assistant'} message: ${preview}`}
      data-role={record.role}
      data-mode={value.mode}
      data-active={value.active || undefined}
      data-focused={value.focused || undefined}
      data-search-match={value.searchMatch || undefined}
      data-selected={selected || undefined}
    >
      <Handle type="target" position={targetPosition ?? Position.Top} className={css.handle} />
      <header className={css.nodeHeader}>
        <span className={css.role}>{record.role === 'user' ? 'User' : 'Assistant'}</span>
        <span className={css.modeBadge}>{value.mode}</span>
      </header>
      <p className={css.preview} data-preview={preview} aria-hidden="true" />
      <div className={css.nodeMeta}>{value.sessionLabel}</div>
      <div className={`${css.nodeActions} nodrag nopan`}>
        {(['natural', 'include', 'exclude'] as const).map(mode => (
          <button
            type="button"
            key={mode}
            disabled={value.mode === mode}
            aria-label={`${mode.charAt(0).toUpperCase()}${mode.slice(1)} ${record.preview}`}
            onClick={() => { value.onMode(record.owner, mode) }}
          >{mode}</button>
        ))}
        <button type="button" onClick={() => { value.onNavigate(record) }}>Open</button>
        <button type="button" onClick={() => { value.onLocate(record) }}>Locate</button>
        <button
          type="button"
          disabled={record.branchAtSeq === null}
          aria-label={`Branch from ${record.preview}`}
          onClick={() => { value.onBranch(record) }}
        >Branch</button>
      </div>
      <Handle type="source" position={sourcePosition ?? Position.Bottom} className={css.handle} />
    </article>
  )
})

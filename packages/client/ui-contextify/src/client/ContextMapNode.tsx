/** One message-level Context Map node rendered inside React Flow. */
import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import css from './ContextMapPanel.module.css'
import type { CanvasPoint } from './canvas-interactions.ts'

export type ContextNodeMode = 'natural' | 'include' | 'exclude'

/** Renderer data attached after deterministic layout. */
export interface ContextMapNodeData extends Record<string, unknown> {
  readonly record: ContextFamilyGraphNode
  readonly mode: ContextNodeMode
  readonly included: boolean
  readonly pending: boolean
  readonly sessionLabel: string
  readonly active: boolean
  readonly focused: boolean
  readonly searchMatch: boolean
  readonly recommendation?: 'include' | 'exclude' | 'cleanup'
  readonly onActivate: (record: ContextFamilyGraphNode) => void
  readonly onIncludedChange: (record: ContextFamilyGraphNode, included: boolean) => void
  readonly onContextMenu: (record: ContextFamilyGraphNode, point: CanvasPoint) => void
}

/** Compact role, preview, Session, status, and direct actions card. */
export const ContextMapNode = memo(function ContextMapNode({ data, selected, sourcePosition, targetPosition }: NodeProps) {
  const value = data as ContextMapNodeData
  const record = value.record
  const emptyPlaceholder = record.replacement !== undefined
  const preview = emptyPlaceholder ? '' : record.preview || '(empty message)'
  const role = record.role === 'user' ? 'User' : 'Assistant'
  return (
    <article
      className={css.mapNode}
      aria-label={emptyPlaceholder ? `${role} empty placeholder` : `${role} message: ${preview}`}
      data-role={record.role}
      data-mode={value.mode}
      data-included={value.included || undefined}
      data-active={value.active || undefined}
      data-focused={value.focused || undefined}
      data-search-match={value.searchMatch || undefined}
      data-selected={selected || undefined}
      data-context-node-id={record.id}
      data-replacement={record.replacement === undefined ? undefined : 'placeholder'}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        value.onContextMenu(record, { x: event.clientX, y: event.clientY })
      }}
    >
      <Handle type="target" position={targetPosition ?? Position.Top} className={css.handle} />
      <header className={css.nodeHeader}>
        <span className={css.role}>{record.role === 'user' ? 'User' : 'Assistant'}</span>
        <label
          className={`${css.contextCheckbox} nodrag nopan`}
          onPointerDown={(event) => { event.stopPropagation() }}
          onClick={(event) => { event.stopPropagation() }}
        >
          <input
            type="checkbox"
            checked={value.included}
            disabled={value.pending}
            aria-label={emptyPlaceholder ? `Include ${role.toLocaleLowerCase()} empty placeholder in context` : `Include ${preview} in context`}
            onChange={(event) => { value.onIncludedChange(record, event.target.checked) }}
          />
          <span aria-hidden="true">Context</span>
        </label>
      </header>
      <p className={css.preview} data-preview={preview} aria-hidden="true" />
      {(value.recommendation !== undefined || record.replacement !== undefined) && <div className={css.nodeBadges}>
        {value.recommendation !== undefined && <span data-recommendation={value.recommendation}>
          {value.recommendation === 'include' ? 'Suggested include' : value.recommendation === 'exclude' ? 'Suggested exclude' : 'Cleanup suggested'}
        </span>}
        {record.replacement !== undefined && <span data-replacement-badge="">Original retained</span>}
      </div>}
      <div className={css.nodeMeta}>{value.sessionLabel}</div>
      <Handle type="source" position={sourcePosition ?? Position.Bottom} className={css.handle} />
    </article>
  )
})

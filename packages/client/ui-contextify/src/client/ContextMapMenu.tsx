import type { ContextFamilyGraphNode, ContextMessageRef } from '@deepseek-ai/dsh-contextify/types'
import type { CanvasPoint } from './canvas-interactions.ts'
import type { ContextNodeMode } from './ContextMapNode.tsx'
import css from './ContextMapPanel.module.css'

export interface ContextMapMenuProps {
  readonly point: CanvasPoint
  readonly record: ContextFamilyGraphNode
  readonly mode: ContextNodeMode
  readonly close: () => void
  readonly locate: (record: ContextFamilyGraphNode) => void
  readonly branch: (record: ContextFamilyGraphNode) => Promise<void>
  readonly setNodeMode: (node: ContextMessageRef, mode: ContextNodeMode) => Promise<void>
}

/** Pointer-positioned node actions backed only by Harness-native operations. */
export function ContextMapMenu({
  point, record, mode, close, locate, branch, setNodeMode,
}: ContextMapMenuProps) {
  const run = (action: () => void | Promise<void>): void => {
    try {
      void Promise.resolve(action()).catch(() => {})
    } finally {
      close()
    }
  }
  return (
    <div
      role="menu"
      aria-label="Message actions"
      className={`${css.contextMenu} nodrag nopan`}
      style={{ left: point.x, top: point.y }}
      onClick={(event) => { event.stopPropagation() }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
    >
      <button type="button" role="menuitem" onClick={() => { run(() => { locate(record) }) }}>Locate in Chat</button>
      <button
        type="button"
        role="menuitem"
        disabled={record.branchAtSeq === null}
        onClick={() => { run(() => branch(record)) }}
      >Branch from Here</button>
      <div className={css.contextMenuSeparator} />
      {(['natural', 'include', 'exclude'] as const).map(candidate => (
        <button
          type="button"
          role="menuitem"
          key={candidate}
          disabled={mode === candidate}
          onClick={() => { run(() => setNodeMode(record.owner, candidate)) }}
        >{candidate.charAt(0).toUpperCase() + candidate.slice(1)}</button>
      ))}
    </div>
  )
}

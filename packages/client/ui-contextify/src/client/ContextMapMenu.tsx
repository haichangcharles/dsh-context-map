import type { ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import type { CanvasPoint } from './canvas-interactions.ts'
import type { ContextNodeMode } from './ContextMapNode.tsx'
import css from './ContextMapPanel.module.css'

export interface ContextMapMenuProps {
  readonly point: CanvasPoint
  readonly record: ContextFamilyGraphNode
  readonly mode: ContextNodeMode
  readonly pending: boolean
  readonly close: () => void
  readonly locate: (record: ContextFamilyGraphNode) => void
  readonly branch: (record: ContextFamilyGraphNode) => Promise<void>
  readonly restoreAutomatic: (record: ContextFamilyGraphNode) => void
  readonly showOriginal: (record: ContextFamilyGraphNode) => void
  readonly restoreOriginal: (record: ContextFamilyGraphNode) => void
  readonly reportError: (cause: unknown) => void
}

/** Pointer-positioned node actions backed only by Harness-native operations. */
export function ContextMapMenu({
  point, record, mode, pending, close, locate, branch, restoreAutomatic, showOriginal, restoreOriginal, reportError,
}: ContextMapMenuProps) {
  const run = (action: () => void | Promise<void>): void => {
    try {
      void Promise.resolve(action()).catch(reportError)
    } catch (cause) {
      reportError(cause)
    } finally {
      close()
    }
  }
  return (
    <div
      role="menu"
      aria-label="Message actions"
      data-context-map-menu=""
      className={`${css.contextMenu} nodrag nopan`}
      style={{ left: point.x, top: point.y }}
      onPointerDown={(event) => { event.stopPropagation() }}
      onClick={(event) => { event.stopPropagation() }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
    >
      <button type="button" role="menuitem" onClick={() => { run(() => { locate(record) }) }}>Locate in Chat</button>
      <button
        type="button"
        role="menuitem"
        disabled={pending || record.branchAtSeq === null}
        onClick={() => { run(() => branch(record)) }}
      >Branch from Here</button>
      {record.replacement !== undefined && <>
        <div className={css.contextMenuSeparator} />
        <button type="button" role="menuitem" onClick={() => { run(() => { showOriginal(record) }) }}>Show original</button>
        <button type="button" role="menuitem" disabled={pending} onClick={() => { run(() => { restoreOriginal(record) }) }}>Restore original</button>
      </>}
      {mode !== 'natural' && <>
        <div className={css.contextMenuSeparator} />
        <button
          type="button"
          role="menuitem"
          disabled={pending}
          onClick={() => { run(() => { restoreAutomatic(record) }) }}
        >Restore automatic</button>
      </>}
    </div>
  )
}

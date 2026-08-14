import { useCallback, useEffect, useState } from 'react'
import css from './ContextMapPanel.module.css'

export interface ContextMapPath {
  id: string
  parentPathId: string | null
  anchorSeq: number | null
  label: string
  status: 'active' | 'archived'
}

export interface ContextMapView {
  plan: {
    revision: number
    mainlinePathId: string
    activePathId: string
    paths: readonly ContextMapPath[]
    overrides: readonly { seq: number; mode: 'include' | 'exclude' }[]
  }
  graphAsOfSeq: number
  activeTipSeq: number | null
  selectedCount: number
  totalNodeCount: number
}

export interface ContextMapRecord {
  seq: number
  parentSeq: number | null
  pathId: string
  turn: number | null
  role: 'user' | 'assistant'
  sourceKind: string
  locked: boolean
  preview: string
}

export interface ContextMapPanelActions {
  load: () => Promise<{ view: ContextMapView; records: readonly ContextMapRecord[] }>
  createBranch: (seq: number, revision: number) => Promise<void>
  selectPath: (pathId: string, revision: number) => Promise<void>
  returnToMainline: (revision: number) => Promise<void>
  setNodeMode: (seq: number, mode: 'natural' | 'include' | 'exclude', revision: number) => Promise<void>
  close: () => void
}

export function ContextMapPanel({ actions }: { actions: ContextMapPanelActions }) {
  const [data, setData] = useState<Awaited<ReturnType<ContextMapPanelActions['load']>>>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const reload = useCallback(async (clearError = true) => {
    try {
      setData(await actions.load())
      if (clearError) setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [actions])
  useEffect(() => {
    void reload()
    // Session graph events stream independently from this feature's mutation
    // calls. A small bounded refresh keeps the pinned map current while the
    // assistant is replying without coupling Contextify to chat internals.
    const timer = globalThis.setInterval(() => { void reload(false) }, 1_500)
    return () => { globalThis.clearInterval(timer) }
  }, [reload])

  const mutate = async (operation: () => Promise<void>): Promise<void> => {
    setPending(true)
    try {
      await operation()
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }
  const revision = data?.view.plan.revision ?? 0
  const override = new Map(data?.view.plan.overrides.map(item => [item.seq, item.mode]))

  return <section className={css.root} aria-label="Context Map">
    <header className={css.header}>
      <div>
        <h2>Context Map</h2>
        <p>{data === undefined ? 'Loading context…' : `${data.view.selectedCount} / ${data.view.totalNodeCount} selected`}</p>
      </div>
      <button type="button" className={css.iconButton} aria-label="Close Context Map" onClick={actions.close}>×</button>
    </header>
    {error !== undefined && <div className={css.error} role="alert">{error}</div>}
    {data !== undefined && <>
      <nav className={css.paths} aria-label="Context paths">
        {data.view.plan.paths.filter(path => path.status === 'active').map(path =>
          <button
            type="button" key={path.id} disabled={pending}
            className={path.id === data.view.plan.activePathId ? css.activePath : css.path}
            onClick={() => { void mutate(() => actions.selectPath(path.id, revision)) }}
          >{path.label}</button>)}
        {data.view.plan.activePathId !== data.view.plan.mainlinePathId &&
          <button type="button" disabled={pending} className={css.mainline} aria-label="Return to mainline"
            onClick={() => { void mutate(() => actions.returnToMainline(revision)) }}>↩ Main</button>}
      </nav>
      <div className={css.canvas}>
        {data.records.map((node) => {
          const mode = override.get(node.seq) ?? 'natural'
          const active = node.pathId === data.view.plan.activePathId
          return <article key={node.seq} className={css.node} data-active={active || undefined} data-mode={mode}>
            <div className={css.nodeMeta}><span>#{node.seq}</span><span>{node.role}</span><span>{node.pathId}</span></div>
            <p>{node.preview || '(empty message)'}</p>
            <div className={css.actions}>
              {(['natural', 'include', 'exclude'] as const).map(next =>
                <button type="button" key={next} disabled={pending || node.locked || mode === next}
                  aria-label={`${next.charAt(0).toUpperCase()}${next.slice(1)} ${node.preview}`}
                  onClick={() => { void mutate(() => actions.setNodeMode(node.seq, next, revision)) }}>{next}</button>)}
              <button type="button" disabled={pending || node.locked}
                aria-label={`Branch from ${node.preview}`}
                onClick={() => { void mutate(() => actions.createBranch(node.seq, revision)) }}>Branch</button>
            </div>
          </article>
        })}
      </div>
    </>}
  </section>
}

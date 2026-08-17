/** Interactive React Flow surface for one native Session Context Map. */
import { useEffect, useMemo, useState } from 'react'
import {
  Background, Controls, MarkerType, ReactFlow, SelectionMode,
  type Edge, type NodeChange, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  ContextFamilyGraphNode, ContextMessageRef, ContextNodeMutation,
} from '@deepseek-ai/dsh-contextify/types'
import type { HostObservable, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { ContextMapNode, type ContextMapNodeData, type ContextNodeMode } from './ContextMapNode.tsx'
import type { ContextifyControllerSnapshot } from './controller.ts'
import { layoutContextMap } from './layout.ts'
import { createContextMapStore } from './store.ts'
import css from './ContextMapPanel.module.css'

/** Model-changing and navigation actions shared with Chat controls. */
export interface ContextMapActions {
  setNodeMode: (node: ContextMessageRef, mode: ContextNodeMode) => Promise<void>
  setNodeModes: (mutations: readonly ContextNodeMutation[]) => Promise<void>
  reset: () => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  branch: (node: ContextFamilyGraphNode) => Promise<void>
  navigate: (node: ContextFamilyGraphNode) => void
  locate: (nodeId: string) => void
  close: () => void
}

/** Slot-injected controller source and ordinary action face. */
export interface ContextMapPanelInjected {
  readonly hooks: { readonly contextify: HostObservable<ContextifyControllerSnapshot> }
  readonly mapActions: ContextMapActions
}

/** Props after the slot runtime binds the controller and viewing store hooks. */
export type ContextMapPanelProps =
  PropsStore<ReturnType<typeof createContextMapStore>>
  & Omit<ContextMapPanelInjected, 'hooks'>
  & { readonly useContextify: SnapshotSelectorHook<ContextifyControllerSnapshot> }

const nodeTypes = { contextMessage: ContextMapNode }
const EMPTY_NODES: readonly ContextFamilyGraphNode[] = []

function ignoreHandledError(operation: Promise<void>): void {
  void operation.catch(() => {})
}

function modeOf(snapshot: ContextifyControllerSnapshot, node: ContextFamilyGraphNode): ContextNodeMode {
  const plan = snapshot.view?.plan
  if (plan?.excluded.some(item => item.nodeId === node.id) === true) return 'exclude'
  if (plan?.included.some(item => item.nodeId === node.id) === true) return 'include'
  return 'natural'
}

/** The pinned header, graph canvas, search, layouts, history, and batch controls. */
export function ContextMapPanel({ useContextify, useStore, actions, mapActions }: ContextMapPanelProps) {
  const snapshot = useContextify(value => value)
  const layout = useStore(value => value.layout)
  const selectedNodeIds = useStore(value => value.selectedNodeIds)
  const positionOverrides = useStore(value => value.positionOverrides)
  const [query, setQuery] = useState('')
  const [resultIndex, setResultIndex] = useState(0)
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null)
  const graph = snapshot.graph
  const records = graph?.nodes ?? EMPTY_NODES
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searchResultIds = useMemo(() => normalizedQuery === ''
    ? []
    : records.filter(node => node.preview.toLocaleLowerCase().includes(normalizedQuery)).map(node => node.id),
  [normalizedQuery, records])
  const activeSearchId = searchResultIds.length === 0
    ? undefined
    : searchResultIds[resultIndex % searchResultIds.length]

  useEffect(() => {
    actions.retainNodeIds(records.map(node => node.id))
  }, [actions, records])
  useEffect(() => { setResultIndex(0) }, [normalizedQuery])
  useEffect(() => {
    const target = snapshot.focusedNodeId ?? activeSearchId
    if (target === undefined || instance === null) return
    void instance.fitView({ nodes: [{ id: target }], duration: 220, maxZoom: 1.2 })
  }, [activeSearchId, instance, snapshot.focusedNodeId])

  const flowNodes = useMemo(() => {
    if (graph === undefined) return []
    const searchMatches = new Set(searchResultIds)
    const selected = new Set(selectedNodeIds)
    const sessions = new Map(graph.sessions.map(session => [session.id, session]))
    return layoutContextMap(graph.nodes, graph.edges, layout).map((node) => {
      const record = node.data.record
      const session = sessions.get(record.owner.sessionId)
      const data: ContextMapNodeData = {
        record,
        mode: modeOf(snapshot, record),
        sessionLabel: session?.depth === 0 ? 'Root Session' : `Branch Session · depth ${String(session?.depth ?? 0)}`,
        active: record.sessionIds.includes(graph.activeSessionId),
        focused: snapshot.focusedNodeId === record.id || activeSearchId === record.id,
        searchMatch: searchMatches.has(record.id),
        onMode: (ref, mode) => { ignoreHandledError(mapActions.setNodeMode(ref, mode)) },
        onBranch: (candidate) => { ignoreHandledError(mapActions.branch(candidate)) },
        onNavigate: mapActions.navigate,
        onLocate: (candidate) => { mapActions.locate(candidate.id) },
      }
      return {
        ...node,
        data,
        selected: selected.has(node.id),
        position: positionOverrides[node.id] ?? node.position,
      }
    })
  }, [activeSearchId, graph, layout, mapActions, positionOverrides, searchResultIds, selectedNodeIds, snapshot])

  const flowEdges = useMemo((): Edge[] => (graph?.edges ?? []).map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  })), [graph])

  const onNodesChange = (changes: Array<NodeChange>): void => {
    for (const change of changes) {
      if (change.type === 'select') actions.setNodeSelected(change.id, change.selected)
      if (change.type === 'position' && change.position !== undefined && change.dragging === false) {
        actions.setPosition(change.id, change.position)
      }
    }
  }
  const selectedRecords = records.filter(record => selectedNodeIds.includes(record.id))
  const batch = (mode: ContextNodeMode): void => {
    ignoreHandledError(mapActions.setNodeModes(selectedRecords.map(record => ({ node: record.owner, mode }))))
  }
  const stepSearch = (delta: -1 | 1): void => {
    if (searchResultIds.length === 0) return
    setResultIndex(index => (index + delta + searchResultIds.length) % searchResultIds.length)
  }

  return (
    <section className={css.root} aria-label="Context Map">
      <header className={css.header}>
        <div>
          <h2>Context Map</h2>
          <p>{snapshot.view === undefined
            ? 'Loading context…'
            : `${String(snapshot.view.selectedCount)} / ${String(snapshot.view.totalNodeCount)} selected`}</p>
        </div>
        <button type="button" className={css.iconButton} aria-label="Close Context Map" onClick={mapActions.close}>×</button>
      </header>
      <div className={css.toolbar}>
        <label className={css.searchBox}>
          <span className={css.visuallyHidden}>Search Context Map</span>
          <input
            aria-label="Search Context Map"
            value={query}
            placeholder="Search messages"
            onChange={(event) => { setQuery(event.target.value) }}
          />
          <span>{searchResultIds.length === 0 ? '0 / 0' : `${String(resultIndex + 1)} / ${String(searchResultIds.length)}`}</span>
        </label>
        <button type="button" aria-label="Previous search result" onClick={() => { stepSearch(-1) }}>↑</button>
        <button type="button" aria-label="Next search result" onClick={() => { stepSearch(1) }}>↓</button>
      </div>
      <div className={css.toolbar} aria-label="Context Map layout">
        {(['tree', 'mindmap', 'timeline'] as const).map(mode => (
          <button
            type="button"
            key={mode}
            aria-pressed={layout === mode}
            aria-label={`${mode} layout`}
            onClick={() => { actions.setLayout(mode); actions.clearPositions() }}
          >{mode === 'mindmap' ? 'Mind map' : mode.charAt(0).toUpperCase() + mode.slice(1)}</button>
        ))}
        <span className={css.toolbarSpacer} />
        <button type="button" disabled={snapshot.pending} onClick={() => { ignoreHandledError(mapActions.reset()) }}>Reset</button>
        <button type="button" disabled={snapshot.pending || snapshot.view?.canUndo !== true} onClick={() => { ignoreHandledError(mapActions.undo()) }}>Undo</button>
        <button type="button" disabled={snapshot.pending || snapshot.view?.canRedo !== true} onClick={() => { ignoreHandledError(mapActions.redo()) }}>Redo</button>
      </div>
      {snapshot.error !== undefined && <div className={css.error} role="alert">{snapshot.error}</div>}
      <div className={css.canvas} data-layout={layout}>
        {graph !== undefined && (
          <ReactFlow
            key={layout}
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onInit={setInstance}
            fitView
            minZoom={0.18}
            maxZoom={1.8}
            nodesDraggable
            elementsSelectable
            selectionOnDrag
            selectionMode={SelectionMode.Partial}
            panOnScroll
            multiSelectionKeyCode={['Meta', 'Control']}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
        {snapshot.phase === 'loading' && <div className={css.empty}>Loading Context Map…</div>}
        {snapshot.phase !== 'loading' && records.length === 0 && <div className={css.empty}>No message nodes yet.</div>}
      </div>
      {selectedRecords.length > 0 && (
        <div className={css.selectionBar} aria-label="Selected message actions">
          <strong>{selectedRecords.length} selected</strong>
          <button type="button" onClick={() => { batch('include') }}>Include selected</button>
          <button type="button" onClick={() => { batch('exclude') }}>Exclude selected</button>
          <button type="button" onClick={() => { batch('natural') }}>Natural selected</button>
          <button type="button" onClick={() => { actions.clearSelection() }}>Clear</button>
        </div>
      )}
    </section>
  )
}

export type { ContextMapLayout } from './store.ts'

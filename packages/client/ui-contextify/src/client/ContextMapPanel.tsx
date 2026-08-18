/** Interactive React Flow surface for one native Session Context Map. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, Controls, MarkerType, ReactFlow,
  type Edge, type NodeChange, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  ContextFamilyGraphNode, ContextMessageRef, ContextNodeMutation,
} from '@deepseek-ai/dsh-contextify/types'
import type { WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { projectUnarchivedContextFamily } from './archived-family.ts'
import { ContextMapNode, type ContextMapNodeData, type ContextNodeMode } from './ContextMapNode.tsx'
import {
  effectiveContextIncluded, intersects, modeForEffectiveContext, reducePositionChanges, type CanvasPoint,
} from './canvas-interactions.ts'
import { ContextMapMenu } from './ContextMapMenu.tsx'
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
  locate: (node: ContextFamilyGraphNode) => void
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
  & {
    readonly useContextify: SnapshotSelectorHook<ContextifyControllerSnapshot>
    readonly useWorkspaces: SnapshotSelectorHook<WorkspaceListState>
  }

const nodeTypes = { contextMessage: ContextMapNode }
const EMPTY_NODES: readonly ContextFamilyGraphNode[] = []

interface MarqueeState {
  readonly pointerId: number
  readonly start: CanvasPoint
  readonly current: CanvasPoint
}

interface ContextMenuState {
  readonly record: ContextFamilyGraphNode
  readonly point: CanvasPoint
}

function modeOf(snapshot: ContextifyControllerSnapshot, node: ContextFamilyGraphNode): ContextNodeMode {
  const plan = snapshot.view?.plan
  if (plan?.excluded.some(item => item.nodeId === node.id) === true) return 'exclude'
  if (plan?.included.some(item => item.nodeId === node.id) === true) return 'include'
  return 'natural'
}

/** The pinned header, tree canvas, search, history, and batch controls. */
export function ContextMapPanel({
  useContextify, useWorkspaces, useStore, actions, mapActions,
}: ContextMapPanelProps) {
  const snapshot = useContextify(value => value)
  const archivedSessionIds = useWorkspaces(value => value.archivedSessionIds)
  const selectedNodeIds = useStore(value => value.selectedNodeIds)
  const positionOverrides = useStore(value => value.positionOverrides)
  const [query, setQuery] = useState('')
  const [resultIndex, setResultIndex] = useState(0)
  const [instance, setInstance] = useState<ReactFlowInstance | null>(null)
  const [interactionMode, setInteractionMode] = useState<'normal' | 'selection'>('normal')
  const [marquee, setMarquee] = useState<MarqueeState | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null)
  const [optimisticModes, setOptimisticModes] = useState<Record<string, ContextNodeMode>>({})
  const [transientPositions, setTransientPositions] = useState<Record<string, CanvasPoint>>({})
  const [measurementVersion, setMeasurementVersion] = useState(0)
  const canvasRef = useRef<HTMLDivElement>(null)
  const graph = useMemo(() => snapshot.graph === undefined
    ? undefined
    : projectUnarchivedContextFamily(snapshot.graph, archivedSessionIds), [archivedSessionIds, snapshot.graph])
  const records = graph?.nodes ?? EMPTY_NODES
  const mutationPending = snapshot.pending || pendingNodeId !== null
  const visibleSelectedCount = graph === undefined ? 0 : records.filter((record) => {
    const mode = optimisticModes[record.id] ?? modeOf(snapshot, record)
    return effectiveContextIncluded(record.sessionIds.includes(graph.activeSessionId), mode)
  }).length
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searchResultIds = useMemo(() => normalizedQuery === ''
    ? []
    : records.filter(node => node.preview.toLocaleLowerCase().includes(normalizedQuery)).map(node => node.id),
  [normalizedQuery, records])
  const activeSearchId = searchResultIds.length === 0
    ? undefined
    : searchResultIds[resultIndex % searchResultIds.length]

  const runMutation = useCallback((
    id: string,
    operation: () => Promise<void>,
    optimisticMode?: ContextNodeMode,
  ): void => {
    if (snapshot.pending || pendingNodeId !== null) return
    setActionError(null)
    setPendingNodeId(id)
    if (optimisticMode !== undefined) {
      setOptimisticModes(current => ({ ...current, [id]: optimisticMode }))
    }
    void operation()
      .catch((cause: unknown) => {
        setActionError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        setPendingNodeId(null)
        if (optimisticMode !== undefined) {
          setOptimisticModes(current => Object.fromEntries(
            Object.entries(current).filter(([candidate]) => candidate !== id),
          ))
        }
      })
  }, [pendingNodeId, snapshot.pending])

  const setEffectiveMode = useCallback((record: ContextFamilyGraphNode, included: boolean): void => {
    if (graph === undefined) return
    const active = record.sessionIds.includes(graph.activeSessionId)
    const mode = modeForEffectiveContext(active, included)
    runMutation(record.id, () => mapActions.setNodeMode(record.owner, mode), mode)
  }, [graph, mapActions, runMutation])

  useEffect(() => {
    if (snapshot.graph === undefined) return
    actions.reconcileNodeIds(
      records.map(node => node.id),
      snapshot.graph.nodes.map(node => node.id),
    )
  }, [actions, records, snapshot.graph])
  useEffect(() => { setResultIndex(0) }, [normalizedQuery])
  useEffect(() => {
    if (menu === null) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [menu])
  useEffect(() => {
    if (measurementVersion === 0 || instance === null || records.length === 0) return
    const timer = window.setTimeout(() => {
      const target = snapshot.focusedNodeId ?? activeSearchId
      if (target === undefined) {
        void instance.fitView({ duration: 220 })
        return
      }
      void instance.fitView({ nodes: [{ id: target }], duration: 220, maxZoom: 1.2 })
    }, 300)
    return () => { window.clearTimeout(timer) }
  }, [activeSearchId, instance, measurementVersion, records.length, snapshot.focusedNodeId])

  const flowNodes = useMemo(() => {
    if (graph === undefined) return []
    const searchMatches = new Set(searchResultIds)
    const selected = new Set(selectedNodeIds)
    const sessions = new Map(graph.sessions.map(session => [session.id, session]))
    return layoutContextMap(graph.nodes, graph.edges, 'tree').map((node) => {
      const record = node.data.record
      const session = sessions.get(record.owner.sessionId)
      const mode = optimisticModes[record.id] ?? modeOf(snapshot, record)
      const active = record.sessionIds.includes(graph.activeSessionId)
      const data: ContextMapNodeData = {
        record,
        mode,
        included: effectiveContextIncluded(active, mode),
        pending: mutationPending,
        sessionLabel: session?.depth === 0 ? 'Root Session' : `Branch Session · depth ${String(session?.depth ?? 0)}`,
        active,
        focused: snapshot.focusedNodeId === record.id || activeSearchId === record.id,
        searchMatch: searchMatches.has(record.id),
        onActivate: (candidate) => {
          if (interactionMode === 'selection') {
            actions.setNodeSelected(candidate.id, !selected.has(candidate.id))
          }
        },
        onIncludedChange: setEffectiveMode,
        onContextMenu: (candidate, screenPoint) => {
          const bounds = canvasRef.current?.getBoundingClientRect()
          if (bounds === undefined) return
          setActionError(null)
          setMenu({
            record: candidate,
            point: {
              x: Math.max(8, Math.min(screenPoint.x - bounds.left, bounds.width - 196)),
              y: Math.max(8, Math.min(screenPoint.y - bounds.top, bounds.height - 220)),
            },
          })
        },
      }
      return {
        ...node,
        data,
        selected: selected.has(node.id),
        position: transientPositions[node.id] ?? positionOverrides[node.id] ?? node.position,
      }
    })
  }, [
    actions, activeSearchId, graph, interactionMode, mutationPending, optimisticModes,
    positionOverrides, searchResultIds, selectedNodeIds, setEffectiveMode, snapshot, transientPositions,
  ])

  const flowEdges = useMemo((): Edge[] => (graph?.edges ?? []).map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  })), [graph])

  const onNodesChange = (changes: Array<NodeChange>): void => {
    if (changes.some(change => change.type === 'dimensions')) {
      setMeasurementVersion(version => version + 1)
    }
    const positions = changes.flatMap(change => change.type === 'position' && change.position !== undefined
      ? [{ id: change.id, position: change.position, dragging: change.dragging === true }]
      : [])
    if (positions.length > 0) {
      setTransientPositions(current => reducePositionChanges(current, positions).transient)
      for (const change of reducePositionChanges(transientPositions, positions).committed) {
        actions.setPosition(change.id, change.position)
      }
    }
    for (const change of changes) {
      if (change.type === 'select') actions.setNodeSelected(change.id, change.selected)
    }
  }
  const selectedRecords = records.filter(record => selectedNodeIds.includes(record.id))
  const batch = (desired: boolean | 'natural'): void => {
    if (graph === undefined) return
    const mutations = selectedRecords.map(record => ({
      node: record.owner,
      mode: desired === 'natural'
        ? 'natural' as const
        : modeForEffectiveContext(record.sessionIds.includes(graph.activeSessionId), desired),
    }))
    runMutation('__batch__', () => mapActions.setNodeModes(mutations))
  }
  const stepSearch = (delta: -1 | 1): void => {
    if (searchResultIds.length === 0) return
    setResultIndex(index => (index + delta + searchResultIds.length) % searchResultIds.length)
  }
  const marqueeRect = marquee === null ? null : {
    x: Math.min(marquee.start.x, marquee.current.x),
    y: Math.min(marquee.start.y, marquee.current.y),
    width: Math.abs(marquee.current.x - marquee.start.x),
    height: Math.abs(marquee.current.y - marquee.start.y),
  }

  return (
    <section className={css.root} aria-label="Context Map">
      <header className={css.header}>
        <div>
          <h2>Context Map</h2>
          <p>{snapshot.view === undefined || graph === undefined
            ? 'Loading context…'
            : `${String(visibleSelectedCount)} / ${String(records.length)} in context`}</p>
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
      <div className={css.toolbar} aria-label="Context Map actions">
        <button
          type="button"
          aria-label="Selection mode"
          aria-pressed={interactionMode === 'selection'}
          onClick={() => {
            setInteractionMode(mode => mode === 'normal' ? 'selection' : 'normal')
            actions.clearSelection()
          }}
        >Select</button>
        <span className={css.toolbarSpacer} />
        <button type="button" disabled={mutationPending} onClick={() => { runMutation('__reset__', mapActions.reset) }}>Clear manual changes</button>
        <button type="button" disabled={mutationPending || snapshot.view?.canUndo !== true} onClick={() => { runMutation('__undo__', mapActions.undo) }}>Undo</button>
        <button type="button" disabled={mutationPending || snapshot.view?.canRedo !== true} onClick={() => { runMutation('__redo__', mapActions.redo) }}>Redo</button>
      </div>
      {snapshot.error !== undefined && <div className={css.error} role="alert">{snapshot.error}</div>}
      {actionError !== null && <div className={css.error} role="alert">{actionError}</div>}
      <div
        ref={canvasRef}
        className={css.canvas}
        data-context-map-canvas=""
        onPointerDownCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-context-map-menu]') !== null) return
          setMenu(null)
          if (interactionMode !== 'selection' || !event.shiftKey) return
          if (event.target instanceof Element && event.target.closest('[data-context-node-id]') !== null) return
          const bounds = event.currentTarget.getBoundingClientRect()
          const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
          event.currentTarget.setPointerCapture(event.pointerId)
          setMarquee({ pointerId: event.pointerId, start: point, current: point })
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerMoveCapture={(event) => {
          if (marquee === null || event.pointerId !== marquee.pointerId) return
          const bounds = event.currentTarget.getBoundingClientRect()
          setMarquee(value => value === null ? null : {
            ...value,
            current: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
          })
        }}
        onPointerUpCapture={(event) => {
          if (marquee === null || event.pointerId !== marquee.pointerId) return
          const bounds = event.currentTarget.getBoundingClientRect()
          const finished = {
            x: Math.min(marquee.start.x, event.clientX - bounds.left),
            y: Math.min(marquee.start.y, event.clientY - bounds.top),
            width: Math.abs(event.clientX - bounds.left - marquee.start.x),
            height: Math.abs(event.clientY - bounds.top - marquee.start.y),
          }
          for (const card of event.currentTarget.querySelectorAll<HTMLElement>('[data-context-node-id]')) {
            const rect = card.getBoundingClientRect()
            if (!intersects(finished, {
              x: rect.left - bounds.left,
              y: rect.top - bounds.top,
              width: rect.width,
              height: rect.height,
            })) continue
            const id = card.dataset.contextNodeId
            if (id !== undefined) actions.setNodeSelected(id, !selectedNodeIds.includes(id))
          }
          event.currentTarget.releasePointerCapture(event.pointerId)
          setMarquee(null)
        }}
        onPointerCancelCapture={() => { setMarquee(null) }}
      >
        {graph !== undefined && (
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeClick={(_event, node) => {
              const data = node.data as ContextMapNodeData
              data.onActivate(data.record)
            }}
            onInit={setInstance}
            onPaneClick={() => { setMenu(null) }}
            onMoveStart={() => { setMenu(null) }}
            minZoom={0.18}
            maxZoom={1.8}
            nodesDraggable={interactionMode === 'normal'}
            elementsSelectable={false}
            selectionOnDrag={false}
            panOnScroll
            multiSelectionKeyCode={['Meta', 'Control']}
          >
            <Background gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
        {snapshot.phase === 'loading' && <div className={css.empty}>Loading Context Map…</div>}
        {snapshot.phase !== 'loading' && records.length === 0 && <div className={css.empty}>No message nodes yet.</div>}
        {marqueeRect !== null && (
          <div
            className={css.marquee}
            data-testid="context-map-marquee"
            style={{
              transform: `translate(${String(marqueeRect.x)}px, ${String(marqueeRect.y)}px)`,
              width: marqueeRect.width,
              height: marqueeRect.height,
            }}
          />
        )}
        {menu !== null && (
          <ContextMapMenu
            point={menu.point}
            record={menu.record}
            mode={modeOf(snapshot, menu.record)}
            pending={mutationPending}
            close={() => { setMenu(null) }}
            locate={mapActions.locate}
            branch={mapActions.branch}
            restoreAutomatic={(record) => {
              runMutation(record.id, () => mapActions.setNodeMode(record.owner, 'natural'), 'natural')
            }}
            reportError={(cause) => {
              setActionError(cause instanceof Error ? cause.message : String(cause))
            }}
          />
        )}
      </div>
      {interactionMode === 'selection' && selectedRecords.length > 0 && (
        <div className={css.selectionBar} aria-label="Selected message actions">
          <strong>{selectedRecords.length} selected</strong>
          <button type="button" disabled={mutationPending} onClick={() => { batch(true) }}>Include in context</button>
          <button type="button" disabled={mutationPending} onClick={() => { batch(false) }}>Exclude from context</button>
          <button type="button" disabled={mutationPending} onClick={() => { batch('natural') }}>Restore automatic</button>
          <button type="button" onClick={() => { actions.clearSelection() }}>Clear</button>
        </div>
      )}
    </section>
  )
}

export type { ContextMapLayout } from './store.ts'

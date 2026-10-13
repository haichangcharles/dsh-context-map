/** Interactive React Flow surface for one native Session Context Map. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, Controls, MarkerType, ReactFlow,
  type Edge, type NodeChange, type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  ContextArchiveCandidate, ContextFamilyGraphNode, ContextFamilySession, ContextMessageRef, ContextNodeMutation,
  ContextRecommendationMode, ContextRecommendationProposal, ContextRouteAdvice, ContextStewardProfile,
  ContextPolicyObservation,
} from '@deepseek-ai/dsh-contextify/types'
import type { WorkspaceSnapshot as WorkspaceListState } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { HostObservable, PropsLocale, PropsStore, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { projectUnarchivedContextFamily } from './archived-family.ts'
import { ContextMapNode, type ContextMapNodeData, type ContextNodeMode } from './ContextMapNode.tsx'
import {
  effectiveContextIncluded, intersects, modeForEffectiveContext, reducePositionChanges, type CanvasPoint,
} from './canvas-interactions.ts'
import { ContextMapMenu } from './ContextMapMenu.tsx'
import { ContextRecommendationReview } from './ContextRecommendationReview.tsx'
import type { ContextifyControllerSnapshot } from './controller.ts'
import { layoutContextMap, type ContextMapNodeSizes } from './layout.ts'
import { reconcileMeasuredSizes, reduceMeasuredSizes } from './layout-measurements.ts'
import { createContextMapStore } from './store.ts'
import './locales.ts'
import css from './ContextMapPanel.module.css'

/** Model-changing and navigation actions shared with Chat controls. */
export interface ContextMapActions {
  setNodeMode: (node: ContextMessageRef, mode: ContextNodeMode) => Promise<void>
  setNodeModes: (mutations: readonly ContextNodeMutation[]) => Promise<void>
  reset: () => Promise<void>
  undo: () => Promise<void>
  redo: () => Promise<void>
  recommend: (mode?: ContextRecommendationMode, objective?: string) => Promise<void>
  inspectPolicy: () => Promise<ContextStewardProfile>
  policyEvidence: () => Promise<readonly ContextPolicyObservation[]>
  resetPolicy: () => Promise<void>
  moveDraftHere: (sessionId: ContextFamilySession['id']) => Promise<void>
  reviewWorkState: (proposal: ContextRecommendationProposal, sessionId: ContextFamilySession['id'], choice: 'accept' | 'reject') => Promise<void>
  setWorkState: (sessionId: ContextFamilySession['id'], state: NonNullable<ContextFamilySession['workState']>) => Promise<void>
  cancelRecommendation: () => Promise<void>
  applyRecommendations: (declinedNodeIds?: readonly string[]) => Promise<void>
  clearRecommendation: () => void
  acceptRoute: (route: ContextRouteAdvice) => Promise<void>
  rejectRoute: (route: ContextRouteAdvice) => Promise<void>
  presentRecommendation: (proposal: ContextRecommendationProposal) => Promise<void>
  dismissRecommendation: (declinedNodeIds?: readonly string[]) => Promise<void>
  confirmArchive: (candidate: ContextArchiveCandidate) => Promise<void>
  archiveNode: (node: ContextMessageRef) => Promise<void>
  getNodeText: (node: ContextMessageRef) => Promise<string>
  focusNodeExcerpt: (node: ContextMessageRef, start: number, end: number) => Promise<void>
  restoreNode: (node: ContextMessageRef) => Promise<void>
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
  & PropsLocale<'contextifySteward'>
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

function canEditNode(record: ContextFamilyGraphNode, active: boolean): boolean {
  return active || record.sourceKind === undefined || record.sourceKind === 'chat'
    || (record.sourceKind === 'web' && record.webAction !== undefined)
}

/** The pinned header, tree canvas, search, history, and batch controls. */
export function ContextMapPanel({
  useContextify, useWorkspaces, useStore, actions, mapActions, t,
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
  const [originalPreview, setOriginalPreview] = useState<string | null>(null)
  const [excerptDialog, setExcerptDialog] = useState<{
    record: ContextFamilyGraphNode
    text: string
  } | null>(null)
  const excerptTextRef = useRef<HTMLTextAreaElement>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null)
  const [recommendationMenuOpen, setRecommendationMenuOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [policyState, setPolicyState] = useState<
    { phase: 'idle' | 'loading' } | { phase: 'ready'; profile: ContextStewardProfile; evidence: readonly ContextPolicyObservation[] }
    | { phase: 'error'; error: string }
  >({ phase: 'idle' })
  const policyRequest = useRef(0)
  const [optimisticModes, setOptimisticModes] = useState<Record<string, ContextNodeMode>>({})
  const [transientPositions, setTransientPositions] = useState<Record<string, CanvasPoint>>({})
  const [measuredSizes, setMeasuredSizes] = useState<ContextMapNodeSizes>({})
  const [graphMeasured, setGraphMeasured] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const initialFitCompleted = useRef(false)
  const relayoutTimer = useRef<number | undefined>(undefined)
  const recommendButtonRef = useRef<HTMLButtonElement>(null)
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
    : records.filter((node) => {
      const preview = node.replacement?.kind === 'placeholder' ? ''
        : node.replacement?.kind === 'excerpt' ? node.replacement.preview : node.preview
      return preview.toLocaleLowerCase().includes(normalizedQuery)
    }).map(node => node.id),
  [normalizedQuery, records])
  const activeSearchId = searchResultIds.length === 0
    ? undefined
    : searchResultIds[resultIndex % searchResultIds.length]
  const focusTargetId = snapshot.focusedNodeId ?? activeSearchId
  const measurementSignature = useMemo(() => Object.entries(measuredSizes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, size]) => `${id}:${size.width}x${size.height}`)
    .join('|'), [measuredSizes])
  const proposal = snapshot.recommendation.phase === 'ready' || snapshot.recommendation.phase === 'stale'
    ? snapshot.recommendation.proposal
    : undefined
  const learnedProfile = policyState.phase === 'ready' ? policyState.profile : undefined
  const reviewedSupport = learnedProfile === undefined ? 0
    : Math.max(learnedProfile.evidence.support + learnedProfile.destination.support
      + learnedProfile.branch.support + learnedProfile.return.support + learnedProfile.release.support,
    policyState.phase === 'ready' ? policyState.evidence.filter(item => item.undone !== true)
      .reduce((sum, item) => sum + (item.weight ?? 1), 0) : 0)
  const loadPolicy = (): void => {
    const request = ++policyRequest.current
    setPolicyState({ phase: 'loading' })
    void Promise.all([mapActions.inspectPolicy(), mapActions.policyEvidence()]).then(([profile, evidence]) => {
      if (request === policyRequest.current) setPolicyState({ phase: 'ready', profile, evidence })
    }).catch((cause: unknown) => {
      if (request === policyRequest.current) {
        setPolicyState({ phase: 'error', error: cause instanceof Error ? cause.message : String(cause) })
      }
    })
  }
  const recommendationByNode = useMemo(() => {
    const result = new Map<string, 'include' | 'exclude' | 'archive'>()
    for (const item of proposal?.selection ?? []) result.set(item.nodeId, item.action)
    for (const item of proposal?.archive ?? []) result.set(item.nodeId, 'archive')
    return result
  }, [proposal])

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
    if (!canEditNode(record, active)) return
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
  useEffect(() => {
    setMeasuredSizes(current => reconcileMeasuredSizes(current, records.map(record => record.id)))
  }, [records])
  useEffect(() => { setResultIndex(0) }, [normalizedQuery])
  useEffect(() => {
    if (menu === null && !recommendationMenuOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenu(null)
      setRecommendationMenuOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [menu, recommendationMenuOpen])
  useEffect(() => {
    if (!graphMeasured || instance === null || records.length === 0 || initialFitCompleted.current) return
    if (focusTargetId !== undefined) {
      initialFitCompleted.current = true
      return
    }
    const timer = window.setTimeout(() => {
      initialFitCompleted.current = true
      void instance.fitView({ duration: 220 })
    }, 80)
    return () => { window.clearTimeout(timer) }
  }, [focusTargetId, graphMeasured, instance, measurementSignature, records.length])
  useEffect(() => {
    if (!graphMeasured || instance === null || focusTargetId === undefined) return
    initialFitCompleted.current = true
    const timer = window.setTimeout(() => {
      void instance.fitView({ nodes: [{ id: focusTargetId }], duration: 220, maxZoom: 1.2 })
    }, 300)
    return () => { window.clearTimeout(timer) }
  }, [focusTargetId, graphMeasured, instance])
  useEffect(() => () => {
    if (relayoutTimer.current !== undefined) window.clearTimeout(relayoutTimer.current)
  }, [])

  const flowNodes = useMemo(() => {
    if (graph === undefined) return []
    const searchMatches = new Set(searchResultIds)
    const selected = new Set(selectedNodeIds)
    const sessions = new Map(graph.sessions.map(session => [session.id, session]))
    return layoutContextMap(graph.nodes, graph.edges, 'tree', measuredSizes).map((node) => {
      const record = node.data.record
      const session = sessions.get(record.owner.sessionId)
      const mode = optimisticModes[record.id] ?? modeOf(snapshot, record)
      const active = record.sessionIds.includes(graph.activeSessionId)
      const recommendation = recommendationByNode.get(record.id)
      const data: ContextMapNodeData = {
        record,
        mode,
        included: effectiveContextIncluded(active, mode),
        pending: mutationPending || !canEditNode(record, active),
        sessionLabel: session?.depth === 0 ? 'Root Session' : `Branch Session · depth ${String(session?.depth ?? 0)}`,
        active,
        focused: snapshot.focusedNodeId === record.id || activeSearchId === record.id,
        searchMatch: searchMatches.has(record.id),
        ...(recommendation === undefined ? {} : { recommendation }),
        onActivate: (candidate) => {
          if (interactionMode === 'selection') {
            if (!canEditNode(candidate, candidate.sessionIds.includes(graph.activeSessionId))) return
            actions.setNodeSelected(candidate.id, !selected.has(candidate.id))
          }
        },
        onIncludedChange: setEffectiveMode,
        onContextMenu: (candidate, screenPoint) => {
          if (!canEditNode(candidate, active)) return
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
    measuredSizes, positionOverrides, recommendationByNode, searchResultIds, selectedNodeIds,
    setEffectiveMode, snapshot, transientPositions,
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
      setGraphMeasured(true)
      setMeasuredSizes(current => reduceMeasuredSizes(current, changes))
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
  const relayout = (): void => {
    setTransientPositions({})
    actions.clearPositions()
    setMenu(null)
    if (instance === null) return
    if (relayoutTimer.current !== undefined) window.clearTimeout(relayoutTimer.current)
    relayoutTimer.current = window.setTimeout(() => {
      relayoutTimer.current = undefined
      void instance.fitView({ duration: 220 })
    }, 0)
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
        <div className={css.headerActions}>
          <button type="button" aria-label="Context preferences" aria-expanded={policyOpen}
            onClick={() => {
              if (policyOpen) {
                policyRequest.current += 1
                setPolicyOpen(false)
              } else {
                setPolicyOpen(true)
                loadPolicy()
              }
            }}>Preferences</button>
          <button type="button" className={css.iconButton} aria-label="Close Context Map" onClick={mapActions.close}>×</button>
        </div>
      </header>
      {graph !== undefined && graph.sessions.length > 1 && <details className={css.branchStates}>
        <summary>{`Branches (${String(graph.sessions.length)}) · task lifecycle`}</summary>
        <ul>
          {graph.sessions.map((session) => {
            const label = session.depth === 0 ? 'Mainline'
              : records.find(node => node.owner.sessionId === session.id && node.role === 'user')
                ?.preview.slice(0, 72) || `Branch ${String(session.id).slice(0, 8)}`
            const state = session.workState ?? (session.id === graph.activeSessionId ? 'open' : 'parked')
            const active = session.id === graph.activeSessionId
            return <li key={session.id} data-work-session-id={session.id} data-work-state={state}>
              <span className={css.branchStateLabel} title={label}>{label}</span>
              <span className={css.branchStateMeta}>{active ? 'Active' : 'Inactive'} · {state}</span>
              {!active && <button type="button" disabled={mutationPending}
                aria-label={`${t('action.moveDraftHere')}: ${label}`} onClick={() => {
                  runMutation(`move:${session.id}`, () => mapActions.moveDraftHere(session.id))
                }}>{t('action.moveDraftHere')}</button>}
              {state !== 'completed' && <button type="button" disabled={mutationPending}
                aria-label={`Complete ${label}`} onClick={() => {
                  runMutation(`session:${session.id}`, () => mapActions.setWorkState(session.id, 'completed'))
                }}>Complete</button>}
              {state === 'completed' || state === 'parked' ? <button type="button" disabled={mutationPending}
                aria-label={`Reopen ${label}`} onClick={() => {
                  runMutation(`session:${session.id}`, () => mapActions.setWorkState(session.id, 'open'))
                }}>Reopen</button> : <button type="button" disabled={mutationPending}
                aria-label={`Park ${label}`} onClick={() => {
                  runMutation(`session:${session.id}`, () => mapActions.setWorkState(session.id, 'parked'))
                }}>Park</button>}
            </li>
          })}
        </ul>
      </details>}
      {policyOpen && <section className={css.policyPanel} aria-label="Learned Context preferences">
        <div className={css.policyHeading}>
          <strong>What the Agent learned</strong>
          <div className={css.policyHeadingActions}>
            <button type="button" aria-label="Refresh Context preferences"
              disabled={policyState.phase === 'loading'} onClick={loadPolicy}>Refresh</button>
            <button type="button" aria-label="Close Context preferences" onClick={() => {
              policyRequest.current += 1
              setPolicyOpen(false)
            }}>×</button>
            <button type="button" disabled={mutationPending || policyState.phase === 'loading'}
              onClick={() => { runMutation('__policy_reset__', async () => {
                await mapActions.resetPolicy()
                loadPolicy()
              }) }}>{t('policy.reset')}</button>
          </div>
        </div>
        <p>{t('policy.resetHint')}</p>
        <p>Only explicit Context choices count. These are adjustable action patterns, not personal facts. Refresh after Apply or Undo.</p>
        {policyState.phase === 'loading' && <p>Loading reviewed choices…</p>}
        {policyState.phase === 'error' && <p role="alert">{policyState.error} <button type="button"
          onClick={loadPolicy}>Retry</button></p>}
        {policyState.phase === 'ready' && <>
          {reviewedSupport > 0 && <ul className={css.policyStats}>{([
            ['Include evidence', policyState.profile.evidence],
            ['Navigate', policyState.profile.destination],
            ['Branch', policyState.profile.branch],
            ['Return', policyState.profile.return],
            ['Release context', policyState.profile.release],
          ] as const).filter(([, estimate]) => estimate.support > 0).map(([label, estimate]) => <li key={label}>
            {`${label}: ${String(estimate.support)} effective reviews · ${String(Math.round(estimate.acceptRate * 100))}% smoothed acceptance`}
          </li>)}</ul>}
          {policyState.profile.rules.length === 0
            ? <p>{reviewedSupport >= 4 ? 'No stable action tendency yet.'
              : reviewedSupport > 0 ? 'More confirmed choices are needed to infer a tendency.'
                : 'No confirmed Context choices yet.'}</p>
            : <ul>{policyState.profile.rules.map((rule, index) => <li key={`${rule.action}:${rule.sourceKind ?? 'all'}:${rule.activity ?? 'all'}:${index}`}>
              <strong>{rule.action === 'include' && rule.sourceKind === 'web'
                ? 'Include Web sources' : `${rule.action[0]?.toUpperCase() ?? ''}${rule.action.slice(1)} ${rule.sourceKind ?? 'context'}`}
              {rule.activity === undefined ? '' : ` during ${rule.activity}`}</strong>
              <span>{rule.tendency === 'favor' ? 'Often accepted' : 'Often declined'} · {String(rule.support)} effective reviews</span>
            </li>)}</ul>}
          {policyState.profile.destination.support + policyState.profile.branch.support
            + policyState.profile.return.support === 0 && <p>No confirmed route choices yet</p>}
          <details>
            <summary>{t('policy.evidence')}</summary>
            {policyState.evidence.length === 0 ? <p>{t('policy.emptyEvidence')}</p> : <ul>
              {policyState.evidence.map((item, index) => <li key={`${item.sourceSessionId ?? 'legacy'}:${item.sourceEventSeq ?? 'unknown'}:${item.displayedIndex ?? index}`}>
                <strong>{item.action} · {t(item.choice === 'accept' ? 'policy.accept' : 'policy.reject')}</strong>
                {item.objective !== undefined && <span>{t('policy.objective')}: {item.objective}</span>}
                {item.targetNodeId !== undefined && <span>{t('policy.context')}: {records.find(record => record.id === item.targetNodeId)?.preview ?? item.targetNodeId}</span>}
                {item.targetSessionId !== undefined && <span>{item.targetSessionId}</span>}
                {item.undone === true && <span>{t('policy.undone')}</span>}
                {item.sourceSessionId !== undefined && <span>{t('policy.source')}: {item.sourceSessionId}:{item.sourceEventSeq}</span>}
              </li>)}
            </ul>}
          </details>
        </>}
      </section>}
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
        <button
          type="button"
          disabled={instance === null || records.length === 0}
          onClick={relayout}
        >Re-layout</button>
        <div className={css.recommendationActions}>
          <button
            ref={recommendButtonRef}
            type="button"
            disabled={mutationPending || snapshot.recommendation.phase === 'running' || graph === undefined}
            onClick={() => {
              setActionError(null)
              setRecommendationMenuOpen(false)
              // The controller publishes recommendation failures itself. Avoid
              // duplicating the same failure in the generic mutation alert.
              void mapActions.recommend('local').catch(() => {})
            }}
          >{snapshot.recommendation.phase === 'running'
              ? snapshot.recommendation.mode === 'deep' ? 'Inspecting tree…' : 'Reviewing…'
              : 'Recommend'}</button>
          <button
            type="button"
            aria-label="Recommendation mode"
            aria-expanded={recommendationMenuOpen}
            disabled={mutationPending || snapshot.recommendation.phase === 'running' || graph === undefined}
            onClick={() => { setRecommendationMenuOpen(open => !open) }}
          >▾</button>
          {recommendationMenuOpen && <div
            className={css.recommendationMenu}
            role="menu"
            aria-label="Recommendation mode"
            data-opaque-surface="true"
          >
            <button type="button" role="menuitem" aria-label={t('mode.local')} onClick={() => {
              setActionError(null)
              setRecommendationMenuOpen(false)
              void mapActions.recommend('local').catch(() => {})
            }}>
              <strong>{t('mode.local')}</strong>
              <span>{t('mode.localHint')}</span>
            </button>
            <button type="button" role="menuitem" aria-label={t('mode.fast')} onClick={() => {
              setActionError(null)
              setRecommendationMenuOpen(false)
              void mapActions.recommend('fast').catch(() => {})
            }}>
              <strong>{t('mode.fast')}</strong>
              <span>{t('mode.fastHint')}</span>
            </button>
            <button type="button" role="menuitem" aria-label={t('mode.deep')} onClick={() => {
              setActionError(null)
              setRecommendationMenuOpen(false)
              void mapActions.recommend('deep').catch(() => {})
            }}>
              <strong>{t('mode.deep')}</strong>
              <span>{t('mode.deepHint')}</span>
            </button>
          </div>}
        </div>
        {snapshot.recommendation.phase === 'running' && snapshot.recommendation.mode === 'deep' && <button
          type="button"
          onClick={() => { void mapActions.cancelRecommendation().catch(() => {}) }}
        >Cancel Deep review</button>}
        <span className={css.toolbarSpacer} />
        <button type="button" disabled={mutationPending} onClick={() => { runMutation('__reset__', mapActions.reset) }}>Clear manual changes</button>
        <button type="button" disabled={mutationPending || snapshot.view?.canUndo !== true} onClick={() => { runMutation('__undo__', mapActions.undo) }}>Undo</button>
        <button type="button" disabled={mutationPending || snapshot.view?.canRedo !== true} onClick={() => { runMutation('__redo__', mapActions.redo) }}>Redo</button>
      </div>
      {snapshot.error !== undefined && <div className={css.error} role="alert">{snapshot.error}</div>}
      {actionError !== null && <div className={css.error} role="alert">{actionError}</div>}
      {snapshot.recommendation.phase === 'error' && <div className={css.recommendationError} role="alert">
        <span>{snapshot.recommendation.error}</span>
        <button type="button" aria-label="Dismiss recommendation error" onClick={() => {
          mapActions.clearRecommendation()
          queueMicrotask(() => { recommendButtonRef.current?.focus() })
        }}>Dismiss</button>
      </div>}
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
            archive={(record) => {
              runMutation(record.id, () => mapActions.archiveNode(record.owner))
            }}
            focusExcerpt={(record) => {
              runMutation(record.id, async () => {
                const text = await mapActions.getNodeText(record.owner)
                setExcerptDialog({ record, text })
              })
            }}
            showOriginal={(record) => {
              if (record.replacement?.kind !== 'excerpt') {
                setOriginalPreview(record.replacement?.original || record.preview || '(empty message)')
                return
              }
              runMutation(record.id, async () => {
                setOriginalPreview(await mapActions.getNodeText(record.owner))
              })
            }}
            restoreOriginal={(record) => {
              runMutation(record.id, () => mapActions.restoreNode(record.owner))
            }}
            reportError={(cause) => {
              setActionError(cause instanceof Error ? cause.message : String(cause))
            }}
          />
        )}
        {graph !== undefined && <ContextRecommendationReview
          state={snapshot.recommendation}
          graph={graph}
          pending={mutationPending}
          t={t}
          reviewWorkState={(proposal, sessionId, choice) => mapActions.reviewWorkState(proposal, sessionId, choice)}
          acceptRoute={route => mapActions.acceptRoute(route)}
          rejectRoute={route => mapActions.rejectRoute(route)}
          present={proposal => mapActions.presentRecommendation(proposal)}
          apply={declinedNodeIds => mapActions.applyRecommendations(declinedNodeIds)}
          confirmArchive={candidate => mapActions.confirmArchive(candidate)}
          dismiss={async (declinedNodeIds) => {
            await mapActions.dismissRecommendation(declinedNodeIds)
            queueMicrotask(() => { recommendButtonRef.current?.focus() })
          }}
          reportError={(cause) => { setActionError(cause instanceof Error ? cause.message : String(cause)) }}
        />}
        {originalPreview !== null && <div className={css.originalDialog} role="dialog" aria-label="Original message">
          <header><h3>Original message</h3><button type="button" aria-label="Close original message" onClick={() => { setOriginalPreview(null) }}>×</button></header>
          <p>{originalPreview}</p>
        </div>}
        {excerptDialog !== null && <div className={css.originalDialog} role="dialog" aria-label="Keep text excerpt"
          data-opaque-surface="true" onPointerDown={(event) => { event.stopPropagation() }}>
          <header><h3>Keep text excerpt</h3><button type="button" aria-label="Close text excerpt" onClick={() => { setExcerptDialog(null) }}>×</button></header>
          <p>Select the exact text to retain in future model context. The full original stays in the Chat and can be restored.</p>
          <textarea ref={excerptTextRef} className={css.excerptTextarea} readOnly value={excerptDialog.text}
            aria-label="Original text for excerpt" />
          <button type="button" disabled={mutationPending} onClick={() => {
            const field = excerptTextRef.current
            if (field === null || field.selectionStart === field.selectionEnd) {
              setActionError('Select text to keep first')
              return
            }
            const start = Array.from(excerptDialog.text.slice(0, field.selectionStart)).length
            const end = Array.from(excerptDialog.text.slice(0, field.selectionEnd)).length
            runMutation(excerptDialog.record.id, async () => {
              await mapActions.focusNodeExcerpt(excerptDialog.record.owner, start, end)
              setExcerptDialog(null)
            })
          }}>Keep selected text</button>
        </div>}
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

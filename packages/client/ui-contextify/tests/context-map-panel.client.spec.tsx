// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSnapshot as WorkspaceListState } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ContextFamilyGraphNode, ContextStewardProfile, ContextPolicyObservation } from '@deepseek-ai/dsh-contextify/types'
import type { ReactFlowInstance, ReactFlowProps } from '@xyflow/react'
import {
  ContextMapPanel, type ContextMapActions,
} from '../src/client/ContextMapPanel.tsx'
import {
  ContextifyController, type ContextifyControllerSnapshot, type ContextifyTransport,
} from '../src/client/controller.ts'
import { stewardTestLocale, stewardTestTranslator } from './test-locale.client.ts'
import { createContextMapStore } from '../src/client/store.ts'
import { ContextMessageAction } from '../src/client/ContextMessageAction.tsx'
import {
  effectiveContextIncluded, intersects, effectiveContextMode, reducePositionChanges,
} from '../src/client/canvas-interactions.ts'
import { CONTEXT_MAP_RANK_GAP } from '../src/client/layout.ts'

const flowHarness = vi.hoisted(() => ({
  fitView: vi.fn(async () => true),
  props: undefined as ReactFlowProps | undefined,
  onNodesChange: undefined as ReactFlowProps['onNodesChange'],
  nodes: [] as NonNullable<ReactFlowProps['nodes']>,
}))

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const React = await import('react')
  return {
    ...actual,
    ReactFlow: (props: ReactFlowProps) => {
      flowHarness.props = props
      flowHarness.onNodesChange = props.onNodesChange
      flowHarness.nodes = props.nodes ?? []
      return React.createElement(actual.ReactFlow, {
        ...props,
        onInit: (instance: ReactFlowInstance) => {
          props.onInit?.({ ...instance, fitView: flowHarness.fitView })
        },
      })
    },
  }
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  flowHarness.fitView.mockClear()
  flowHarness.props = undefined
  flowHarness.onNodesChange = undefined
  flowHarness.nodes = []
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('DOMMatrixReadOnly', class {
    readonly m22 = 1
  })
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true, value: () => {},
  })
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', {
    configurable: true, value: () => {},
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
  Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture')
})

const sid = (value: string) => value as SessionId
const root = sid('root-session')
const child = sid('child-session')
const node = (
  id: string,
  seq: number,
  role: 'user' | 'assistant',
  preview: string,
  sessionId = root,
): ContextFamilyGraphNode => ({
  id,
  owner: { sessionId, seq },
  role,
  preview,
  time: seq * 1_000,
  branchAtSeq: seq + 2,
  sessionIds: sessionId === root ? [root, child] : [child],
  activeEventSeq: sessionId === child ? seq : null,
})

function fixture(): ContextifyControllerSnapshot {
  return {
    phase: 'ready',
    pending: false,
    recommendation: { phase: 'idle' },
    view: {
      plan: {
        kind: 'contextify/plan', version: 3, revision: 3, stateRevision: 3,
        history: { past: [2], future: [] },
        excluded: [], included: [], replacements: [],
      },
      graphAsOfSeq: 20,
      selectedCount: 2,
      totalNodeCount: 3,
      canUndo: true,
      canRedo: false,
    },
    graph: {
      rootSessionId: root,
      activeSessionId: child,
      sessions: [
        { id: root, seedLength: 0, depth: 0, tipNodeId: 'root:2' },
        { id: child, parentSessionId: root, seedLength: 5, depth: 1, tipNodeId: 'child:8' },
      ],
      nodes: [
        node('root:1', 1, 'user', 'root requirement'),
        node('root:2', 2, 'assistant', 'old draft'),
        node('child:8', 8, 'user', 'branch follow-up', child),
      ],
      edges: [
        { id: 'e1', source: 'root:1', target: 'root:2', sessionIds: [root, child] },
        { id: 'e2', source: 'root:2', target: 'child:8', sessionIds: [child] },
      ],
    },
    graphRevision: 'family-20',
  }
}

function mount(
  snapshot = fixture(),
  overrides: Partial<ContextMapActions> = {},
  archivedSessionIds: readonly SessionId[] = [],
  language: 'en' | 'zh' = 'en',
) {
  let currentSnapshot = snapshot
  const listeners = new Set<() => void>()
  const source = {
    getSnapshot: () => currentSnapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const workspaceSource = {
    getSnapshot: (): WorkspaceListState => ({
      items: [], archivedSessionIds, state: 'idle', phase: 'ready', error: null,
    }),
    subscribe: () => () => {},
  }
  const store = createContextMapStore().create()
  const mapActions: ContextMapActions = {
    setNodeMode: vi.fn(async () => {}),
    setNodeModes: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    undo: vi.fn(async () => {}),
    redo: vi.fn(async () => {}),
    recommend: vi.fn(async () => {}),
    inspectPolicy: vi.fn(async () => ({
      evidence: { acceptRate: 0.5, support: 0 }, destination: { acceptRate: 0.5, support: 0 },
      branch: { acceptRate: 0.5, support: 0 }, return: { acceptRate: 0.5, support: 0 },
      release: { acceptRate: 0.5, support: 0 },
      thresholds: { evidence: 0.7, destination: 0.7 }, rules: [],
    })),
    policyEvidence: vi.fn(async () => []),
    resetPolicy: vi.fn(async () => {}),
    moveDraftHere: vi.fn(async () => {}),
    reviewWorkState: vi.fn(async () => {}),
    setWorkState: vi.fn(async () => {}),
    cancelRecommendation: vi.fn(async () => {}),
    presentRecommendation: vi.fn(async () => {}),
    applyRecommendations: vi.fn(async () => {}),
    clearRecommendation: vi.fn(),
    acceptRoute: vi.fn(async () => {}),
    rejectRoute: vi.fn(async () => {}),
    dismissRecommendation: vi.fn(async () => {}),
    confirmArchive: vi.fn(async () => {}),
    archiveNode: vi.fn(async () => {}),
    getNodeText: vi.fn(async () => ''),
    focusNodeExcerpt: vi.fn(async () => {}),
    restoreNode: vi.fn(async () => {}),
    branch: vi.fn(async () => {}),
    locate: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
  const locale = stewardTestLocale(language)
  const t = locale.bind('contextifySteward')
  const panel = () => (
    <div style={{ width: 720, height: 680 }}>
      <ContextMapPanel
        useContextify={bindSnapshotSelector(source)}
        useWorkspaces={bindSnapshotSelector(workspaceSource)}
        useStore={bindSnapshotSelector(store)}
        actions={store.actions}
        mapActions={mapActions}
        t={t}
      />
    </div>
  )
  const view = render(panel())
  return {
    setLanguage: (language: 'en' | 'zh') => { locale.setLocale(language); view.rerender(panel()) },
    view, store, mapActions, snapshot,
    publishSnapshot: (next: ContextifyControllerSnapshot) => {
      currentSnapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('ContextMapPanel', () => {
  it('updates memoized graph card labels when the language changes without changing the graph', async () => {
    const h = mount()
    expect(await screen.findByLabelText('User message: root requirement')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Zoom In' })).toBeTruthy()
    h.setLanguage('zh')
    expect(await screen.findByLabelText('用户消息：root requirement')).toBeTruthy()
    expect(await screen.findByRole('button', { name: '放大' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '缩小' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '适配图视图' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Zoom In' })).toBeNull()
    expect(screen.queryByLabelText('User message: root requirement')).toBeNull()
    expect(h.mapActions.setNodeModes).not.toHaveBeenCalled()
  })

  it('localizes graph controls and ARIA names while preserving conversation text', async () => {
    const { mapActions } = mount(fixture(), {}, [], 'zh')
    expect(screen.getByRole('region', { name: 'Context Map' })).toBeTruthy()
    expect(await screen.findByLabelText('用户消息：root requirement')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '推荐' }))
    expect(mapActions.recommend).toHaveBeenCalledWith('local')
    fireEvent.click(screen.getByText('分支（2）· 任务生命周期'))
    expect(screen.getByRole('button', { name: '暂停 branch follow-up' })).toBeTruthy()
    expect(screen.getByText('当前分支 · 进行中')).toBeTruthy()
  })

  it('offers Local review by default and reserves model review for explicit modes', () => {
    const { mapActions } = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Recommend' }))
    expect(mapActions.recommend).toHaveBeenCalledWith('local')
    fireEvent.click(screen.getByRole('button', { name: 'Recommendation mode' }))
    expect(screen.getByRole('menuitem', { name: 'Local review' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fast review' }))
    expect(mapActions.recommend).toHaveBeenLastCalledWith('fast')
  })

  it('moves a draft deliberately from the branch list while leaving context choices alone', async () => {
    const { mapActions } = mount()
    const count = screen.getByText(/in context/).textContent
    fireEvent.click(screen.getByText('Branches (2) · task lifecycle'))
    fireEvent.click(screen.getByRole('button', { name: 'Move draft here: Mainline' }))
    await waitFor(() => { expect(mapActions.moveDraftHere).toHaveBeenCalledWith(root) })
    expect(mapActions.setNodeModes).not.toHaveBeenCalled()
    expect(screen.getByText(/in context/).textContent).toBe(count)
  })

  it('shows the choices behind preferences and resets policy without clearing the Context Plan', async () => {
    const policyEvidence = vi.fn().mockResolvedValueOnce([{
      action: 'navigate', choice: 'accept', origin: 'manual-action', objective: 'Continue the planning branch',
      sourceSessionId: root, sourceEventSeq: 81, targetSessionId: child, at: 1, branchDepth: 0,
    }]).mockResolvedValueOnce([])
    const { mapActions } = mount(fixture(), { policyEvidence })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    expect(await screen.findByText('navigate · Accepted')).toBeTruthy()
    expect(screen.getByText('Task at the time: Continue the planning branch')).toBeTruthy()
    expect(screen.getByText('Record source: root-session:81')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset learned preferences' }))
    expect(await screen.findByText('No recorded explicit choices yet.')).toBeTruthy()
    expect(mapActions.resetPolicy).toHaveBeenCalledOnce()
    expect(mapActions.reset).not.toHaveBeenCalled()
    expect(mapActions.setNodeModes).not.toHaveBeenCalled()
  })

  it('reviews a proposed lifecycle state independently from context selection', async () => {
    const base = fixture()
    const proposal = { mode: 'local' as const,
      base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
      currentNodeIds: ['root:1', 'root:2', 'child:8'], proposedNodeIds: ['root:1', 'root:2', 'child:8'],
      addedNodeIds: [], removedNodeIds: [], selection: [], archive: [],
      workStates: [{ sessionId: root, state: 'completed' as const, reason: 'The mainline task is finished' }],
    }
    const { mapActions } = mount({ ...base, recommendation: { phase: 'ready', proposal } })
    const section = screen.getByRole('region', { name: 'Branch task state advice' })
    fireEvent.click(within(section).getByRole('button', { name: 'Complete branch' }))
    await waitFor(() => { expect(mapActions.reviewWorkState).toHaveBeenCalledWith(proposal, root, 'accept') })
    expect(mapActions.applyRecommendations).not.toHaveBeenCalled()
    expect(mapActions.setNodeModes).not.toHaveBeenCalled()
  })

  it('lets a user park and reopen the active task without moving or clearing context', async () => {
    const { mapActions, publishSnapshot } = mount()
    const count = screen.getByText(/in context/).textContent
    fireEvent.click(screen.getByText('Branches (2) · task lifecycle'))
    fireEvent.click(screen.getByRole('button', { name: 'Park branch follow-up' }))
    await waitFor(() => { expect(mapActions.setWorkState).toHaveBeenCalledWith(child, 'parked') })
    const next = fixture()
    act(() => { publishSnapshot({ ...next, graph: { ...next.graph!, sessions: next.graph!.sessions.map(session =>
      session.id === child ? { ...session, workState: 'parked', workStateSource: 'explicit' as const } : session),
    } }) })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen branch follow-up' }))
    await waitFor(() => { expect(mapActions.setWorkState).toHaveBeenLastCalledWith(child, 'open') })
    expect(mapActions.moveDraftHere).not.toHaveBeenCalled()
    expect(mapActions.setNodeModes).not.toHaveBeenCalled()
    expect(screen.getByText(/in context/).textContent).toBe(count)
  })

  it('exposes separate branch lifecycle actions without changing node selection', async () => {
    const setWorkState = vi.fn(async () => {})
    const { publishSnapshot } = mount(fixture(), { setWorkState })
    const contextCount = screen.getByText(/in context/).textContent
    fireEvent.click(screen.getByText('Branches (2) · task lifecycle'))
    fireEvent.click(screen.getByRole('button', { name: 'Complete branch follow-up' }))
    await waitFor(() => { expect(setWorkState).toHaveBeenCalledWith(child, 'completed') })
    const updated = fixture()
    act(() => { publishSnapshot({ ...updated, graph: { ...updated.graph!,
      sessions: updated.graph!.sessions.map(session => session.id === child
        ? { ...session, workState: 'completed', workStateSource: 'explicit' as const } : session),
    } }) })
    expect(await screen.findByRole('button', { name: 'Reopen branch follow-up' })).toBeTruthy()
    expect(screen.getByText(/in context/).textContent).toBe(contextCount)
  })
  it('loads inspectable Context preferences only when requested', async () => {
    const inspectPolicy = vi.fn(async () => ({
      evidence: { acceptRate: 0.8, support: 8 },
      destination: { acceptRate: 0.5, support: 0 },
      branch: { acceptRate: 0.5, support: 0 },
      return: { acceptRate: 0.5, support: 0 },
      release: { acceptRate: 0.5, support: 0 },
      thresholds: { evidence: 0.6, destination: 0.7 },
      rules: [{ action: 'include' as const, sourceKind: 'web' as const,
        tendency: 'favor' as const, support: 8, acceptRate: 0.8 }],
    }))
    mount(fixture(), { inspectPolicy })
    expect(inspectPolicy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    await waitFor(() => {
      expect(screen.getByText('Include Web sources')).toBeTruthy()
      expect(screen.getByText(/Include evidence: 8 effective reviews/)).toBeTruthy()
    })
    expect(inspectPolicy).toHaveBeenCalledTimes(1)
    expect(screen.getByText('No confirmed route choices yet')).toBeTruthy()
  })

  it('distinguishes mixed feedback from a cold Context preference profile', async () => {
    const inspectPolicy = vi.fn(async () => ({
      evidence: { acceptRate: 0.5, support: 4 },
      destination: { acceptRate: 0.5, support: 0 },
      branch: { acceptRate: 0.5, support: 0 },
      return: { acceptRate: 0.5, support: 0 },
      release: { acceptRate: 0.5, support: 0 },
      thresholds: { evidence: 0.7, destination: 0.7 }, rules: [],
    }))
    mount(fixture(), { inspectPolicy })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    await waitFor(() => {
      expect(screen.getByText(/Include evidence: 4 effective reviews/)).toBeTruthy()
      expect(screen.getByText('No stable action tendency yet.')).toBeTruthy()
    })
  })

  it('keeps a reopened preference view from being overwritten by an older request', async () => {
    const profile = (support: number) => ({
      evidence: { acceptRate: 0.8, support },
      destination: { acceptRate: 0.5, support: 0 }, branch: { acceptRate: 0.5, support: 0 },
      return: { acceptRate: 0.5, support: 0 }, release: { acceptRate: 0.5, support: 0 },
      thresholds: { evidence: 0.7, destination: 0.7 }, rules: [],
    })
    let resolveFirst!: (value: ReturnType<typeof profile>) => void
    let resolveSecond!: (value: ReturnType<typeof profile>) => void
    const first = new Promise<ReturnType<typeof profile>>((resolve) => { resolveFirst = resolve })
    const second = new Promise<ReturnType<typeof profile>>((resolve) => { resolveSecond = resolve })
    const inspectPolicy = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    mount(fixture(), { inspectPolicy })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Context preferences' }))
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    await act(async () => { resolveSecond(profile(8)) })
    expect(screen.getByText(/Include evidence: 8 effective reviews/)).toBeTruthy()
    await act(async () => { resolveFirst(profile(0)) })
    expect(screen.getByText(/Include evidence: 8 effective reviews/)).toBeTruthy()
  })

  it('refreshes the read-only profile after a Context choice is corrected', async () => {
    const estimate = (support: number) => ({ acceptRate: 0.5, support })
    const profile = (support: number) => ({
      evidence: estimate(support), destination: estimate(0), branch: estimate(0),
      return: estimate(0), release: estimate(0),
      thresholds: { evidence: 0.7, destination: 0.7 }, rules: [],
    })
    const inspectPolicy = vi.fn().mockResolvedValueOnce(profile(4)).mockResolvedValueOnce(profile(0))
    const { mapActions } = mount(fixture(), { inspectPolicy })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    await waitFor(() => { expect(screen.getByText(/Include evidence: 4 effective reviews/)).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Context preferences' }))
    await waitFor(() => { expect(screen.getByText('No confirmed Context choices yet.')).toBeTruthy() })
    expect(inspectPolicy).toHaveBeenCalledTimes(2)
    expect(mapActions.setNodeMode).not.toHaveBeenCalled()
    expect(mapActions.undo).not.toHaveBeenCalled()
  })

  it('lets users import source-bound sibling Web evidence but blocks unbound results and Archive', async () => {
    const initial = fixture()
    const activeWeb: ContextFamilyGraphNode = {
      id: 'child:9', owner: { sessionId: child, seq: 9 }, role: 'tool', sourceKind: 'web',
      preview: 'Current supplier page', time: 9_000, branchAtSeq: null,
      sessionIds: [child], activeEventSeq: 9,
    }
    const offPathWeb: ContextFamilyGraphNode = {
      id: 'root:10', owner: { sessionId: root, seq: 10 }, role: 'tool', sourceKind: 'web',
      preview: 'Unrelated page', time: 10_000, branchAtSeq: null,
      sessionIds: [root], activeEventSeq: null,
    }
    const importableWeb: ContextFamilyGraphNode = {
      ...offPathWeb, id: 'root:11', owner: { sessionId: root, seq: 11 },
      preview: 'Publisher policy page', time: 11_000, webAction: 'web_fetch',
    }
    const h = mount({ ...initial, graph: { ...initial.graph!,
      nodes: [...initial.graph!.nodes, activeWeb, offPathWeb, importableWeb],
      edges: [...initial.graph!.edges,
        { id: 'active-web', source: 'child:8', target: 'child:9', sessionIds: [child] },
        { id: 'off-path-web', source: 'root:2', target: 'root:10', sessionIds: [root] },
        { id: 'importable-web', source: 'root:10', target: 'root:11', sessionIds: [root] }],
    } })
    const active = await screen.findByLabelText('Web source message: Current supplier page')
    fireEvent.click(within(active).getByLabelText('Include Current supplier page in context'))
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: child, seq: 9 }, 'exclude')
    fireEvent.contextMenu(active, { clientX: 100, clientY: 120 })
    expect(screen.queryByRole('menuitem', { name: 'Archive node' })).toBeNull()
    const offPath = screen.getByLabelText('Web source message: Unrelated page')
    expect(within(offPath).getByLabelText('Include Unrelated page in context')).toHaveProperty('disabled', true)
    const importable = screen.getByLabelText('Web source message: Publisher policy page')
    const checkbox = within(importable).getByLabelText('Include Publisher policy page in context')
    await waitFor(() => { expect((checkbox as HTMLInputElement).disabled).toBe(false) })
    fireEvent.click(checkbox)
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 11 }, 'include')
  })

  it('shows one compact recommendation error without a review overlay', () => {
    const initial = fixture()
    mount({
      ...initial,
      recommendation: { phase: 'error', mode: 'fast', error: 'Invalid recommendation JSON' },
    })

    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('Invalid recommendation JSON')
    expect(screen.queryByText('Recommendation failed')).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Context recommendation review' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss recommendation error' }))
  })

  it('changes effective context only through a checkbox, not a normal card click', async () => {
    const h = mount()
    const card = await screen.findByLabelText('User message: root requirement')
    const checkbox = within(card).getByLabelText('Include root requirement in context')
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    fireEvent.click(card)
    expect(h.mapActions.setNodeMode).not.toHaveBeenCalled()
    fireEvent.click(checkbox)
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 1 }, 'exclude')
  })

  it('uses the active Session path as the automatic checkbox result', async () => {
    const original = fixture()
    const snapshot = { ...original, graph: { ...original.graph!, activeSessionId: root } }
    const h = mount(snapshot)
    const rootCheckbox = await screen.findByLabelText('Include root requirement in context')
    const branchCheckbox = screen.getByLabelText('Include branch follow-up in context')
    expect((rootCheckbox as HTMLInputElement).checked).toBe(true)
    expect((branchCheckbox as HTMLInputElement).checked).toBe(false)
    fireEvent.click(branchCheckbox)
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: child, seq: 8 }, 'include')
  })

  it('restores the automatic mode when the checkbox returns to the path result', async () => {
    const original = fixture()
    const snapshot: ContextifyControllerSnapshot = {
      ...original,
      view: {
        ...original.view!,
        plan: { ...original.view!.plan, excluded: [{ nodeId: 'root:1', eventSeq: 1 }], included: [] },
      },
    }
    const h = mount(snapshot)
    const checkbox = await screen.findByLabelText('Include root requirement in context')
    expect((checkbox as HTMLInputElement).checked).toBe(false)
    fireEvent.click(checkbox)
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 1 }, 'natural')
  })

  it('updates a checkbox optimistically and rolls it back when Harness rejects the change', async () => {
    let rejectMutation!: (cause: unknown) => void
    const mutation = new Promise<void>((_resolve, reject) => { rejectMutation = reject })
    mount(fixture(), { setNodeMode: vi.fn(() => mutation) })
    const checkbox = await screen.findByLabelText('Include root requirement in context')
    fireEvent.click(checkbox)
    expect((checkbox as HTMLInputElement).checked).toBe(false)
    expect((checkbox as HTMLInputElement).disabled).toBe(true)
    rejectMutation(new Error('revision conflict'))
    await waitFor(() => {
      expect((checkbox as HTMLInputElement).checked).toBe(true)
      expect(screen.getByRole('alert').textContent).toContain('revision conflict')
    })
  })

  it('keeps checkbox changes separate from canvas selection mode', async () => {
    const h = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    const checkbox = await screen.findByLabelText('Include root requirement in context')
    fireEvent.click(checkbox)
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 1 }, 'exclude')
    expect(h.store.getSnapshot().selectedNodeIds).toEqual([])
  })

  it('uses node clicks for additive selection while Selection mode is active', async () => {
    const h = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    fireEvent.click(await screen.findByLabelText('User message: root requirement'))
    fireEvent.click(screen.getByLabelText('User message: branch follow-up'))
    await waitFor(() => {
      expect(h.store.getSnapshot().selectedNodeIds).toEqual(['root:1', 'child:8'])
    })
    expect(h.mapActions.setNodeMode).not.toHaveBeenCalled()
  })

  it('shows a live Shift marquee and toggles every intersecting node', async () => {
    const h = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    const canvas = h.view.container.querySelector<HTMLElement>('[data-context-map-canvas]')!
    const pane = canvas.querySelector<HTMLElement>('.react-flow__pane')!
    const rootCard = await screen.findByLabelText('User message: root requirement')
    const branchCard = screen.getByLabelText('User message: branch follow-up')
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 600, width: 600, height: 600,
      toJSON: () => ({}),
    })
    vi.spyOn(rootCard, 'getBoundingClientRect').mockReturnValue({
      x: 30, y: 30, left: 30, top: 30, right: 130, bottom: 130, width: 100, height: 100,
      toJSON: () => ({}),
    })
    vi.spyOn(branchCard, 'getBoundingClientRect').mockReturnValue({
      x: 300, y: 300, left: 300, top: 300, right: 400, bottom: 400, width: 100, height: 100,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(pane, { shiftKey: true, clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(pane, { shiftKey: true, clientX: 180, clientY: 180, pointerId: 1 })
    expect(screen.getByTestId('context-map-marquee').style.width).toBe('170px')
    fireEvent.pointerUp(pane, { shiftKey: true, clientX: 180, clientY: 180, pointerId: 1 })
    await waitFor(() => {
      expect(h.store.getSnapshot().selectedNodeIds).toEqual(['root:1'])
    })
    expect(screen.queryByTestId('context-map-marquee')).toBeNull()
  })

  it('opens the original-style node menu and delegates durable actions', async () => {
    const original = fixture()
    const snapshot: ContextifyControllerSnapshot = {
      ...original,
      view: {
        ...original.view!,
        plan: { ...original.view!.plan, excluded: [{ nodeId: 'root:1', eventSeq: 1 }], included: [] },
      },
    }
    const h = mount(snapshot)
    const card = await screen.findByLabelText('User message: root requirement')
    fireEvent.contextMenu(card, { clientX: 120, clientY: 160 })
    const menu = screen.getByRole('menu', { name: 'Message actions' })
    expect(within(menu).getByRole('menuitem', { name: 'Locate in Chat' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Branch from Here' })).toBeTruthy()
    expect(within(menu).queryByRole('menuitem', { name: 'Natural' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: 'Include' })).toBeNull()
    expect(within(menu).queryByRole('menuitem', { name: 'Exclude' })).toBeNull()
    const restore = within(menu).getByRole('menuitem', { name: 'Restore automatic' })
    fireEvent.pointerDown(restore)
    fireEvent.click(restore)
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 1 }, 'natural')
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.contextMenu(card, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Locate in Chat' }))
    expect(h.mapActions.locate).toHaveBeenCalledWith(h.snapshot.graph!.nodes[0])
  })

  it('renders one tree graph without exposing layout modes', async () => {
    const h = mount()
    expect(await screen.findByLabelText('User message: root requirement')).toBeTruthy()
    expect(screen.getByText('3 / 3 in context')).toBeTruthy()
    expect(h.view.container.querySelectorAll('.react-flow__node')).toHaveLength(3)
    expect(h.view.container.querySelector('.react-flow__edges')).toBeTruthy()

    const rootCard = screen.getByLabelText('User message: root requirement')
    expect(within(rootCard).getByLabelText('Include root requirement in context')).toBeTruthy()
    fireEvent.contextMenu(rootCard, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from Here' }))
    expect(h.mapActions.branch).toHaveBeenCalledWith(h.snapshot.graph!.nodes[0])
    fireEvent.contextMenu(rootCard, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Locate in Chat' }))
    expect(h.mapActions.locate).toHaveBeenCalledWith(h.snapshot.graph!.nodes[0])

    expect(screen.queryByLabelText('Context Map layout')).toBeNull()
    expect(screen.queryByRole('button', { name: 'tree layout' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'mindmap layout' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'timeline layout' })).toBeNull()

    act(() => { h.store.actions.setLayout('mindmap') })
    await waitFor(() => {
      expect(rootCard.querySelector('.react-flow__handle-top')).toBeTruthy()
      expect(rootCard.querySelector('.react-flow__handle-bottom')).toBeTruthy()
      expect(rootCard.querySelector('.react-flow__handle-left')).toBeNull()
      expect(rootCard.querySelector('.react-flow__handle-right')).toBeNull()
    })
  })

  it('does not refocus a searched node when other cards are remeasured', async () => {
    mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Context Map' }),
      { target: { value: 'branch follow-up' } })
    act(() => { flowHarness.onNodesChange?.([{ id: 'child:8', type: 'dimensions',
      dimensions: { width: 224, height: 116 } }]) })
    await waitFor(() => { expect(flowHarness.fitView).toHaveBeenCalledWith({
      nodes: [{ id: 'child:8' }], duration: 220, maxZoom: 1.2,
    }) })
    flowHarness.fitView.mockClear()
    act(() => { flowHarness.onNodesChange?.([{ id: 'root:1', type: 'dimensions',
      dimensions: { width: 224, height: 350 } }]) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 360)) })
    expect(flowHarness.fitView).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search Context Map' }), { key: 'Enter' })
    await waitFor(() => { expect(flowHarness.fitView).toHaveBeenCalledTimes(1) })
  })

  it('lets a new search supersede an earlier explicit Map focus', async () => {
    mount({ ...fixture(), focusedNodeId: 'root:1', focusRevision: 1 })
    act(() => { flowHarness.onNodesChange?.([
      { id: 'root:1', type: 'dimensions', dimensions: { width: 224, height: 116 } },
      { id: 'child:8', type: 'dimensions', dimensions: { width: 224, height: 116 } },
    ]) })
    await waitFor(() => { expect(flowHarness.fitView).toHaveBeenCalledWith({
      nodes: [{ id: 'root:1' }], duration: 220, maxZoom: 1.2,
    }) })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Context Map' }),
      { target: { value: 'branch follow-up' } })
    await waitFor(() => { expect(flowHarness.fitView).toHaveBeenLastCalledWith({
      nodes: [{ id: 'child:8' }], duration: 220, maxZoom: 1.2,
    }) })
  })

  it('keeps measured cards visible when a fresh graph snapshot replaces controlled nodes', async () => {
    const h = mount()
    const card = (await screen.findByLabelText('User message: branch follow-up')).closest('.react-flow__node')
    act(() => { flowHarness.onNodesChange?.([{ id: 'child:8', type: 'dimensions',
      dimensions: { width: 224, height: 116 } }]) })
    await waitFor(() => { expect(card).toHaveProperty('style.visibility', 'visible') })
    act(() => { h.publishSnapshot({ ...fixture(), graph: { ...fixture().graph!,
      nodes: fixture().graph!.nodes.map(record => ({ ...record })),
    } }) })
    expect(card).toHaveProperty('style.visibility', 'visible')
  })

  it('waits for the search destination measurement and fits it when its dimensions arrive', async () => {
    mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Context Map' }),
      { target: { value: 'branch follow-up' } })
    act(() => { flowHarness.onNodesChange?.([{ id: 'root:1', type: 'dimensions',
      dimensions: { width: 224, height: 116 } }]) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 360)) })
    expect(flowHarness.fitView).not.toHaveBeenCalled()
    act(() => { flowHarness.onNodesChange?.([{ id: 'child:8', type: 'dimensions',
      dimensions: { width: 224, height: 116 } }]) })
    await waitFor(() => { expect(flowHarness.fitView).toHaveBeenCalledWith({
      nodes: [{ id: 'child:8' }], duration: 220, maxZoom: 1.2,
    }) })
  })

  it('fits the first measured graph once without resetting the viewport after refresh remeasurement', async () => {
    const h = mount()
    expect(await screen.findByLabelText('User message: root requirement')).toBeTruthy()
    act(() => {
      flowHarness.onNodesChange?.([{
        id: 'root:1', type: 'dimensions', dimensions: { width: 224, height: 116 },
      }])
    })
    await waitFor(() => { expect(flowHarness.fitView).toHaveBeenCalledTimes(1) }, { timeout: 1_000 })

    flowHarness.fitView.mockClear()
    act(() => {
      h.publishSnapshot({
        ...fixture(),
        graph: { ...fixture().graph!, nodes: [...fixture().graph!.nodes] },
      })
      flowHarness.onNodesChange?.([{
        id: 'root:1', type: 'dimensions', dimensions: { width: 224, height: 116 },
      }])
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 360)) })
    expect(flowHarness.fitView).not.toHaveBeenCalled()
  })

  it('reflows children below the measured bottom of a tall message card', async () => {
    mount()
    expect(await screen.findByLabelText('User message: root requirement')).toBeTruthy()

    act(() => {
      flowHarness.onNodesChange?.([
        { id: 'root:1', type: 'dimensions', dimensions: { width: 224, height: 340 } },
        { id: 'root:2', type: 'dimensions', dimensions: { width: 224, height: 116 } },
        { id: 'child:8', type: 'dimensions', dimensions: { width: 224, height: 116 } },
      ])
    })

    await waitFor(() => {
      const parent = flowHarness.nodes.find(candidate => candidate.id === 'root:1')!
      const childNode = flowHarness.nodes.find(candidate => candidate.id === 'root:2')!
      expect(childNode.position.y - (parent.position.y + 340)).toBeGreaterThanOrEqual(CONTEXT_MAP_RANK_GAP)
    })
  })

  it('restores deterministic node positions and fits the graph through Re-layout', async () => {
    const h = mount()
    expect(await screen.findByLabelText('User message: root requirement')).toBeTruthy()
    act(() => { h.store.actions.setPosition('root:1', { x: 900, y: 700 }) })
    expect(h.store.getSnapshot().positionOverrides).toEqual({ 'root:1': { x: 900, y: 700 } })

    flowHarness.fitView.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Re-layout' }))

    expect(h.store.getSnapshot().positionOverrides).toEqual({})
    await waitFor(() => {
      expect(flowHarness.fitView).toHaveBeenCalledWith({ duration: 220 })
    })
  })

  it('hides archived-only paths and rebinds inherited nodes to a visible Session', async () => {
    const original = fixture()
    const rootOnly = {
      ...node('root:9', 9, 'assistant', 'archived root tail'),
      sessionIds: [root],
    }
    const snapshot: ContextifyControllerSnapshot = {
      ...original,
      graph: {
        ...original.graph!,
        nodes: [...original.graph!.nodes, rootOnly],
        edges: [
          ...original.graph!.edges,
          { id: 'root-tail', source: 'root:2', target: 'root:9', sessionIds: [root] },
        ],
      },
    }
    const h = mount(snapshot, {}, [root])

    expect(await screen.findByLabelText('User message: root requirement')).toBeTruthy()
    expect(screen.queryByLabelText('Assistant message: archived root tail')).toBeNull()
    expect(h.view.container.querySelectorAll('.react-flow__node')).toHaveLength(3)
    expect(screen.getAllByText('Root Session')).toHaveLength(3)

    const inherited = screen.getByLabelText('User message: root requirement')
    fireEvent.click(within(inherited).getByLabelText('Include root requirement in context'))
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: child, seq: 1 }, 'exclude')

    fireEvent.contextMenu(inherited, {
      clientX: 120, clientY: 160,
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Locate in Chat' }))
    expect(h.mapActions.locate).toHaveBeenCalledWith(expect.objectContaining({
      id: 'root:1',
      owner: { sessionId: child, seq: 1 },
      sessionIds: [child],
    }))

    fireEvent.contextMenu(inherited, { clientX: 120, clientY: 160 })
    const branch = screen.getByRole('menuitem', { name: 'Branch from Here' })
    await waitFor(() => { expect((branch as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(branch)
    expect(h.mapActions.branch).toHaveBeenCalledWith(expect.objectContaining({
      owner: { sessionId: child, seq: 1 },
    }))
  })

  it('searches cyclically and applies one batch selection mutation', async () => {
    const h = mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Context Map' }), { target: { value: 'r' } })
    expect(await screen.findByText('1 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next search result' }))
    expect(screen.getByText('2 / 3')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    h.store.actions.setNodeSelected('root:1', true)
    h.store.actions.setNodeSelected('child:8', true)
    await waitFor(() => { expect(screen.getByText('2 selected')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Exclude from context' }))
    expect(h.mapActions.setNodeModes).toHaveBeenCalledWith([
      { node: { sessionId: root, seq: 1 }, mode: 'exclude' },
      { node: { sessionId: child, seq: 8 }, mode: 'exclude' },
    ])
    const restore = screen.getByRole('button', { name: 'Restore automatic' })
    await waitFor(() => { expect((restore as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(restore)
    expect(h.mapActions.setNodeModes).toHaveBeenLastCalledWith([
      { node: { sessionId: root, seq: 1 }, mode: 'natural' },
      { node: { sessionId: child, seq: 8 }, mode: 'natural' },
    ])
    const undo = screen.getByRole('button', { name: 'Undo' })
    await waitFor(() => { expect((undo as HTMLButtonElement).disabled).toBe(false) })
    fireEvent.click(undo)
    expect(h.mapActions.undo).toHaveBeenCalledOnce()
  })

  it('describes Reset as clearing durable manual changes', async () => {
    const h = mount()
    const reset = await screen.findByRole('button', { name: 'Clear manual changes' })
    fireEvent.click(reset)
    expect(h.mapActions.reset).toHaveBeenCalledOnce()
  })

  it('keeps Local as the primary action and exposes model modes only through a manual menu', async () => {
    const h = mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Recommend' }))
    expect(h.mapActions.recommend).toHaveBeenCalledWith('local')

    fireEvent.click(screen.getByRole('button', { name: 'Recommendation mode' }))
    const menu = screen.getByRole('menu', { name: 'Recommendation mode' })
    expect(menu.getAttribute('data-opaque-surface')).toBe('true')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Deep tree review' }))
    expect(h.mapActions.recommend).toHaveBeenLastCalledWith('deep')
  })

  it('shows non-blocking Deep progress and an explicit Cancel action', () => {
    const original = fixture()
    const h = mount({
      ...original,
      recommendation: { phase: 'running', mode: 'deep' },
    })
    expect(screen.getByRole('button', { name: 'Inspecting tree…' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Deep review' }))
    expect(h.mapActions.cancelRecommendation).toHaveBeenCalledOnce()
  })

  it('reviews recommendations without changing checkboxes before explicit acceptance', async () => {
    const original = fixture()
    const proposal = {
      mode: 'deep' as const,
      base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
      currentNodeIds: ['root:1', 'root:2', 'child:8'],
      proposedNodeIds: ['root:2', 'child:8'],
      addedNodeIds: [],
      removedNodeIds: ['root:1'],
      selection: [{
        nodeId: 'root:1', action: 'exclude' as const, reason: 'Superseded', confidence: 'high' as const,
      }],
      archive: [{
        nodeId: 'root:2', category: 'obsolete' as const, reason: 'Old draft',
        evidenceNodeIds: ['child:8'],
      }],
    }
    const snapshot: ContextifyControllerSnapshot = {
      ...original,
      recommendation: { phase: 'ready', proposal },
    }
    const h = mount(snapshot)
    const checkbox = await screen.findByLabelText('Include root requirement in context')
    expect((checkbox as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Suggested exclude')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Context recommendation review' })).toBeTruthy()
    expect(h.mapActions.presentRecommendation).toHaveBeenCalledWith(proposal)
    expect(screen.getByText('Deep tree review')).toBeTruthy()
    expect(screen.getByText('Current context')).toBeTruthy()
    expect(screen.getByText('Proposed context')).toBeTruthy()
    expect(screen.getByText('0 added')).toBeTruthy()
    expect(screen.getByText('1 removed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Apply proposed context' }))
    expect(h.mapActions.applyRecommendations).toHaveBeenCalledWith([])
    expect((checkbox as HTMLInputElement).checked).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Review archive' }))
    expect(screen.getByText('Before')).toBeTruthy()
    expect(screen.getByText('After')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Placeholder for root:2' })).toBeNull()
    expect(screen.getByText('Empty placeholder')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Archive node' }))
    expect(h.mapActions.confirmArchive).toHaveBeenCalledWith(proposal.archive[0])
    fireEvent.click(screen.getByRole('button', { name: 'Close recommendation review' }))
    expect(h.mapActions.dismissRecommendation).toHaveBeenCalledOnce()
    expect(h.mapActions.dismissRecommendation).toHaveBeenCalledWith([])
  })

  it('shows a draft route separately from Context edits and waits for explicit acceptance', async () => {
    const original = fixture()
    const route = { action: 'return' as const, base: {
      planRevision: 3, graphRevision: 'family-20', activeSessionId: child,
    }, objective: 'Return to the main thread', targetSessionId: root,
    reason: 'Return to the parent branch.' }
    const proposal = { mode: 'fast' as const, base: route.base,
      currentNodeIds: ['root:1', 'root:2', 'child:8'],
      proposedNodeIds: ['root:1', 'root:2', 'child:8'],
      addedNodeIds: [], removedNodeIds: [], selection: [], archive: [], route }
    const h = mount({ ...original, recommendation: { phase: 'ready', proposal } })
    expect(screen.getByText('Where this draft belongs')).toBeTruthy()
    expect(h.mapActions.acceptRoute).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Return with draft' }))
    expect(h.mapActions.acceptRoute).toHaveBeenCalledWith(route)
    fireEvent.click(screen.getByRole('button', { name: 'Move draft with proposed Context' }))
    expect(h.mapActions.acceptRoute).toHaveBeenCalledWith(route, true)
    expect(h.mapActions.applyRecommendations).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Stay in this branch' }))
    expect(h.mapActions.rejectRoute).toHaveBeenCalledWith(route)
  })

  it('lets a user keep one current context item while applying another', async () => {
    const original = fixture()
    const proposal = {
      mode: 'fast' as const,
      base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
      currentNodeIds: ['root:1', 'root:2', 'child:8'],
      proposedNodeIds: ['child:8'],
      addedNodeIds: [],
      removedNodeIds: ['root:1', 'root:2'],
      selection: [
        { nodeId: 'root:1', action: 'exclude' as const, reason: 'Old requirement', confidence: 'high' as const },
        { nodeId: 'root:2', action: 'exclude' as const, reason: 'Old answer', confidence: 'high' as const },
      ],
      archive: [],
    }
    const h = mount({ ...original, recommendation: { phase: 'ready', proposal } })
    fireEvent.click(await screen.findByRole('button', { name: 'Keep current context for root requirement' }))
    expect(screen.getByRole('button', { name: 'Use proposed change for root requirement' })
      .getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('1 removed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected changes' }))
    expect(h.mapActions.applyRecommendations).toHaveBeenCalledWith(['root:1'])
    fireEvent.click(screen.getByRole('button', { name: 'Close recommendation review' }))
    expect(h.mapActions.dismissRecommendation).toHaveBeenCalledWith(['root:1'])
  })

  it('keeps a replacement on the same node and exposes original/restore from the native menu', async () => {
    const original = fixture()
    const records = original.graph!.nodes.map(record => record.id === 'root:2' ? {
      ...record,
      replacement: {
        kind: 'placeholder' as const,
        preview: '[Earlier answer removed]', reason: 'obsolete', role: 'assistant' as const,
        original: 'old draft',
        originalAvailable: true as const,
      },
    } : record)
    const h = mount({ ...original, graph: { ...original.graph!, nodes: records } })
    const card = await screen.findByLabelText('Assistant empty placeholder')
    expect(card.dataset.contextNodeId).toBe('root:2')
    expect(card.querySelector('p')?.dataset.preview).toBe('')
    expect(card.textContent).not.toContain('[Earlier answer removed]')
    expect(within(card).getByText('Archived')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Context Map' }), {
      target: { value: '[Earlier answer removed]' },
    })
    expect(screen.getByText('0 / 0')).toBeTruthy()

    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    expect(screen.getByRole('menu').getAttribute('data-opaque-surface')).toBe('true')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show original' }))
    expect(screen.getByRole('dialog', { name: 'Original message' }).textContent).toContain('old draft')
    fireEvent.click(screen.getByRole('button', { name: 'Close original message' }))

    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Restore node' }))
    expect(h.mapActions.restoreNode).toHaveBeenCalledWith({ sessionId: root, seq: 2 })
    expect(h.view.container.querySelectorAll('.react-flow__node')).toHaveLength(3)
  })

  it('lets the user retain an exact Unicode excerpt from an active chat message', async () => {
    const full = 'Sony 🎙️ HU-80 for $14.99. Or JVC for $90.'
    const current = fixture()
    const records = current.graph!.nodes.map(record => record.id === 'child:8'
      ? { ...record, preview: full } : record)
    const getNodeText = vi.fn(async () => full)
    const focusNodeExcerpt = vi.fn(async () => {})
    mount({ ...current, graph: { ...current.graph!, nodes: records } }, {
      getNodeText, focusNodeExcerpt,
    })
    const card = await screen.findByLabelText(`User message: ${full}`)
    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keep text excerpt…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Keep text excerpt' })
    expect(getNodeText).toHaveBeenCalledWith({ sessionId: child, seq: 8 })
    const field = within(dialog).getByRole('textbox', { name: 'Original text for excerpt' }) as HTMLTextAreaElement
    field.setSelectionRange(0, full.indexOf(' Or '))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep selected text' }))
    await waitFor(() => {
      expect(focusNodeExcerpt).toHaveBeenCalledWith({ sessionId: child, seq: 8 },
        0, Array.from(full.slice(0, full.indexOf(' Or '))).length)
    })
  })

  it('shows a focused excerpt while keeping the original available', async () => {
    const original = fixture()
    const full = 'Sony HU-80 or JVC, followed by the full original detail'
    const getNodeText = vi.fn(async () => full)
    const records = original.graph!.nodes.map(record => record.id === 'root:2' ? {
      ...record,
      replacement: { kind: 'excerpt' as const, preview: 'Sony HU-80',
        original: 'Sony HU-80 or JVC…', reason: 'Focused by user',
        role: 'assistant' as const, originalAvailable: true as const },
    } : record)
    mount({ ...original, graph: { ...original.graph!, nodes: records } }, { getNodeText })
    const card = await screen.findByLabelText('Assistant message: Sony HU-80')
    expect(card.querySelector('p')?.dataset.preview).toBe('Sony HU-80')
    expect(within(card).getByText('Focused excerpt')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Context Map' }),
      { target: { value: 'Sony HU-80' } })
    expect(await screen.findByText('1 / 1')).toBeTruthy()
    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show original' }))
    expect((await screen.findByRole('dialog', { name: 'Original message' })).textContent)
      .toContain(full)
    expect(getNodeText).toHaveBeenCalledWith({ sessionId: root, seq: 2 })
  })

  it('archives an individual input or output from the native node menu', async () => {
    const h = mount()
    const card = await screen.findByLabelText('Assistant message: old draft')

    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive node' }))

    expect(h.mapActions.archiveNode).toHaveBeenCalledWith({ sessionId: root, seq: 2 })
  })
})

describe('canvas interaction rules', () => {
  it('derives the effective checkbox result from path membership and manual overrides', () => {
    expect(effectiveContextIncluded(true, 'natural')).toBe(true)
    expect(effectiveContextIncluded(true, 'exclude')).toBe(false)
    expect(effectiveContextIncluded(true, 'include')).toBe(true)
    expect(effectiveContextIncluded(false, 'natural')).toBe(false)
    expect(effectiveContextIncluded(false, 'include')).toBe(true)
    expect(effectiveContextIncluded(false, 'exclude')).toBe(false)
  })

  it('removes a manual override when the checkbox returns to its automatic result', () => {
    expect(effectiveContextMode(true, true)).toBe('natural')
    expect(effectiveContextMode(true, false)).toBe('exclude')
    expect(effectiveContextMode(false, false)).toBe('natural')
    expect(effectiveContextMode(false, true)).toBe('include')
  })

  it('detects rectangles that overlap at an edge', () => {
    expect(intersects(
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 20, y: 5, width: 10, height: 10 },
    )).toBe(true)
    expect(intersects(
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 21, y: 5, width: 10, height: 10 },
    )).toBe(false)
  })

  it('keeps drag coordinates transient until the final position change', () => {
    const moving = reducePositionChanges({}, [{
      id: 'root:1', position: { x: 40, y: 50 }, dragging: true,
    }])
    expect(moving.transient).toEqual({ 'root:1': { x: 40, y: 50 } })
    expect(moving.committed).toEqual([])

    const stopped = reducePositionChanges(moving.transient, [{
      id: 'root:1', position: { x: 70, y: 80 }, dragging: false,
    }])
    expect(stopped.transient).toEqual({})
    expect(stopped.committed).toEqual([{ id: 'root:1', position: { x: 70, y: 80 } }])
  })
})

describe('ContextMessageAction', () => {
  it('correlates a local Chat seq with the graph and controls the shared plan', () => {
    const snapshot = fixture()
    const setNodeMode = vi.fn(async () => {})
    const locate = vi.fn()
    render(
      <ContextMessageAction
        t={stewardTestTranslator()}
        seq={8}
        useContextify={bindSnapshotSelector({ getSnapshot: () => snapshot, subscribe: () => () => {} })}
        setNodeMode={setNodeMode}
        locate={locate}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'exclude context for branch follow-up' }))
    expect(setNodeMode).toHaveBeenCalledWith({ sessionId: child, seq: 8 }, 'exclude')
    fireEvent.click(screen.getByRole('button', { name: 'Locate branch follow-up in Context Map' }))
    expect(locate).toHaveBeenCalledWith('child:8')
  })
})

describe('ContextifyController', () => {
  it('creates an Agent-backed native fork before completing a Branch relocation', async () => {
    const currentView = fixture().view!
    const preparation = { sourceSessionId: root, beforeSeq: 5 }
    const calls: string[] = []
    const transport: ContextifyTransport = {
      get: async () => currentView,
      familyPage: async () => ({
        asOfSeq: 20,
        revision: 'family-20',
        rootSessionId: root,
        activeSessionId: child,
        sessions: fixture().graph!.sessions,
        edges: fixture().graph!.edges,
        records: fixture().graph!.nodes,
        totalNodeCount: 3,
      }),
      setNodeMode: vi.fn(async () => currentView),
      setNodeModes: vi.fn(async () => currentView),
      reset: vi.fn(async () => currentView),
      undo: vi.fn(async () => currentView),
      redo: vi.fn(async () => currentView),
      recommend: vi.fn(async () => ({
        mode: 'fast' as const,
        base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
        currentNodeIds: [], proposedNodeIds: [], addedNodeIds: [], removedNodeIds: [], selection: [], archive: [],
      })),
      cancelRecommendation: vi.fn(async () => {}),
      presentRecommendation: vi.fn(async () => {}),
      dismissRecommendation: vi.fn(async () => {}),
      archiveNode: vi.fn(async () => currentView),
      getNodeText: vi.fn(async () => ''),
      focusNodeExcerpt: vi.fn(async () => currentView),
      restoreNode: vi.fn(async () => currentView),
      prepareBranchSuggestion: vi.fn(async () => { calls.push('prepare'); return preparation }),
      keepBranchSuggestion: vi.fn(async () => {}),
      forkNativeBranch: vi.fn(async (value) => {
        calls.push('fork')
        expect(value).toEqual(preparation)
        return child
      }),
      acceptBranchSuggestion: vi.fn(async (suggestionId: string, childSessionId: SessionId) => {
        calls.push('complete')
        expect([suggestionId, childSessionId]).toEqual(['suggestion-1', child])
        return { childSessionId }
      }),
    }
    const controller = new ContextifyController(transport)
    await controller.refresh()

    await expect(controller.acceptBranchSuggestion('suggestion-1')).resolves.toEqual({ childSessionId: child })
    expect(calls).toEqual(['prepare', 'fork', 'complete'])
  })

  it('keeps an equivalent proposal across polling and marks it stale when its graph base changes', async () => {
    let currentView = fixture().view!
    let resolveProposal!: (value: Awaited<ReturnType<ContextifyTransport['recommend']>>) => void
    const proposalPromise = new Promise<Awaited<ReturnType<ContextifyTransport['recommend']>>>((resolve) => {
      resolveProposal = resolve
    })
    const transport: ContextifyTransport = {
      get: async () => currentView,
      familyPage: async () => ({
        asOfSeq: currentView.graphAsOfSeq,
        revision: `family-${String(currentView.graphAsOfSeq)}`,
        rootSessionId: root,
        activeSessionId: child,
        sessions: fixture().graph!.sessions,
        edges: fixture().graph!.edges,
        records: fixture().graph!.nodes,
        totalNodeCount: 3,
      }),
      setNodeMode: vi.fn(async () => currentView),
      setNodeModes: vi.fn(async () => currentView),
      reset: vi.fn(async () => currentView),
      undo: vi.fn(async () => currentView),
      redo: vi.fn(async () => currentView),
      recommend: vi.fn(() => proposalPromise),
      cancelRecommendation: vi.fn(async () => {}),
      presentRecommendation: vi.fn(async () => {}),
      dismissRecommendation: vi.fn(async () => {}),
      archiveNode: vi.fn(async () => currentView),
      getNodeText: vi.fn(async () => ''),
      focusNodeExcerpt: vi.fn(async () => currentView),
      restoreNode: vi.fn(async () => currentView),
      prepareBranchSuggestion: vi.fn(async () => ({ sourceSessionId: root, beforeSeq: 5 })),
      keepBranchSuggestion: vi.fn(async () => {}),
      forkNativeBranch: vi.fn(async () => child),
      acceptBranchSuggestion: vi.fn(async () => ({ childSessionId: child })),
    }
    const controller = new ContextifyController(transport)
    await controller.refresh()
    const recommending = controller.recommend()
    await vi.waitFor(() => { expect(controller.getSnapshot().recommendation.phase).toBe('running') })
    const proposal = {
      mode: 'fast' as const,
      base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
      currentNodeIds: ['root:1', 'root:2', 'child:8'], proposedNodeIds: ['root:1', 'root:2', 'child:8'],
      addedNodeIds: [], removedNodeIds: [], selection: [], archive: [],
    }
    resolveProposal(proposal)
    await recommending
    expect(controller.getSnapshot().recommendation).toMatchObject({ phase: 'ready', proposal })

    await controller.refresh()
    expect(controller.getSnapshot().recommendation).toMatchObject({ phase: 'ready', proposal })
    currentView = { ...currentView, graphAsOfSeq: 21 }
    await controller.refresh()
    expect(controller.getSnapshot().recommendation).toMatchObject({ phase: 'stale', proposal })
    await controller.dismissRecommendation()
    expect(transport.dismissRecommendation).toHaveBeenCalledWith(proposal, [])
    expect(controller.getSnapshot().recommendation).toEqual({ phase: 'idle' })
  })

  it('waits for an in-flight refresh before choosing the mutation revision', async () => {
    let resolveView!: (value: ContextifyControllerSnapshot['view']) => void
    const viewPromise = new Promise<ContextifyControllerSnapshot['view']>((resolve) => { resolveView = resolve })
    const setNodeMode = vi.fn(async (_ref, _node, _mode) => fixture().view!)
    const transport: ContextifyTransport = {
      get: async () => (await viewPromise)!,
      familyPage: async () => ({
        asOfSeq: 20,
        revision: 'family-20',
        rootSessionId: root,
        activeSessionId: child,
        sessions: fixture().graph!.sessions,
        edges: fixture().graph!.edges,
        records: fixture().graph!.nodes,
        totalNodeCount: 3,
      }),
      setNodeMode,
      setNodeModes: vi.fn(async () => fixture().view!),
      reset: vi.fn(async () => fixture().view!),
      undo: vi.fn(async () => fixture().view!),
      redo: vi.fn(async () => fixture().view!),
      recommend: vi.fn(async () => ({
        mode: 'fast' as const,
        base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
        currentNodeIds: ['root:1', 'root:2', 'child:8'], proposedNodeIds: ['root:1', 'root:2', 'child:8'],
        addedNodeIds: [], removedNodeIds: [], selection: [], archive: [],
      })),
      cancelRecommendation: vi.fn(async () => {}),
      presentRecommendation: vi.fn(async () => {}),
      dismissRecommendation: vi.fn(async () => {}),
      archiveNode: vi.fn(async () => fixture().view!),
      getNodeText: vi.fn(async () => ''),
      focusNodeExcerpt: vi.fn(async () => fixture().view!),
      restoreNode: vi.fn(async () => fixture().view!),
      prepareBranchSuggestion: vi.fn(async () => ({ sourceSessionId: root, beforeSeq: 5 })),
      keepBranchSuggestion: vi.fn(async () => {}),
      forkNativeBranch: vi.fn(async () => child),
      acceptBranchSuggestion: vi.fn(async () => ({ childSessionId: child })),
    }
    const controller = new ContextifyController(transport)
    const refresh = controller.refresh()
    const mutation = controller.setNodeMode({ sessionId: child, seq: 8 }, 'exclude')
    expect(setNodeMode).not.toHaveBeenCalled()
    resolveView(fixture().view)
    await refresh
    await mutation
    expect(setNodeMode).toHaveBeenCalledWith(
      { revision: 3 },
      { sessionId: child, seq: 8 },
      'exclude',
    )
  })

  it('cancels a Deep review without allowing its late result to replace idle state', async () => {
    let resolveProposal!: (value: Awaited<ReturnType<ContextifyTransport['recommend']>>) => void
    const proposalPromise = new Promise<Awaited<ReturnType<ContextifyTransport['recommend']>>>((resolve) => {
      resolveProposal = resolve
    })
    const currentView = fixture().view!
    const transport: ContextifyTransport = {
      get: async () => currentView,
      familyPage: async () => ({
        asOfSeq: 20,
        revision: 'family-20',
        rootSessionId: root,
        activeSessionId: child,
        sessions: fixture().graph!.sessions,
        edges: fixture().graph!.edges,
        records: fixture().graph!.nodes,
        totalNodeCount: 3,
      }),
      setNodeMode: vi.fn(async () => currentView),
      setNodeModes: vi.fn(async () => currentView),
      reset: vi.fn(async () => currentView),
      undo: vi.fn(async () => currentView),
      redo: vi.fn(async () => currentView),
      recommend: vi.fn(() => proposalPromise),
      cancelRecommendation: vi.fn(async () => {}),
      presentRecommendation: vi.fn(async () => {}),
      dismissRecommendation: vi.fn(async () => {}),
      archiveNode: vi.fn(async () => currentView),
      getNodeText: vi.fn(async () => ''),
      focusNodeExcerpt: vi.fn(async () => currentView),
      restoreNode: vi.fn(async () => currentView),
      prepareBranchSuggestion: vi.fn(async () => ({ sourceSessionId: root, beforeSeq: 5 })),
      keepBranchSuggestion: vi.fn(async () => {}),
      forkNativeBranch: vi.fn(async () => child),
      acceptBranchSuggestion: vi.fn(async () => ({ childSessionId: child })),
    }
    const controller = new ContextifyController(transport)
    await controller.refresh()

    const recommendation = controller.recommend('deep')
    await vi.waitFor(() => { expect(controller.getSnapshot().recommendation).toEqual({ phase: 'running', mode: 'deep' }) })
    expect(transport.recommend).toHaveBeenCalledWith(
      { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
      undefined,
      'deep',
      false,
    )

    await controller.cancelRecommendation()
    expect(transport.cancelRecommendation).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().recommendation).toEqual({ phase: 'idle' })

    resolveProposal({
      mode: 'deep',
      base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
      currentNodeIds: ['root:1'], proposedNodeIds: ['root:1'],
      addedNodeIds: [], removedNodeIds: [], selection: [], archive: [],
    })
    await recommendation
    expect(controller.getSnapshot().recommendation).toEqual({ phase: 'idle' })
  })

  it('can clear a transient graph focus target', () => {
    const transport = {} as ContextifyTransport
    const controller = new ContextifyController(transport)
    controller.focus('root:1')
    expect(controller.getSnapshot().focusedNodeId).toBe('root:1')
    controller.focus(undefined)
    expect(controller.getSnapshot().focusedNodeId).toBeUndefined()
  })
})


describe('Context Map recovery and explicit evidence boundaries', () => {
  function coldProfile(): ContextStewardProfile {
    const empty = { acceptRate: 0.5, support: 0 }
    return { evidence: empty, destination: empty, branch: empty, return: empty, release: empty,
      thresholds: { evidence: 0.7, destination: 0.7 }, rules: [] }
  }

  it.each([new Error('profile is offline'), 'profile is offline'])('retries a failed read-only preference load without mutating context (%#)', async (cause) => {
    const inspectPolicy = vi.fn().mockRejectedValueOnce(cause).mockResolvedValue(coldProfile())
    const h = mount(fixture(), { inspectPolicy })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    expect((await screen.findByRole('alert')).textContent).toContain('profile is offline')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No confirmed Context choices yet.')).toBeTruthy()
    expect(inspectPolicy).toHaveBeenCalledTimes(2)
    expect(h.mapActions.setNodeMode).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    expect(screen.queryByRole('region', { name: 'Learned Context preferences' })).toBeNull()
  })

  it('ignores a rejected preference request after the pane was closed', async () => {
    let reject!: (reason: unknown) => void
    const pending = new Promise<ContextStewardProfile>((_resolve, fail) => { reject = fail })
    mount(fixture(), { inspectPolicy: vi.fn(() => pending) })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Context preferences' }))
    await act(async () => { reject(new Error('old offline response')) })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows undone and legacy evidence honestly and resets only the derived profile', async () => {
    const profile: ContextStewardProfile = { ...coldProfile(),
      destination: { acceptRate: 0.8, support: 2 }, release: { acceptRate: 0.2, support: 3 },
      rules: [{ action: 'release', activity: 'writing', tendency: 'avoid', support: 3, acceptRate: 0.2 }] }
    const evidence: ContextPolicyObservation[] = [
      { action: 'include', choice: 'reject', origin: 'explicit-review', branchDepth: 0, at: 0,
        objective: 'Keep current facts', targetNodeId: 'unavailable-old-source', targetSessionId: root, undone: true },
      { action: 'release', choice: 'accept', origin: 'manual-action', branchDepth: 1, at: 1,
        sourceSessionId: child, sourceEventSeq: 93, targetNodeId: 'root:2', displayedIndex: 0, weight: 0.5 },
    ]
    const inspectPolicy = vi.fn().mockResolvedValueOnce(profile).mockResolvedValue(coldProfile())
    const policyEvidence = vi.fn().mockResolvedValueOnce(evidence).mockResolvedValue([])
    const h = mount(fixture(), { inspectPolicy, policyEvidence })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    await waitFor(() => { expect(screen.getAllByText(/3 effective reviews/).length).toBeGreaterThan(0) })
    fireEvent.click(screen.getByText('Recent explicit choices'))
    expect(screen.getByText(/unavailable-old-source/)).toBeTruthy()
    expect(screen.getByText(/child-session:93/)).toBeTruthy()
    expect(screen.getByText(/old draft/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset learned preferences' }))
    await waitFor(() => { expect(h.mapActions.resetPolicy).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('No confirmed Context choices yet.')).toBeTruthy()
    expect(h.mapActions.reset).not.toHaveBeenCalled()
    expect(h.mapActions.setNodeModes).not.toHaveBeenCalled()
  })

  it.each(['Error', 'string'])('rolls back an optimistic checkbox on a failed source mutation (%s)', async (kind) => {
    const h = mount(fixture(), { setNodeMode: vi.fn(async () => { throw kind === 'Error' ? new Error('revision changed') : 'revision changed' }) })
    const card = await screen.findByLabelText('User message: root requirement')
    const field = within(card).getByLabelText('Include root requirement in context')
    fireEvent.click(field)
    expect((await screen.findByRole('alert')).textContent).toContain('revision changed')
    await waitFor(() => { expect((field as HTMLInputElement).checked).toBe(true) })
    expect(h.mapActions.setNodeMode).toHaveBeenCalledTimes(1)
  })

  it('keeps an excerpt dialog open when nothing is selected, and lets the user cancel safely', async () => {
    const h = mount(fixture(), { getNodeText: vi.fn(async () => 'Full original source') })
    fireEvent.contextMenu(await screen.findByLabelText('User message: branch follow-up'), { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keep text excerpt…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Keep text excerpt' })
    const field = within(dialog).getByRole('textbox', { name: 'Original text for excerpt' }) as HTMLTextAreaElement
    field.setSelectionRange(0, 0)
    fireEvent.pointerDown(dialog)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep selected text' }))
    expect(screen.getByRole('alert').textContent).toContain('Select text to keep first')
    expect(h.mapActions.focusNodeExcerpt).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close text excerpt' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a synchronous Locate error and asynchronous Branch error instead of losing the menu action', async () => {
    const h = mount(fixture(), { locate: vi.fn(() => { throw new Error('source unavailable') }),
      branch: vi.fn(async () => { throw 'branch unavailable' }) })
    const card = await screen.findByLabelText('User message: branch follow-up')
    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Locate in Chat' }))
    expect(screen.getByRole('alert').textContent).toContain('source unavailable')
    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from Here' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('branch unavailable') })
    expect(h.mapActions.branch).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()
  })
  it('renders initial loading and an empty recovered graph without enabling model review', async () => {
    const h = mount({ phase: 'loading', pending: false, recommendation: { phase: 'idle' } })
    expect(screen.getAllByText(/Loading/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: 'Recommend' })).toHaveProperty('disabled', true)
    const ready = fixture()
    act(() => { h.publishSnapshot({ ...ready, graph: { ...ready.graph!, nodes: [], edges: [], sessions: [] } }) })
    expect(screen.getByText('No message nodes yet.')).toBeTruthy()
  })

  it('renders included overrides and sparse route preferences with unknown historical nodes', async () => {
    const current = fixture()
    const profile: ContextStewardProfile = { ...coldProfile(),
      branch: { support: 1, acceptRate: 0.7 },
      rules: [{ action: 'include', sourceKind: 'chat', tendency: 'avoid', support: 1, acceptRate: 0.1 }] }
    mount({ ...current, view: { ...current.view!, plan: { ...current.view!.plan,
      included: [{ nodeId: 'root:1', snapshotSeq: 1, position: 0 }] } } }, {
      inspectPolicy: vi.fn(async () => profile),
      policyEvidence: vi.fn(async (): Promise<readonly ContextPolicyObservation[]> => [{ action: 'branch', choice: 'reject', origin: 'manual-action',
        branchDepth: 0, at: 0, targetNodeId: 'old-missing' }]),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    expect(await screen.findByText(/Often declined/)).toBeTruthy()
    expect(screen.queryByText('No confirmed route choices yet')).toBeNull()
    expect(screen.getByText(/old-missing/)).toBeTruthy()
  })

  it('keeps a low support profile provisional and closes preferences via the header toggle', async () => {
    mount(fixture(), { inspectPolicy: vi.fn(async () => ({ ...coldProfile(), evidence: { support: 1, acceptRate: 0.7 } })) })
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    expect(await screen.findByText(/More confirmed choices/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Context preferences' }))
    expect(screen.queryByRole('region', { name: 'Learned Context preferences' })).toBeNull()
  })

  it('uses the public canvas callbacks to dismiss menus and select a measured card', async () => {
    const h = mount()
    const card = await screen.findByLabelText('User message: branch follow-up')
    fireEvent.contextMenu(card, { clientX: 160, clientY: 180 })
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(card)
    act(() => { flowHarness.props?.onPaneClick?.(new MouseEvent('click') as unknown as React.MouseEvent) })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.contextMenu(card)
    // Search/initial fit can start after a right-click; it owns no user gesture.
    act(() => { flowHarness.props?.onMoveStart?.(null, { x: 0, y: 0, zoom: 1 }) })
    expect(screen.getByRole('menu')).toBeTruthy()
    act(() => { flowHarness.props?.onMoveStart?.(new MouseEvent('pointerdown'), { x: 0, y: 0, zoom: 1 }) })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    const target = flowHarness.nodes.find(value => value.id === 'child:8')
    if (target === undefined) throw new Error('Expected branch card in public canvas')
    act(() => { flowHarness.props?.onNodeClick?.({} as React.MouseEvent, target) })
    expect(h.store.getSnapshot().selectedNodeIds).toContain('child:8')
    act(() => { flowHarness.onNodesChange?.([{ type: 'select', id: 'child:8', selected: false }]) })
    expect(h.store.getSnapshot().selectedNodeIds).not.toContain('child:8')
  })

  it('commits only settled drag positions and cancels a relayout on unmount', async () => {
    const h = mount()
    await screen.findByLabelText('User message: branch follow-up')
    act(() => { flowHarness.onNodesChange?.([{ type: 'position', id: 'child:8', position: { x: 8, y: 9 }, dragging: true },
      { type: 'position', id: 'root:1' }]) })
    expect(h.store.getSnapshot().positionOverrides['child:8']).toBeUndefined()
    expect(flowHarness.nodes.find(value => value.id === 'child:8')?.position).toEqual({ x: 8, y: 9 })
    act(() => { flowHarness.onNodesChange?.([{ type: 'position', id: 'child:8', position: { x: 11, y: 12 }, dragging: false }]) })
    expect(h.store.getSnapshot().positionOverrides['child:8']).toEqual({ x: 11, y: 12 })
    flowHarness.fitView.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Re-layout' }))
    fireEvent.click(screen.getByRole('button', { name: 'Re-layout' }))
    h.view.unmount()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(flowHarness.fitView).not.toHaveBeenCalled()
  })

  it('ignores unrelated pointers and cancels a real marquee without changing selection', async () => {
    const h = mount()
    const card = await screen.findByLabelText('User message: branch follow-up')
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    const canvas = h.view.container.querySelector<HTMLElement>('[data-context-map-canvas]')!
    fireEvent.pointerMove(canvas, { pointerId: 2 })
    fireEvent.pointerUp(canvas, { pointerId: 2 })
    fireEvent.pointerDown(card, { pointerId: 1, shiftKey: true })
    expect(screen.queryByTestId('context-map-marquee')).toBeNull()
    fireEvent.pointerDown(canvas, { pointerId: 1, shiftKey: true, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 90, clientY: 90 })
    fireEvent.pointerUp(canvas, { pointerId: 2 })
    expect(screen.getByTestId('context-map-marquee')).toBeTruthy()
    act(() => {
      // React may replay a queued continuous move after the discrete cancel.
      fireEvent.pointerCancel(canvas, { pointerId: 1 })
      fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 90, clientY: 90 })
    })
    expect(screen.queryByTestId('context-map-marquee')).toBeNull()
    expect(h.store.getSnapshot().selectedNodeIds).toEqual([])
  })

  it.each(['local', 'fast', 'deep'] as const)('lets the controller own a failed %s review without duplicating an alert', async (mode) => {
    const h = mount(fixture(), { recommend: vi.fn(async () => { throw new Error('controller owns this error') }) })
    fireEvent.click(screen.getByRole('button', { name: 'Recommendation mode' }))
    fireEvent.click(screen.getByRole('menuitem', { name: mode === 'local' ? 'Local review' : mode === 'fast' ? 'Fast review' : 'Deep tree review' }))
    await act(async () => {})
    expect(h.mapActions.recommend).toHaveBeenCalledWith(mode)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('dispatches Redo and contains a rejected cancel without a duplicated review error', async () => {
    const current = fixture()
    const h = mount({ ...current, view: { ...current.view!, canRedo: true },
      recommendation: { phase: 'running', mode: 'deep' } }, {
      cancelRecommendation: vi.fn(async () => { throw new Error('already cancelled') }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }))
    await waitFor(() => { expect(h.mapActions.redo).toHaveBeenCalledOnce() })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Deep review' }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('includes selected messages as one transaction and clears only canvas selection', async () => {
    const h = mount()
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    act(() => { h.store.actions.setNodeSelected('root:1', true) })
    fireEvent.click(screen.getByRole('button', { name: 'Include in context' }))
    await waitFor(() => { expect(h.mapActions.setNodeModes).toHaveBeenCalledWith([{ node: { sessionId: root, seq: 1 }, mode: 'natural' }]) })
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(h.store.getSnapshot().selectedNodeIds).toEqual([])
    expect(h.mapActions.reset).not.toHaveBeenCalled()
  })

  it('closes a replacement original and falls back to the full preview when its stored original is empty', async () => {
    const current = fixture()
    const records = current.graph!.nodes.map(record => record.id === 'root:2' ? {
      ...record, replacement: { kind: 'placeholder' as const, preview: '', original: '', reason: 'Archived',
        role: 'assistant' as const, originalAvailable: true as const },
    } : record)
    const h = mount({ ...current, graph: { ...current.graph!, nodes: records } })
    fireEvent.contextMenu(await screen.findByLabelText('Assistant empty placeholder'), { clientX: 160, clientY: 180 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show original' }))
    expect(screen.getByRole('dialog', { name: 'Original message' }).textContent).toContain('old draft')
    fireEvent.click(screen.getByRole('button', { name: 'Close original message' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { h.publishSnapshot({ ...current, graph: { ...current.graph!, nodes: records.map(record => ({ ...record, preview: '' })) } }) })
    fireEvent.contextMenu(await screen.findByLabelText('Assistant empty placeholder'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show original' }))
    expect(screen.getByRole('dialog', { name: 'Original message' }).textContent).toContain('(empty message)')
  })

  it('shows recovered snapshot errors and treats an unknown session label as a depth-zero branch', async () => {
    const current = fixture()
    const h = mount({ ...current, error: 'Inspection failed', graph: { ...current.graph!, sessions: [],
      nodes: [{ ...current.graph!.nodes[0]!, preview: '' }] } })
    expect(screen.getByRole('alert').textContent).toContain('Inspection failed')
    expect(await screen.findByText('Branch Session · depth 0')).toBeTruthy()
    const input = screen.getByRole('textbox', { name: 'Search Context Map' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.change(input, { target: { value: 'nothing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next search result' }))
    expect(screen.getByText('0 / 0')).toBeTruthy()
    act(() => { h.publishSnapshot({ ...current, graph: { ...current.graph!,
      sessions: current.graph!.sessions.map(value => ({ ...value, depth: 1 })),
      nodes: current.graph!.nodes.map(value => ({ ...value, preview: '' })) } }) })
    expect(screen.getAllByText(/Branch root-ses|Branch child-se/).length).toBeGreaterThan(0)
  })

  it.each([new Error('review unavailable'), 'review unavailable'])('reports a recommendation action failure through the panel (%#)', async (cause) => {
    const current = fixture()
    const proposal = { mode: 'local' as const, base: { planRevision: 3, graphRevision: 'family-20', activeSessionId: child },
      currentNodeIds: ['root:1', 'root:2', 'child:8'], proposedNodeIds: ['root:2', 'child:8'],
      addedNodeIds: [], removedNodeIds: ['root:1'], selection: [{ nodeId: 'root:1', action: 'exclude' as const, reason: 'Old', confidence: 'high' as const }], archive: [] }
    mount({ ...current, recommendation: { phase: 'ready', proposal } }, {
      applyRecommendations: vi.fn(async () => { throw cause }),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply proposed context' }))
    expect((await screen.findByRole('alert')).textContent).toContain('review unavailable')
  })

  it('preserves read-only imported worker cards even if the canvas sends a delayed activation', async () => {
    const current = fixture()
    const worker = { ...node('worker:1', 1, 'assistant', 'Worker report', sid('worker')), sourceKind: 'worker' as const,
      sessionIds: [root], activeEventSeq: null }
    const h = mount({ ...current, graph: { ...current.graph!, nodes: [...current.graph!.nodes, worker] } })
    await screen.findByLabelText('Worker message: Worker report')
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    const target = flowHarness.nodes.find(value => value.id === worker.id)
    if (target === undefined) throw new Error('Expected imported public canvas card')
    const data = target.data as import('../src/client/ContextMapNode.tsx').ContextMapNodeData
    act(() => { data.onActivate(worker); data.onIncludedChange(worker, true); data.onContextMenu(worker, { x: 0, y: 0 }) })
    expect(h.store.getSnapshot().selectedNodeIds).toEqual([])
    expect(h.mapActions.setNodeMode).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
    act(() => { h.publishSnapshot({ ...current, pending: true }) })
    const busyTarget = flowHarness.nodes.find(value => value.id === 'child:8')
    if (busyTarget === undefined) throw new Error('Expected active public canvas card')
    const busyData = busyTarget.data as import('../src/client/ContextMapNode.tsx').ContextMapNodeData
    act(() => { busyData.onIncludedChange(busyData.record, false) })
    expect(h.mapActions.setNodeMode).not.toHaveBeenCalled()
  })

  it('shows bounded Fast progress and acknowledges a direct Local request failure only through controller state', async () => {
    const current = fixture()
    const h = mount(current, { recommend: vi.fn(async () => { throw new Error('remote rejected') }) })
    fireEvent.click(screen.getByRole('button', { name: 'Recommend' }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { h.publishSnapshot({ ...current, recommendation: { phase: 'running', mode: 'fast' } }) })
    expect(screen.getByRole('button', { name: 'Reviewing…' })).toHaveProperty('disabled', true)
  })

  it('clears a searched destination on explicit focus, then allows the focus to be cleared', async () => {
    const current = fixture()
    const h = mount(current)
    const input = screen.getByRole('textbox', { name: 'Search Context Map' })
    fireEvent.change(input, { target: { value: 'root' } })
    fireEvent.click(screen.getByRole('button', { name: 'Previous search result' }))
    expect(screen.getByText('1 / 1')).toBeTruthy()
    act(() => { h.publishSnapshot({ ...current, focusedNodeId: 'child:8', focusRevision: 1 }) })
    expect(input).toHaveProperty('value', '')
    act(() => { h.publishSnapshot({ ...current, focusRevision: 2 }) })
    expect(input).toHaveProperty('value', '')
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
    expect(screen.getByRole('button', { name: 'Selection mode' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('ignores a menu callback from a canvas that has already unmounted', async () => {
    const h = mount()
    await screen.findByLabelText('User message: branch follow-up')
    const target = flowHarness.nodes.find(value => value.id === 'child:8')
    if (target === undefined) throw new Error('Expected rendered canvas node')
    const data = target.data as import('../src/client/ContextMapNode.tsx').ContextMapNodeData
    h.view.unmount()
    expect(() => { data.onContextMenu(data.record, { x: 10, y: 10 }) }).not.toThrow()
    expect(h.mapActions.setNodeMode).not.toHaveBeenCalled()
  })

})

it('echoes the displayed policy key from the actual panel only for complete Context approval', async () => {
  for (const carry of [false, true]) {
    const current = fixture(), sibling = sid('sibling-writing')
    const graph = { ...current.graph!, sessions: [...current.graph!.sessions,
      { id: sibling, parentSessionId: root, seedLength: 5, depth: 1, tipNodeId: 'sibling:12' }],
    nodes: [...current.graph!.nodes, node('sibling:12', 12, 'user', 'Separate writing task', sibling)] }
    const base = { planRevision: 3, graphRevision: 'family-20', activeSessionId: child }
    const route = { action: 'navigate' as const, base, objective: 'Resume separate writing',
      targetSessionId: sibling, contextNodeIds: ['sibling:12'], reason: 'Resume that writing task' }
    const scopePolicy = { reviewId: 'fixture-panel-publication', key: 'e'.repeat(64), mode: 'task-owned' as const,
      assignment: 'existing' as const, sessionId: sibling, sourceCount: 1 }
    const proposal = { mode: 'fast' as const, base, currentNodeIds: ['root:1', 'root:2', 'child:8'],
      proposedNodeIds: ['sibling:12'], addedNodeIds: ['sibling:12'], removedNodeIds: ['root:1', 'root:2', 'child:8'],
      selection: [{ nodeId: 'sibling:12', action: 'include' as const, reason: 'Selected task', confidence: 'high' as const },
        ...['root:1', 'root:2', 'child:8'].map(nodeId => ({ nodeId, action: 'exclude' as const,
          reason: 'Different task', confidence: 'high' as const }))], archive: [], scopePolicy, route }
    const h = mount({ ...current, graph, recommendation: { phase: 'ready', proposal } })
    try {
      expect(screen.getByText('Only this task')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: carry ? 'Move draft with proposed Context' : 'Apply proposed context' }))
      await waitFor(() => {
        if (carry) expect(h.mapActions.acceptRoute).toHaveBeenCalledWith(route, true, scopePolicy.key)
        else expect(h.mapActions.applyRecommendations).toHaveBeenCalledWith([], scopePolicy.key)
      })
    } finally { h.view.unmount() }
  }
})

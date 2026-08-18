// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import {
  ContextMapPanel, type ContextMapActions,
} from '../src/client/ContextMapPanel.tsx'
import {
  ContextifyController, type ContextifyControllerSnapshot, type ContextifyTransport,
} from '../src/client/controller.ts'
import { createContextMapStore } from '../src/client/store.ts'
import { ContextMessageAction } from '../src/client/ContextMessageAction.tsx'
import {
  effectiveContextIncluded, intersects, modeForEffectiveContext, reducePositionChanges,
} from '../src/client/canvas-interactions.ts'

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
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
    view: {
      plan: {
        kind: 'contextify/plan', version: 2, revision: 3, stateRevision: 3,
        history: { past: [2], future: [] },
        excluded: [], included: [],
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
  }
}

function mount(
  snapshot = fixture(),
  overrides: Partial<ContextMapActions> = {},
  archivedSessionIds: readonly SessionId[] = [],
) {
  const source = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const workspaceSource = {
    getSnapshot: (): WorkspaceListState => ({
      items: [], archivedSessionIds, state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
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
    branch: vi.fn(async () => {}),
    locate: vi.fn(),
    close: vi.fn(),
    ...overrides,
  }
  const view = render(
    <div style={{ width: 720, height: 680 }}>
      <ContextMapPanel
        useContextify={bindSnapshotSelector(source)}
        useWorkspaces={bindSnapshotSelector(workspaceSource)}
        useStore={bindSnapshotSelector(store)}
        actions={store.actions}
        mapActions={mapActions}
      />
    </div>,
  )
  return { view, store, mapActions, snapshot }
}

describe('ContextMapPanel', () => {
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
    expect(modeForEffectiveContext(true, true)).toBe('natural')
    expect(modeForEffectiveContext(true, false)).toBe('exclude')
    expect(modeForEffectiveContext(false, false)).toBe('natural')
    expect(modeForEffectiveContext(false, true)).toBe('include')
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
  it('waits for an in-flight refresh before choosing the mutation revision', async () => {
    let resolveView!: (value: ContextifyControllerSnapshot['view']) => void
    const viewPromise = new Promise<ContextifyControllerSnapshot['view']>((resolve) => { resolveView = resolve })
    const setNodeMode = vi.fn(async (_ref, _node, _mode) => fixture().view!)
    const transport: ContextifyTransport = {
      get: async () => (await viewPromise)!,
      familyPage: async () => ({
        asOfSeq: 20,
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

  it('can clear a transient graph focus target', () => {
    const transport = {} as ContextifyTransport
    const controller = new ContextifyController(transport)
    controller.focus('root:1')
    expect(controller.getSnapshot().focusedNodeId).toBe('root:1')
    controller.focus(undefined)
    expect(controller.getSnapshot().focusedNodeId).toBeUndefined()
  })
})

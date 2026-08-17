// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import {
  ContextMapPanel, type ContextMapActions,
} from '../src/client/ContextMapPanel.tsx'
import {
  ContextifyController, type ContextifyControllerSnapshot, type ContextifyTransport,
} from '../src/client/controller.ts'
import { createContextMapStore } from '../src/client/store.ts'
import { ContextMessageAction } from '../src/client/ContextMessageAction.tsx'

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
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

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

function mount(snapshot = fixture()) {
  const source = { getSnapshot: () => snapshot, subscribe: () => () => {} }
  const store = createContextMapStore().create()
  const mapActions: ContextMapActions = {
    setNodeMode: vi.fn(async () => {}),
    setNodeModes: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    undo: vi.fn(async () => {}),
    redo: vi.fn(async () => {}),
    branch: vi.fn(async () => {}),
    navigate: vi.fn(),
    locate: vi.fn(),
    close: vi.fn(),
  }
  const view = render(
    <div style={{ width: 720, height: 680 }}>
      <ContextMapPanel
        useContextify={bindSnapshotSelector(source)}
        useStore={bindSnapshotSelector(store)}
        actions={store.actions}
        mapActions={mapActions}
      />
    </div>,
  )
  return { view, store, mapActions, snapshot }
}

describe('ContextMapPanel', () => {
  it('renders the message graph and controls modes, branch, navigation, locate, and layouts', async () => {
    const h = mount()
    expect(await screen.findByText('root requirement')).toBeTruthy()
    expect(screen.getByText('branch follow-up')).toBeTruthy()
    expect(screen.getByText('2 / 3 selected')).toBeTruthy()
    expect(h.view.container.querySelectorAll('.react-flow__node')).toHaveLength(3)
    expect(h.view.container.querySelector('.react-flow__edges')).toBeTruthy()

    const rootCard = screen.getByText('root requirement').closest('article')!
    fireEvent.click(rootCard.querySelector('button[aria-label="Exclude root requirement"]')!)
    expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 1 }, 'exclude')
    fireEvent.click(rootCard.querySelector('button[aria-label="Branch from root requirement"]')!)
    expect(h.mapActions.branch).toHaveBeenCalledWith(h.snapshot.graph!.nodes[0])
    fireEvent.click(within(rootCard).getByText('Open'))
    expect(h.mapActions.navigate).toHaveBeenCalledWith(h.snapshot.graph!.nodes[0])
    fireEvent.click(within(rootCard).getByText('Locate'))
    expect(h.mapActions.locate).toHaveBeenCalledWith('root:1')

    fireEvent.click(screen.getByRole('button', { name: 'mindmap layout' }))
    expect(h.store.getSnapshot().layout).toBe('mindmap')
    fireEvent.click(screen.getByRole('button', { name: 'timeline layout' }))
    expect(h.store.getSnapshot().layout).toBe('timeline')
    fireEvent.click(screen.getByRole('button', { name: 'tree layout' }))
    expect(h.store.getSnapshot().layout).toBe('tree')
  })

  it('searches cyclically and applies one batch selection mutation', async () => {
    const h = mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Context Map' }), { target: { value: 'r' } })
    expect(await screen.findByText('1 / 3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next search result' }))
    expect(screen.getByText('2 / 3')).toBeTruthy()

    h.store.actions.setNodeSelected('root:1', true)
    h.store.actions.setNodeSelected('child:8', true)
    await waitFor(() => { expect(screen.getByText('2 selected')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected' }))
    expect(h.mapActions.setNodeModes).toHaveBeenCalledWith([
      { node: { sessionId: root, seq: 1 }, mode: 'exclude' },
      { node: { sessionId: child, seq: 8 }, mode: 'exclude' },
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(h.mapActions.undo).toHaveBeenCalledOnce()
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

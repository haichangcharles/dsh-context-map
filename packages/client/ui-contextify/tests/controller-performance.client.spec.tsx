// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph, ContextifyView } from '@deepseek-ai/dsh-contextify/types'
import { bindSnapshotSelector } from '../../ui-renderer/src/client/bind.ts'
import { ContextifyController, type ContextifyTransport, type ContextifyControllerSnapshot } from '../src/client/controller.ts'
import { ContextMessageAction } from '../src/client/ContextMessageAction.tsx'
import { stewardTestTranslator } from './test-locale.client.ts'

afterEach(cleanup)
const session = 'performance-session' as SessionId
function fixture() {
  const graph: ContextFamilyGraph = {
    rootSessionId: session, activeSessionId: session,
    sessions: [{ id: session, seedLength: 0, depth: 0, tipNodeId: 'second' }], edges: [],
    nodes: [1, 2].map(seq => ({ id: seq === 1 ? 'first' : 'second', owner: { sessionId: session, seq },
      role: 'user', preview: `message ${seq}`, time: seq, branchAtSeq: seq + 2,
      sessionIds: [session], activeEventSeq: seq })),
  }
  const view: ContextifyView = { plan: { kind: 'contextify/plan', version: 3, revision: 1, stateRevision: 1,
    history: { past: [], future: [] }, included: [], excluded: [], replacements: [] },
  graphAsOfSeq: 3, selectedCount: 2, totalNodeCount: 2, canUndo: false, canRedo: false }
  return { graph, view }
}
function harness() {
  const current = { ...fixture(), revision: 'same-revision' }
  // This read-only polling fixture must fail loudly if a test reaches a mutation/provider seam.
  const unsupported = async (): Promise<never> => { throw new Error('Read-only polling fixture does not support mutations') }
  const transport: ContextifyTransport = {
    get: async () => structuredClone(current.view),
    familyPage: async () => ({ ...structuredClone(current.graph), records: structuredClone(current.graph.nodes),
      revision: current.revision, asOfSeq: current.view.graphAsOfSeq, totalNodeCount: current.graph.nodes.length }),
    setNodeMode: unsupported,
    setNodeModes: unsupported,
    reset: unsupported,
    undo: unsupported,
    redo: unsupported,
    recommend: unsupported,
    cancelRecommendation: unsupported,
    presentRecommendation: unsupported,
    dismissRecommendation: unsupported,
    archiveNode: unsupported,
    getNodeText: unsupported,
    focusNodeExcerpt: unsupported,
    restoreNode: unsupported,
    prepareBranchSuggestion: unsupported,
    keepBranchSuggestion: unsupported,
    forkNativeBranch: unsupported,
    acceptBranchSuggestion: unsupported,
  }
  const controller = new ContextifyController(transport)
  return { current, controller }
}

describe('Contextify polling identity', () => {
  it('retains graph, plan and publication identity for equivalent detached refreshes', async () => {
    const { controller } = harness()
    await controller.refresh()
    const first = controller.getSnapshot()
    const changed = vi.fn()
    const unsubscribe = controller.subscribe(changed)
    await controller.refresh()
    unsubscribe()
    expect(controller.getSnapshot().graph).toBe(first.graph)
    expect(controller.getSnapshot().view?.plan).toBe(first.view?.plan)
    expect(controller.getSnapshot()).toBe(first)
    expect(changed).not.toHaveBeenCalled()
  })

  it('publishes edited content and lifecycle despite unchanged graph revision', async () => {
    const { current, controller } = harness()
    await controller.refresh()
    const initial = controller.getSnapshot().graph
    current.graph = { ...current.graph, nodes: current.graph.nodes.map(node => node.id === 'second'
      ? { ...node, preview: 'corrected source' } : node) }
    await controller.refresh()
    expect(controller.getSnapshot().graph).not.toBe(initial)
    expect(controller.getSnapshot().graph?.nodes[1]?.preview).toBe('corrected source')
    const edited = controller.getSnapshot().graph
    current.graph = { ...current.graph, sessions: current.graph.sessions.map(item => ({ ...item, workState: 'completed' as const })) }
    await controller.refresh()
    expect(controller.getSnapshot().graph).not.toBe(edited)
    expect(controller.getSnapshot().graph?.sessions[0]?.workState).toBe('completed')
  })

  it('retains plan identity without suppressing changed view facts or graph revision', async () => {
    const { current, controller } = harness()
    await controller.refresh()
    const initial = controller.getSnapshot()
    current.view = { ...current.view, selectedCount: 1, graphAsOfSeq: 7 }
    await controller.refresh()
    expect(controller.getSnapshot().view?.plan).toBe(initial.view?.plan)
    expect(controller.getSnapshot().view?.selectedCount).toBe(1)
    expect(controller.getSnapshot().view?.graphAsOfSeq).toBe(7)
    current.revision = 'new-revision'
    await controller.refresh()
    expect(controller.getSnapshot().graphRevision).toBe('new-revision')
    current.view = { ...current.view, plan: { ...current.view.plan, revision: 2,
      excluded: [{ nodeId: 'first', eventSeq: 1 }] } }
    await controller.refresh()
    expect(controller.getSnapshot().view?.plan).not.toBe(initial.view?.plan)
    expect(controller.getSnapshot().view?.plan.excluded[0]?.nodeId).toBe('first')
  })
})

describe('message-specific selector invalidation', () => {
  it('keeps unrelated updates out of a message commit while updating its own controls', () => {
    const { graph, view } = fixture()
    let snapshot: ContextifyControllerSnapshot = { graph, view, phase: 'ready', pending: false,
      graphRevision: 'same-revision', recommendation: { phase: 'idle' } }
    const listeners = new Set<() => void>()
    const useContextify = bindSnapshotSelector({ getSnapshot: () => snapshot, subscribe: (listener) => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    } })
    const commit = vi.fn()
    const locate = vi.fn()
    render(<Profiler id="first-message" onRender={commit}><ContextMessageAction seq={1}
      useContextify={useContextify} t={stewardTestTranslator()} locate={locate} setNodeMode={async () => {}} /></Profiler>)
    const publish = (next: ContextifyControllerSnapshot): void => {
      act(() => {
        snapshot = next
        for (const listener of listeners) listener()
      })
    }
    const initialCommits = commit.mock.calls.length
    publish({ ...snapshot, graph: { ...graph, nodes: graph.nodes.map(node => node.id === 'second'
      ? { ...node, preview: 'unrelated correction' } : { ...node, owner: { ...node.owner } }) } })
    expect(commit.mock.calls.length).toBe(initialCommits)
    expect(screen.getByRole('button', { name: 'exclude context for message 1' }).hasAttribute('disabled')).toBe(false)
    publish({ ...snapshot, pending: true })
    expect(screen.getByRole('button', { name: 'exclude context for message 1' }).hasAttribute('disabled')).toBe(true)
    publish({ ...snapshot, pending: false, view: { ...view, plan: { ...view.plan,
      excluded: [{ nodeId: 'first', eventSeq: 1 }] } } })
    expect(screen.getByRole('button', { name: 'exclude context for message 1' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Locate message 1 in Context Map' }))
    expect(locate).toHaveBeenCalledWith('first')
    publish({ ...snapshot, graph: { ...graph, nodes: graph.nodes.map(node => node.id === 'first'
      ? { ...node, preview: 'corrected local source' } : node) } })
    expect(screen.getByRole('button', { name: 'Locate corrected local source in Context Map' })).toBeDefined()
  })
})

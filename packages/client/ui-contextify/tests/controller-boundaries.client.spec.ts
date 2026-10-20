/** Public transport races, review ownership and atomic Client mutations. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph, ContextifyView, ContextRecommendationProposal } from '@deepseek-ai/dsh-contextify/types'
import { ContextifyController, type ContextifyTransport } from '../src/client/controller.ts'

const source = 'controller-source' as SessionId
const other = 'controller-other' as SessionId
const node = (id: string, active: boolean, seq: number) => ({ id, owner: { sessionId: active ? source : other, seq },
  role: 'user' as const, preview: id, time: seq, branchAtSeq: seq + 1,
  sessionIds: [active ? source : other], activeEventSeq: active ? seq : null })

function bench() {
  const state: { view: ContextifyView; graph: ContextFamilyGraph; revision: string; proposal: ContextRecommendationProposal } = {
    view: { plan: { kind: 'contextify/plan', version: 3, revision: 1, stateRevision: 1,
      included: [], excluded: [], replacements: [], history: { past: [], future: [] } },
    graphAsOfSeq: 8, selectedCount: 2, totalNodeCount: 4, canUndo: false, canRedo: false },
    graph: { rootSessionId: source, activeSessionId: source, sessions: [
      { id: source, depth: 0, seedLength: 0, tipNodeId: 'active-exclude' },
      { id: other, depth: 1, seedLength: 0, tipNodeId: 'borrow' }], edges: [],
    nodes: [node('active-exclude', true, 1), node('active-include', true, 2), node('borrow', false, 3), node('release', false, 4)] },
    revision: 'graph-1',
    proposal: { mode: 'local', base: { activeSessionId: source, planRevision: 1, graphRevision: 'graph-1' },
      currentNodeIds: [], proposedNodeIds: [], addedNodeIds: [], removedNodeIds: [], selection: [], archive: [] },
  }
  const view = vi.fn(async () => state.view)
  const transport = {
    get: vi.fn<ContextifyTransport['get']>(async () => state.view),
    familyPage: vi.fn<ContextifyTransport['familyPage']>(async () => ({ ...state.graph, records: state.graph.nodes, revision: state.revision,
      asOfSeq: 8, totalNodeCount: state.graph.nodes.length })),
    setNodeMode: vi.fn<ContextifyTransport['setNodeMode']>(view), setNodeModes: vi.fn<ContextifyTransport['setNodeModes']>(view), reset: vi.fn<ContextifyTransport['reset']>(view), undo: vi.fn<ContextifyTransport['undo']>(view), redo: vi.fn<ContextifyTransport['redo']>(view),
    recommend: vi.fn<ContextifyTransport['recommend']>(async () => state.proposal), cancelRecommendation: vi.fn<ContextifyTransport['cancelRecommendation']>(async () => {}),
    presentRecommendation: vi.fn<ContextifyTransport['presentRecommendation']>(async () => {}), dismissRecommendation: vi.fn<ContextifyTransport['dismissRecommendation']>(async () => {}),
    archiveNode: vi.fn<ContextifyTransport['archiveNode']>(view), getNodeText: vi.fn<ContextifyTransport['getNodeText']>(async () => 'Exact source text'),
    focusNodeExcerpt: vi.fn<ContextifyTransport['focusNodeExcerpt']>(view), restoreNode: vi.fn<ContextifyTransport['restoreNode']>(view),
    prepareBranchSuggestion: vi.fn<ContextifyTransport['prepareBranchSuggestion']>(async () => ({ sourceSessionId: source, beforeSeq: 3 })),
    keepBranchSuggestion: vi.fn<ContextifyTransport['keepBranchSuggestion']>(async () => {}), forkNativeBranch: vi.fn<ContextifyTransport['forkNativeBranch']>(async () => other),
    acceptBranchSuggestion: vi.fn<ContextifyTransport['acceptBranchSuggestion']>(async () => ({ childSessionId: other })),
  } satisfies ContextifyTransport
  const controller = new ContextifyController(transport)
  return { state, transport, controller }
}

afterEach(() => { vi.useRealTimers() })

describe('Contextify Client transport state', () => {
  it('polls only while subscribed, deduplicates in-flight reads and preserves focus requests', async () => {
    vi.useFakeTimers()
    const b = bench()
    const gate = Promise.withResolvers<ContextifyView>()
    b.transport.get.mockImplementationOnce(() => gate.promise)
    const listener = vi.fn()
    const first = b.controller.subscribe(listener)
    const second = b.controller.subscribe(vi.fn())
    const one = b.controller.refresh()
    expect(b.controller.refresh()).toBe(one)
    gate.resolve(b.state.view)
    await one
    b.controller.focus('borrow')
    await b.controller.refresh()
    expect(b.controller.getSnapshot()).toMatchObject({ focusedNodeId: 'borrow', focusRevision: 1 })
    b.controller.focus(undefined)
    expect(b.controller.getSnapshot().focusedNodeId).toBeUndefined()
    first()
    await vi.advanceTimersByTimeAsync(1500)
    expect(b.transport.get.mock.calls.length).toBeGreaterThan(2)
    second()
    const calls = b.transport.get.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(b.transport.get).toHaveBeenCalledTimes(calls)
  })

  it('rejects mixed page revisions instead of publishing partial context', async () => {
    const b = bench()
    b.transport.familyPage.mockResolvedValueOnce({ ...b.state.graph, records: [b.state.graph.nodes[0]!],
      nextAfter: 1, revision: 'graph-1', asOfSeq: 8, totalNodeCount: 4 })
      .mockResolvedValueOnce({ ...b.state.graph, records: b.state.graph.nodes.slice(1),
        revision: 'graph-1', asOfSeq: 8, totalNodeCount: 4 })
    await b.controller.refresh()
    expect(b.transport.familyPage).toHaveBeenLastCalledWith(1, 500)
    expect(b.controller.getSnapshot().graph?.nodes).toHaveLength(4)
    b.transport.familyPage.mockResolvedValueOnce({ ...b.state.graph, records: [], nextAfter: 1,
      revision: 'old', asOfSeq: 8, totalNodeCount: 4 })
    await b.controller.refresh()
    expect(b.controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'Context Map changed while pages were loading' })
    expect(b.controller.getSnapshot().graph?.nodes).toHaveLength(4)
  })

  it.each([new Error('offline'), 'remote disconnected'])('fails review and mutation closed before a readable view: %s', async (failure) => {
    const b = bench()
    b.transport.get.mockRejectedValue(failure)
    await expect(b.controller.recommend()).rejects.toThrow(failure instanceof Error ? failure.message : failure)
    await expect(b.controller.reset()).rejects.toThrow(failure instanceof Error ? failure.message : failure)
    expect(b.transport.recommend).not.toHaveBeenCalled()
    expect(b.transport.reset).not.toHaveBeenCalled()
  })

  it('waits for a current refresh before starting a mutation and blocks overlapping writes', async () => {
    const b = bench()
    const read = Promise.withResolvers<ContextifyView>()
    b.transport.get.mockImplementationOnce(() => read.promise)
    const refresh = b.controller.refresh()
    const mutate = b.controller.setNodeMode({ sessionId: source, seq: 1 }, 'exclude')
    expect(b.transport.setNodeMode).not.toHaveBeenCalled()
    read.resolve(b.state.view)
    await refresh
    await mutate
    const write = Promise.withResolvers<ContextifyView>()
    b.transport.reset.mockImplementationOnce(() => write.promise)
    const pending = b.controller.reset()
    expect(b.controller.getSnapshot().pending).toBe(true)
    await b.controller.refresh()
    await expect(b.controller.undo()).rejects.toThrow('already pending')
    write.resolve(b.state.view)
    await pending
    expect(b.controller.getSnapshot().pending).toBe(false)
  })

  it.each([new Error('write denied'), 'write disappeared'])('retains a failed mutation and clears its error after recovery: %s', async (failure) => {
    const b = bench()
    b.transport.setNodeModes.mockRejectedValueOnce(failure)
    await expect(b.controller.setNodeModes([])).rejects.toBe(failure)
    expect(b.controller.getSnapshot().pending).toBe(false)
    expect(b.controller.getSnapshot().error).toBe(failure instanceof Error ? failure.message : failure)
    await b.controller.redo()
    expect(b.controller.getSnapshot().error).toBeUndefined()
    await b.controller.undo()
    await b.controller.archiveNode({ sessionId: source, seq: 1 })
    expect(b.transport.archiveNode).toHaveBeenCalledWith({ revision: 1 }, { sessionId: source, seq: 1 }, 'Archived by user', 'graph-1')
    expect(await b.controller.getNodeText({ sessionId: source, seq: 1 })).toBe('Exact source text')
    await b.controller.focusNodeExcerpt({ sessionId: source, seq: 1 }, 0, 5)
    expect(b.transport.focusNodeExcerpt).toHaveBeenCalledWith({ revision: 1 }, { sessionId: source, seq: 1 }, 0, 5, 'Focused by user')
    await b.controller.restoreNode({ sessionId: source, seq: 1 })
    await b.controller.keepBranchSuggestion('keep')
    expect(await b.controller.acceptBranchSuggestion('move')).toEqual({ childSessionId: other })
    expect(b.transport.forkNativeBranch).toHaveBeenCalledWith({ sourceSessionId: source, beforeSeq: 3 })
  })
})

describe('review ownership and bounded confirmation', () => {
  it('keeps an already-stale remote proposal out of the ready review state', async () => {
    const b = bench()
    b.state.proposal = { ...b.state.proposal, base: { ...b.state.proposal.base, planRevision: 0 } }
    await b.controller.recommend()
    expect(b.controller.getSnapshot().recommendation.phase).toBe('stale')
    await expect(b.controller.applyRecommendations()).rejects.toThrow('stale')
    expect(b.transport.setNodeModes).not.toHaveBeenCalled()
  })
  it('refreshes an already-loaded graph and Plan before sending one review', async () => {
    const b = bench()
    await b.controller.refresh()
    b.state.revision = 'graph-2'
    b.state.view = { ...b.state.view, plan: { ...b.state.view.plan, revision: 2 } }
    b.state.proposal = { ...b.state.proposal, base: { ...b.state.proposal.base, planRevision: 2, graphRevision: 'graph-2' } }
    await b.controller.recommend('fast', 'Review the archived family', true)
    expect(b.transport.recommend).toHaveBeenCalledExactlyOnceWith(
      b.state.proposal.base, 'Review the archived family', 'fast', true)
    expect(b.controller.getSnapshot().recommendation.phase).toBe('ready')
  })

  it('does not dispatch from a retained graph when the fresh read fails', async () => {
    const b = bench()
    await b.controller.refresh()
    b.transport.get.mockRejectedValueOnce(new Error('family unavailable'))
    await expect(b.controller.recommend()).rejects.toThrow('family unavailable')
    expect(b.controller.getSnapshot().graph).toBeDefined()
    expect(b.transport.recommend).not.toHaveBeenCalled()
  })

  it('does not resurrect a review cleared while its fresh read is pending', async () => {
    const b = bench()
    await b.controller.refresh()
    const read = Promise.withResolvers<ContextifyView>()
    b.transport.get.mockImplementationOnce(() => read.promise)
    const refresh = b.controller.refresh()
    const review = b.controller.recommend('fast', 'Obsolete draft', true)
    b.controller.clearRecommendation()
    read.resolve(b.state.view)
    await Promise.all([refresh, review])
    expect(b.transport.recommend).not.toHaveBeenCalled()
    expect(b.controller.getSnapshot().recommendation.phase).toBe('idle')
  })

  it('dispatches only the newest review waiting for the same fresh graph', async () => {
    const b = bench()
    await b.controller.refresh()
    const read = Promise.withResolvers<ContextifyView>()
    b.transport.get.mockImplementationOnce(() => read.promise)
    const refresh = b.controller.refresh()
    const earlier = b.controller.recommend('local', 'Earlier draft', true)
    const latest = b.controller.recommend('fast', 'Latest draft', true)
    read.resolve(b.state.view)
    await Promise.all([refresh, earlier, latest])
    expect(b.transport.recommend).toHaveBeenCalledExactlyOnceWith(
      b.state.proposal.base, 'Latest draft', 'fast', true)
  })

  it('refuses a review while a Plan mutation is pending', async () => {
    const b = bench()
    await b.controller.refresh()
    const write = Promise.withResolvers<ContextifyView>()
    b.transport.reset.mockImplementationOnce(() => write.promise)
    const mutation = b.controller.reset()
    const review = expect(b.controller.recommend()).rejects.toThrow('already pending')
    write.resolve(b.state.view)
    await Promise.all([review, mutation])
    expect(b.transport.recommend).not.toHaveBeenCalled()
  })

  it('refuses a review when a mutation takes ownership during the fresh read', async () => {
    const b = bench()
    await b.controller.refresh()
    const read = Promise.withResolvers<ContextifyView>()
    const write = Promise.withResolvers<ContextifyView>()
    b.transport.get.mockImplementationOnce(() => read.promise)
    b.transport.reset.mockImplementationOnce(() => write.promise)
    const refresh = b.controller.refresh()
    const mutation = b.controller.reset()
    const review = expect(b.controller.recommend()).rejects.toThrow('already pending')
    read.resolve(b.state.view)
    await refresh
    await review
    write.resolve(b.state.view)
    await mutation
    expect(b.transport.recommend).not.toHaveBeenCalled()
  })

  it('waits for the current load and forbids a second running recommendation', async () => {
    const b = bench()
    const read = Promise.withResolvers<ContextifyView>()
    b.transport.get.mockImplementationOnce(() => read.promise)
    const refresh = b.controller.refresh()
    const result = Promise.withResolvers<ContextRecommendationProposal>()
    b.transport.recommend.mockImplementationOnce(() => result.promise)
    const review = b.controller.recommend('fast', 'Use the source', true)
    read.resolve(b.state.view)
    await refresh
    await vi.waitFor(() => { expect(b.controller.getSnapshot().recommendation.phase).toBe('running') })
    await expect(b.controller.recommend()).rejects.toThrow('already running')
    result.resolve(b.state.proposal)
    await review
    expect(b.transport.recommend).toHaveBeenCalledWith({ activeSessionId: source, planRevision: 1, graphRevision: 'graph-1' }, 'Use the source', 'fast', true)
  })

  it.each([new Error('classifier failed'), 'invalid classifier'])('publishes classifier errors without changing the Plan: %s', async (failure) => {
    const b = bench()
    b.transport.recommend.mockRejectedValueOnce(failure)
    await expect(b.controller.recommend()).rejects.toBe(failure)
    expect(b.controller.getSnapshot().recommendation).toMatchObject({ phase: 'error', mode: 'local', error: failure instanceof Error ? failure.message : failure })
    expect(b.transport.setNodeModes).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('discards a cleared in-flight classifier that later %s', async (settlement) => {
    const b = bench()
    await b.controller.refresh()
    const result = Promise.withResolvers<ContextRecommendationProposal>()
    b.transport.recommend.mockImplementationOnce(() => result.promise)
    const review = b.controller.recommend()
    await vi.waitFor(() => { expect(b.transport.recommend).toHaveBeenCalledTimes(1) })
    b.controller.clearRecommendation()
    if (settlement === 'resolve') result.resolve(b.state.proposal)
    else result.reject(new Error('obsolete classifier'))
    await review
    expect(b.controller.getSnapshot().recommendation.phase).toBe('idle')
  })

  it.each(['plan', 'graph', 'session'] as const)('marks a review stale after its %s changes', async (changed) => {
    const b = bench()
    await b.controller.recommend()
    if (changed === 'plan') b.state.view = { ...b.state.view, plan: { ...b.state.view.plan, revision: 2 } }
    else if (changed === 'graph') b.state.revision = 'graph-2'
    else b.state.graph = { ...b.state.graph, activeSessionId: other }
    await b.controller.refresh()
    expect(b.controller.getSnapshot().recommendation.phase).toBe('stale')
    await expect(b.controller.applyRecommendations()).rejects.toThrow('stale')
    await expect(b.controller.confirmArchive({ nodeId: 'borrow', category: 'obsolete', reason: 'old', evidenceNodeIds: [] })).rejects.toThrow('stale')
    await b.controller.dismissRecommendation()
    expect(b.controller.getSnapshot().recommendation.phase).toBe('idle')
  })

  it('validates the exact open review before impression, dismissal, apply and archive', async () => {
    const b = bench()
    await b.controller.presentRecommendation(b.state.proposal)
    await expect(b.controller.dismissRecommendation()).rejects.toThrow('No Context')
    await expect(b.controller.applyRecommendations()).rejects.toThrow('No Context')
    await expect(b.controller.confirmArchive({ nodeId: 'absent', category: 'obsolete', reason: 'old', evidenceNodeIds: [] })).rejects.toThrow('unavailable')
    await b.controller.recommend()
    await b.controller.presentRecommendation({ ...b.state.proposal })
    expect(b.transport.presentRecommendation).not.toHaveBeenCalled()
    await b.controller.presentRecommendation(b.state.proposal)
    expect(b.transport.presentRecommendation).toHaveBeenCalledWith(b.state.proposal)
    await expect(b.controller.applyRecommendations(['absent'])).rejects.toThrow('Keep-current')
    await expect(b.controller.applyRecommendations(['absent', 'absent'])).rejects.toThrow('Keep-current')
  })

  it('maps approved changes to native modes while retaining explicit declines', async () => {
    const b = bench()
    b.state.proposal = { ...b.state.proposal, selection: ([
      ['active-exclude', 'exclude'], ['active-include', 'include'], ['borrow', 'include'], ['release', 'exclude'],
    ] as const).map(([nodeId, action]) => ({ nodeId, action, reason: 'reviewed', confidence: 'medium' })) }
    await b.controller.recommend()
    await b.controller.applyRecommendations(['active-include'])
    expect(b.transport.setNodeModes).toHaveBeenCalledWith({ revision: 1 }, [
      { node: { sessionId: source, seq: 1 }, mode: 'exclude' },
      { node: { sessionId: other, seq: 3 }, mode: 'include' },
      { node: { sessionId: other, seq: 4 }, mode: 'natural' },
    ], 'graph-1', ['active-include'])
    expect(b.controller.getSnapshot().recommendation.phase).toBe('idle')
    await b.controller.recommend()
    await b.controller.applyRecommendations()
    expect(b.transport.setNodeModes.mock.calls.at(-1)?.[1]).toContainEqual({ node: { sessionId: source, seq: 2 }, mode: 'natural' })
  })

  it('rejects unavailable sources and retains the review when a Host write fails', async () => {
    const b = bench()
    b.state.proposal = { ...b.state.proposal, selection: [{ nodeId: 'absent', action: 'include', reason: 'bad', confidence: 'medium' }] }
    await b.controller.recommend()
    await expect(b.controller.applyRecommendations()).rejects.toThrow('missing node')
    b.state.proposal = { ...b.state.proposal, selection: [{ nodeId: 'borrow', action: 'include', reason: 'use', confidence: 'medium' }] }
    await b.controller.recommend()
    b.transport.setNodeModes.mockRejectedValueOnce(new Error('revision rejected'))
    await expect(b.controller.applyRecommendations()).rejects.toThrow('revision rejected')
    expect(b.controller.getSnapshot().recommendation.phase).toBe('stale')
  })

  it('confirms only proposal-owned archives and preserves stale advice after rejection', async () => {
    const b = bench()
    const candidate = { nodeId: 'borrow', category: 'obsolete' as const, reason: 'obsolete facts', evidenceNodeIds: [] }
    b.state.proposal = { ...b.state.proposal, archive: [candidate] }
    await b.controller.recommend()
    b.transport.archiveNode.mockRejectedValueOnce('archive rejected')
    await expect(b.controller.confirmArchive(candidate)).rejects.toBe('archive rejected')
    expect(b.controller.getSnapshot().recommendation.phase).toBe('stale')
    b.controller.clearRecommendation()
    await b.controller.recommend()
    await b.controller.confirmArchive(candidate)
    expect(b.transport.archiveNode).toHaveBeenCalledWith({ revision: 1 }, { sessionId: other, seq: 3 }, candidate.reason, 'graph-1')
    b.state.proposal = { ...b.state.proposal, archive: [{ ...candidate, nodeId: 'missing' }] }
    await b.controller.recommend()
    await expect(b.controller.confirmArchive(b.state.proposal.archive[0]!)).rejects.toThrow('missing node')
  })

  it.each([false, true])('does not clear a newer review when an earlier dismissal settles (replace=%s)', async (replace) => {
    const b = bench()
    await b.controller.recommend()
    const gate = Promise.withResolvers<undefined>()
    b.transport.dismissRecommendation.mockImplementationOnce(() => gate.promise)
    const dismiss = b.controller.dismissRecommendation()
    if (replace) {
      b.controller.clearRecommendation()
      b.state.proposal = { ...b.state.proposal, mode: 'fast' }
      await b.controller.recommend('fast', 'A newly reviewed objective')
    }
    gate.resolve(undefined)
    await dismiss
    expect(b.controller.getSnapshot().recommendation.phase).toBe(replace ? 'ready' : 'idle')
    if (replace) expect(b.controller.getSnapshot().recommendation).toMatchObject({ proposal: b.state.proposal })
  })

  it('cancels Deep only and discards the old outcome', async () => {
    const b = bench()
    await expect(b.controller.cancelRecommendation()).rejects.toThrow('Only a running Deep')
    await b.controller.refresh()
    const result = Promise.withResolvers<ContextRecommendationProposal>()
    b.transport.recommend.mockImplementationOnce(() => result.promise)
    const review = b.controller.recommend('deep')
    await vi.waitFor(() => { expect(b.transport.recommend).toHaveBeenCalledTimes(1) })
    await b.controller.cancelRecommendation()
    result.resolve(b.state.proposal)
    await review
    expect(b.controller.getSnapshot().recommendation.phase).toBe('idle')
  })

  it.each([new Error('cancel failed'), 'cancel rejected'])('reports a failed Deep cancellation: %s', async (failure) => {
    const b = bench()
    await b.controller.refresh()
    const result = Promise.withResolvers<ContextRecommendationProposal>()
    b.transport.recommend.mockImplementationOnce(() => result.promise)
    const review = b.controller.recommend('deep')
    await vi.waitFor(() => { expect(b.transport.recommend).toHaveBeenCalledTimes(1) })
    b.transport.cancelRecommendation.mockRejectedValueOnce(failure)
    await expect(b.controller.cancelRecommendation()).rejects.toBe(failure)
    expect(b.controller.getSnapshot().recommendation).toMatchObject({ phase: 'error', mode: 'deep', error: failure instanceof Error ? failure.message : failure })
    result.resolve(b.state.proposal)
    await review
  })

  it.each(['resolve', 'reject'] as const)('keeps cleared state when an obsolete cancellation later %s', async (settlement) => {
    const b = bench()
    await b.controller.refresh()
    const result = Promise.withResolvers<ContextRecommendationProposal>()
    const cancelGate = Promise.withResolvers<undefined>()
    b.transport.recommend.mockImplementationOnce(() => result.promise)
    b.transport.cancelRecommendation.mockImplementationOnce(() => cancelGate.promise)
    const review = b.controller.recommend('deep')
    await vi.waitFor(() => { expect(b.transport.recommend).toHaveBeenCalledTimes(1) })
    const cancel = b.controller.cancelRecommendation()
    const observed = cancel.catch((error: unknown) => error)
    b.controller.clearRecommendation()
    if (settlement === 'resolve') cancelGate.resolve(undefined)
    else cancelGate.reject(new Error('old cancellation'))
    await observed
    expect(b.controller.getSnapshot().recommendation.phase).toBe('idle')
    result.resolve(b.state.proposal)
    await review
  })
})

it('forwards only an explicit complete-policy acknowledgement and preserves legacy transport arguments', async () => {
  const b = bench()
  b.state.proposal = { ...b.state.proposal, scopePolicy: { reviewId: 'fixture-publication', key: 'a'.repeat(64), mode: 'task-owned', assignment: 'existing', sessionId: source, sourceCount: 1 },
    selection: [{ nodeId: 'active-exclude', action: 'exclude', reason: 'reviewed', confidence: 'high' }] }
  await b.controller.recommend()
  await b.controller.applyRecommendations()
  expect(b.transport.setNodeModes.mock.calls.at(-1)).toHaveLength(4)
  await b.controller.recommend()
  await b.controller.applyRecommendations([], b.state.proposal.scopePolicy!.key)
  expect(b.transport.setNodeModes.mock.calls.at(-1)?.[4]).toBe(b.state.proposal.scopePolicy!.key)
})

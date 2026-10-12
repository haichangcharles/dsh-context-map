// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextMapPanelInjected } from '../src/client/ContextMapPanel.tsx'
import type { ContextMessageActionInjected } from '../src/client/ContextMessageAction.tsx'
import type { DraftContextReviewInjected } from '../src/client/DraftContextReview.tsx'
import type { BranchSuggestionTailInjected } from '../src/client/BranchSuggestionTail.tsx'
import { apply, inject } from '../src/client/index.ts'

const sid = (value: string): SessionId => value as SessionId
const source = sid('session-1')
const child = sid('session-child')

/** Mount the browser plugin over real Cordis slots and deterministic fake service faces. */
async function bench(withCleanup = false) {
  const ctx = new Context()
  const calls: Array<{ method: string; args: unknown[] }> = []
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const view = {
    plan: {
      kind: 'contextify/plan', version: 3, revision: 4, stateRevision: 4,
      history: { past: [3], future: [] }, excluded: [], included: [], replacements: [],
    },
    graphAsOfSeq: 7, selectedCount: 1, totalNodeCount: 1, canUndo: true, canRedo: false,
  }
  const record = {
    id: 'session-1:7', owner: { sessionId: source, seq: 7 }, role: 'user' as const,
    preview: 'hello', time: 7, branchAtSeq: 9, sessionIds: [source], activeEventSeq: 7,
  }
  const proposal = {
    mode: 'fast' as const,
    base: { planRevision: 4, graphRevision: 'family-7', activeSessionId: source },
    currentNodeIds: [record.id],
    proposedNodeIds: [],
    addedNodeIds: [],
    removedNodeIds: [record.id],
    selection: [{
      nodeId: record.id, action: 'exclude' as const, reason: 'No longer needed', confidence: 'high' as const,
    }],
    archive: withCleanup ? [{
      nodeId: record.id,
      category: 'obsolete' as const,
      reason: 'No longer meaningful',
      evidenceNodeIds: [],
    }] : [],
  }
  const answer = <T,>(method: string, value: T) => (...args: unknown[]) => {
    calls.push({ method, args })
    return Promise.resolve({ ok: true as const, value })
  }
  ctx.provide('remote.contextify', {
    get: answer('get', view),
    familyPage: answer('familyPage', {
      asOfSeq: 7,
      revision: 'family-7',
      rootSessionId: source,
      activeSessionId: source,
      sessions: [{ id: source, seedLength: 0, depth: 0, tipNodeId: record.id },
        { id: child, parentSessionId: source, seedLength: 0, depth: 1, tipNodeId: record.id }],
      edges: [],
      records: [record],
      totalNodeCount: 1,
    }),
    setNodeMode: answer('setNodeMode', view),
    setNodeModes: answer('setNodeModes', view),
    reset: answer('reset', view),
    undo: answer('undo', view),
    redo: answer('redo', view),
    recommend: answer('recommend', proposal),
    reviewRoute: answer('reviewRoute', undefined),
    recordManualBranch: answer('recordManualBranch', undefined),
    cancelRecommendation: answer('cancelRecommendation', undefined),
    presentRecommendation: answer('presentRecommendation', undefined),
    dismissRecommendation: answer('dismissRecommendation', undefined),
    archiveNode: answer('archiveNode', view),
    restoreNode: answer('restoreNode', view),
    prepareBranchSuggestion: answer('prepareBranchSuggestion', { sourceSessionId: source, beforeSeq: 4 }),
    keepBranchSuggestion: answer('keepBranchSuggestion', undefined),
    acceptBranchSuggestion: answer('acceptBranchSuggestion', { childSessionId: child }),
  })
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  ctx.provide('layout', {
    autoCollapseBreakpoint: () => 1024,
    openDetails,
    closeDetails,
    toggleSidebar: vi.fn(),
  })
  const fork = vi.fn(async () => child)
  const open = vi.fn()
  ctx.provide('sessions', { fork, open, scope: () => ctx })
  const registerTab = vi.fn(() => () => {})
  ctx.provide('sidebarRightTabs', { register: registerTab } as never)
  ctx.provide('sidebarRight', { openTab: openDetails, isExpanded: () => true, toggleExpanded: closeDetails } as never)
  const revealMessage = vi.fn()
  const openPinnedDetails = vi.fn()
  const draftState = { draft: '', draftRev: 0, phase: 'plain' as const, attachmentIds: [] }
  const moveDraft = vi.fn(() => true)
  ctx.provide('conversation', {
    revealMessage, openPinnedDetails, moveDraft,
    input: { for: () => ({ state: { getSnapshot: () => draftState } }) },
  } as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
      'conversation.chat.user-actions': { kind: 'list', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
      'conversation.chat.turnTail': { kind: 'chain', scope: 'session' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const pinned = ctx.slots.entries('sidebar.right.pane.tab')[0]
  const injectPanel = pinned?.inject as unknown as ((sessionId: SessionId) => ContextMapPanelInjected)
  const userAction = ctx.slots.entries('conversation.chat.user-actions')[0]
  const assistantAction = ctx.slots.entries('conversation.chat.assistant-actions')[0]
  const turnTail = ctx.slots.entries('conversation.chat.turnTail')[0]
  return {
    ctx, fiber, calls, closeDetails, openDetails, fork, open, moveDraft, draftState,
    revealMessage, openPinnedDetails, record,
    panel: injectPanel(source),
    pinned,
    userAction,
    assistantAction,
    turnTail,
    draftReview: ctx.slots.entries('conversation.input.dock')[0],
    opener: ctx.slots.entries('shell.overlay')[0],
  }
}

describe('ui-contextify browser plugin', () => {
  it('shares one native-family controller across the pinned map and both Chat action slots', async () => {
    const b = await bench()
    expect(b.pinned?.options).toMatchObject({ key: 'context-map' })
    expect(b.opener?.options).toMatchObject({ id: 'contextify-open-details' })
    expect(b.userAction?.options).toMatchObject({ id: 'contextify', order: 20 })
    expect(b.assistantAction?.options).toMatchObject({ id: 'contextify', order: 20 })
    expect(b.turnTail).toBeDefined()
    expect(b.turnTail?.select?.({ seq: 7 } as never)).toBe(7)

    const userInjected = (b.userAction?.inject as unknown as
      ((sessionId: SessionId) => ContextMessageActionInjected))(source)
    const assistantInjected = (b.assistantAction?.inject as unknown as
      ((sessionId: SessionId) => ContextMessageActionInjected))(source)
    expect(userInjected.hooks.contextify).toBe(b.panel.hooks.contextify)
    expect(assistantInjected.hooks.contextify).toBe(b.panel.hooks.contextify)
    userInjected.locate(b.record.id)

    const controller = b.panel.hooks.contextify
    await (controller as never as { refresh: () => Promise<void> }).refresh()
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      view: { plan: { revision: 4 } },
      graph: { nodes: [{ id: 'session-1:7', preview: 'hello' }] },
    })
    await b.panel.mapActions.setNodeMode(b.record.owner, 'exclude')
    await b.panel.mapActions.branch(b.record)
    b.panel.mapActions.locate(b.record)
    b.panel.mapActions.close()

    expect(b.calls.filter(call => call.method === 'setNodeMode')).toEqual([{
      method: 'setNodeMode', args: [source, { revision: 4 }, b.record.owner, 'exclude', 'contextify-client'],
    }])
    expect(b.fork).toHaveBeenCalledWith({ sessionId: source, atSeq: 9, increaseTitle: true })
    expect(b.moveDraft).toHaveBeenCalledWith(source, child, { draft: '', draftRev: 0 })
    expect(b.open).toHaveBeenNthCalledWith(1, child)
    expect(b.revealMessage).toHaveBeenCalledWith(source, b.record.owner.seq)
    expect(b.openDetails).toHaveBeenCalledOnce()
    expect(b.closeDetails).toHaveBeenCalledOnce()
  })

  it('removes all six slot contributions with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('sidebar.right.pane.tab')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.chat.user-actions')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.chat.turnTail')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.input.dock')).toHaveLength(0)
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })

  it('carries the reviewed draft into a new native branch before opening it', async () => {
    const b = await bench()
    b.draftState.draft = 'Use the previous Web evidence'
    b.draftState.draftRev = 7
    await b.panel.mapActions.branch(b.record)
    expect(b.moveDraft).toHaveBeenCalledWith(source, child, {
      draft: 'Use the previous Web evidence', draftRev: 7,
    })
    expect(b.moveDraft.mock.invocationCallOrder[0]).toBeLessThan(b.open.mock.invocationCallOrder[0]!)
    expect(b.calls.filter(call => call.method === 'recordManualBranch')).toMatchObject([{
      args: [source, child, 'contextify-client'],
    }])
  })

  it('keeps the current Session selected when the draft cannot be transferred', async () => {
    const b = await bench()
    b.moveDraft.mockReturnValueOnce(false)
    await expect(b.panel.mapActions.branch(b.record)).rejects.toThrow(/draft changed/)
    expect(b.open).not.toHaveBeenCalled()
  })

  it('accepts a reviewed draft route only at the same graph and editor revision', async () => {
    const b = await bench()
    b.draftState.draft = 'Continue the writing branch'
    b.draftState.draftRev = 5
    await b.panel.mapActions.acceptRoute({
      action: 'navigate', base: { planRevision: 4, graphRevision: 'family-7', activeSessionId: source },
      objective: 'Continue the writing branch', targetSessionId: child, reason: 'Use child',
    })
    expect(b.moveDraft).toHaveBeenCalledWith(source, child, {
      draft: 'Continue the writing branch', draftRev: 5,
    })
    expect(b.open).toHaveBeenCalledWith(child)
    expect(b.calls.filter(call => call.method === 'reviewRoute')).toMatchObject([{
      args: [source, expect.objectContaining({ action: 'navigate' }), 'accept', child, 'contextify-client'],
    }])
  })

  it('rejects stale draft route advice without switching Sessions', async () => {
    const b = await bench()
    b.draftState.draft = 'An edited draft'
    await expect(b.panel.mapActions.acceptRoute({
      action: 'navigate', base: { planRevision: 4, graphRevision: 'family-7', activeSessionId: source },
      objective: 'Original draft', targetSessionId: child, reason: 'Use child',
    })).rejects.toThrow(/draft changed/)
    expect(b.moveDraft).not.toHaveBeenCalled()
    expect(b.open).not.toHaveBeenCalled()
  })

  it('carries the next unsent draft after accepting an Agent branch relocation', async () => {
    const b = await bench()
    b.draftState.draft = 'Continue the new line of thought'
    b.draftState.draftRev = 11
    const actions = (b.turnTail?.inject as unknown as (id: SessionId) => BranchSuggestionTailInjected)(source)
    await actions.moveBranchSuggestion('suggestion-1')
    expect(b.calls.filter(call => call.method === 'acceptBranchSuggestion')).toHaveLength(1)
    expect(b.moveDraft).toHaveBeenCalledWith(source, child, {
      draft: 'Continue the new line of thought', draftRev: 11,
    })
    expect(b.moveDraft.mock.invocationCallOrder[0]).toBeLessThan(b.open.mock.invocationCallOrder[0]!)
    expect(b.open).toHaveBeenCalledWith(child)
  })

  it('leaves the current Session selected if the draft changes during Agent branch relocation', async () => {
    const b = await bench()
    b.moveDraft.mockReturnValueOnce(false)
    const actions = (b.turnTail?.inject as unknown as (id: SessionId) => BranchSuggestionTailInjected)(source)
    await expect(actions.moveBranchSuggestion('suggestion-1')).rejects.toThrow(/draft changed/)
    expect(b.open).not.toHaveBeenCalled()
  })

  it('reviews an unsent draft through the shared DSH Contextify Remote without mutation', async () => {
    const b = await bench()
    expect(b.draftReview?.options).toMatchObject({ id: 'contextify-draft-review' })
    const actions = (b.draftReview?.inject as unknown as (id: SessionId) => DraftContextReviewInjected)(source)
    await actions.review('Bring the prior Web evidence into this draft')
    expect(b.calls.filter(call => call.method === 'recommend')).toEqual([{
      method: 'recommend',
      args: [source, { planRevision: 4, graphRevision: 'family-7', activeSessionId: source },
        'Bring the prior Web evidence into this draft', 'fast', true],
    }])
    expect(b.calls.filter(call => call.method === 'setNodeModes')).toHaveLength(0)
    actions.openMap()
    expect(b.openDetails).toHaveBeenCalledOnce()
  })

  it('keeps recommendations review-only until accepted, then applies one atomic mutation', async () => {
    const b = await bench()
    const controller = b.panel.hooks.contextify as never as {
      refresh: () => Promise<void>
      getSnapshot: () => { recommendation: { phase: string } }
    }
    await controller.refresh()

    await b.panel.mapActions.recommend()
    expect(controller.getSnapshot().recommendation).toMatchObject({ phase: 'ready' })
    expect(b.calls.filter(call => call.method === 'setNodeModes')).toHaveLength(0)

    await b.panel.mapActions.applyRecommendations()
    expect(b.calls.filter(call => call.method === 'setNodeModes')).toEqual([{
      method: 'setNodeModes',
      args: [source, { revision: 4 }, [{ node: b.record.owner, mode: 'exclude' }], 'family-7',
        'contextify-client', []],
    }])
    expect(controller.getSnapshot().recommendation).toMatchObject({ phase: 'idle' })
  })

  it('confirms archive without forwarding Agent-authored placeholder content', async () => {
    const b = await bench(true)
    const controller = b.panel.hooks.contextify as never as { refresh: () => Promise<void> }
    await controller.refresh()
    await b.panel.mapActions.recommend()
    const candidate = {
      nodeId: b.record.id,
      category: 'obsolete' as const,
      reason: 'No longer meaningful',
      evidenceNodeIds: [],
    }

    await b.panel.mapActions.confirmArchive(candidate)

    expect(b.calls.filter(call => call.method === 'archiveNode')).toEqual([{
      method: 'archiveNode',
      args: [source, { revision: 4 }, b.record.owner, candidate.reason, 'family-7'],
    }])
  })
})

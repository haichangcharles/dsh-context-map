// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { ComponentType } from 'react'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import { stewardTestBaseLocale } from './test-locale.client.ts'
import { en } from '../src/client/locales.ts'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextMapPanelInjected } from '../src/client/ContextMapPanel.tsx'
import type { ContextMessageActionInjected } from '../src/client/ContextMessageAction.tsx'
import type { DraftContextReviewInjected } from '../src/client/DraftContextReview.tsx'
import type { BranchSuggestionTailInjected } from '../src/client/BranchSuggestionTail.tsx'
import { apply, inject, nativeBranchSource } from '../src/client/index.ts'
import type { ContextFamilyGraphPage, ContextifyView, ContextRecommendationProposal, ContextRouteAdvice } from '@deepseek-ai/dsh-contextify/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '../../ui-chat/src/client/contract/slots.ts'
import { ContextifyController } from '../src/client/controller.ts'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
const sid = (value: string): SessionId => value as SessionId
const source = sid('session-1')
const child = sid('session-child')

/** Mount the browser plugin over real Cordis slots and deterministic fake service faces. */
async function bench(withCleanup = false) {
  const ctx = new Context()
  ctx.provide('locale', stewardTestBaseLocale(ctx))
  const calls: Array<{ method: string; args: unknown[] }> = []
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const view: ContextifyView = {
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
  const proposal: ContextRecommendationProposal = {
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
  const answer = <T,>(method: string, value: T) => (...args: unknown[]): Promise<RemoteResult<T>> => {
    calls.push({ method, args })
    return Promise.resolve({ ok: true as const, value })
  }
  const page: Mutable<ContextFamilyGraphPage> = {
    asOfSeq: 7,
    revision: 'family-7',
    rootSessionId: source,
    activeSessionId: source,
    sessions: [{ id: source, seedLength: 0, depth: 0, tipNodeId: record.id },
      { id: child, parentSessionId: source, seedLength: 0, depth: 1, tipNodeId: record.id }],
    edges: [],
    records: [record],
    totalNodeCount: 1,
  }
  const remoteFace = {
    get: answer('get', view),
    familyPage: answer('familyPage', page),
    setNodeMode: answer('setNodeMode', view),
    setNodeModes: answer('setNodeModes', view),
    reset: answer('reset', view),
    undo: answer('undo', view),
    redo: answer('redo', view),
    recommend: answer('recommend', proposal),
    reviewRoute: answer('reviewRoute', undefined),
    recordManualBranch: answer('recordManualBranch', undefined),
    recordManualRoute: answer('recordManualRoute', undefined),
    policyEvidence: answer('policyEvidence', []),
    resetPolicy: answer('resetPolicy', undefined),
    reviewWorkState: answer('reviewWorkState', undefined),
    cancelRecommendation: answer('cancelRecommendation', undefined),
    presentRecommendation: answer('presentRecommendation', undefined),
    dismissRecommendation: answer('dismissRecommendation', undefined),
    archiveNode: answer('archiveNode', view),
    restoreNode: answer('restoreNode', view),
    getNodeText: answer('getNodeText', 'Exact source'),
    focusNodeExcerpt: answer('focusNodeExcerpt', view),
    setWorkState: answer('setWorkState', undefined),
    stewardProfile: answer('stewardProfile', { evidence: { support: 0, acceptRate: 0.5 }, destination: { support: 0, acceptRate: 0.5 }, branch: { support: 0, acceptRate: 0.5 }, return: { support: 0, acceptRate: 0.5 }, release: { support: 0, acceptRate: 0.5 }, thresholds: { evidence: 0.7, destination: 0.7 }, rules: [] }),
    prepareBranchSuggestion: answer('prepareBranchSuggestion', { sourceSessionId: source, beforeSeq: 4 }),
    keepBranchSuggestion: answer('keepBranchSuggestion', undefined),
    acceptBranchSuggestion: answer('acceptBranchSuggestion', { childSessionId: child }),
  }
  ctx.provide('remote.contextify', remoteFace)
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
  const sessionScope = vi.fn<() => Context | undefined>(() => ctx)
  ctx.provide('sessions', { fork, open, scope: sessionScope })
  const registerTab = vi.fn<(definition: SidebarRightTabDefinition) => () => void>(() => () => {})
  ctx.provide('sidebarRightTabs', { register: registerTab } as never)
  const expanded = vi.fn(() => true)
  ctx.provide('sidebarRight', { openTab: openDetails, isExpanded: expanded, toggleExpanded: closeDetails } as never)
  const revealMessage = vi.fn()
  const openPinnedDetails = vi.fn()
  const draftState: { draft: string; draftRev: number; phase: 'plain' | 'adjudicating'; attachmentIds: string[] } = { draft: '', draftRev: 0, phase: 'plain', attachmentIds: [] }
  const moveDraft = vi.fn(() => true)
  ctx.provide('conversation', {
    revealMessage, openPinnedDetails, moveDraft,
    input: { for: () => ({ state: { getSnapshot: () => draftState } }) },
  } as never)
  const promptScope = { marker: 'contextify-prompt-scope' }
  const bindSettings = vi.fn(() => promptScope)
  ctx.provide('settingsScope', { bind: bindSettings } as never)
  ctx.provide('connection', {} as never)
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
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const t = ctx.locale.bind('contextifySteward')
  for (const key of ['error.newBranchDraft', 'error.changedDraftReview', 'error.staleRoute'] as const) {
    expect(t(key)).toBe(en[key])
  }
  const pinned = ctx.slots.entries('sidebar.right.pane.tab')[0]
  const injectPanel = pinned?.inject as unknown as ((sessionId: SessionId) => ContextMapPanelInjected)
  const userAction = ctx.slots.entries('conversation.chat.user-actions')[0]
  const assistantAction = ctx.slots.entries('conversation.chat.assistant-actions')[0]
  const turnTail = ctx.slots.entries('conversation.chat.turnTail')[0]
  return {
    ctx, fiber, calls, remoteFace, page, view, proposal, sessionScope, expanded, bindSettings, promptScope,
    closeDetails, openDetails, fork, open, moveDraft, draftState, registerTab,
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
  it('registers the Profile settings scope and its current-language label', async () => {
    const b = await bench()
    try {
      expect(b.bindSettings).toHaveBeenCalledWith({ namespace: 'contextify' })
      const entry = b.ctx.slots.entries('settings.section')[0]
      expect(entry?.options).toMatchObject({ id: 'contextify-prompts', order: 25 })
      const label = entry?.options.label
      if (typeof label !== 'function') throw new Error('settings entry must retain its locale label callback')
      expect(label()).toBe('Context Map prompts')
      expect((entry?.inject as () => unknown)()).toEqual({ scope: b.promptScope })
    } finally { await b.fiber.dispose() }
  })

  it('keeps no-current and unknown Session overlays from opening the Map', async () => {
    const b = await bench()
    const state: SessionListState = { ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, current: undefined, currentAddress: undefined }
    const useSessions: SnapshotSelectorHook<SessionListState> = selector => selector(state)
    const Opener = b.opener?.component as ComponentType<{ open: () => void; useSessions: typeof useSessions }>
    const mounted = render(<Opener open={b.openDetails} useSessions={useSessions} />)
    try {
      expect(b.openDetails).not.toHaveBeenCalled()
      const opened = (b.opener?.inject as () => { open: () => void })()
      opened.open()
      expect(b.openDetails).toHaveBeenCalledWith('context-map')
    } finally { mounted.unmount(); await b.fiber.dispose() }
  })

  it('forwards every confirmed context and preference action to the owned Remote Session', async () => {
    const b = await bench(true)
    try {
      const actions = b.panel.mapActions
      await actions.reset()
      await actions.undo()
      await actions.redo()
      await actions.setNodeModes([{ node: b.record.owner, mode: 'natural' }])
      expect((await actions.inspectPolicy()).evidence.support).toBe(0)
      expect(await actions.policyEvidence()).toEqual([])
      await actions.reviewWorkState(b.proposal, child, 'reject')
      await actions.setWorkState(child, 'parked')
      expect(await actions.getNodeText(b.record.owner)).toBe('Exact source')
      await actions.focusNodeExcerpt(b.record.owner, 0, 5)
      await actions.restoreNode(b.record.owner)
      await actions.archiveNode(b.record.owner)
      await actions.recommend()
      await actions.presentRecommendation(b.proposal)
      await actions.dismissRecommendation([b.record.id])
      await expect(actions.cancelRecommendation()).rejects.toThrow('Only a running Deep')
      actions.clearRecommendation()
      const chat = (b.userAction?.inject as unknown as (id: SessionId) => ContextMessageActionInjected)(source)
      await chat.setNodeMode(b.record.owner, 'natural')
      const tail = (b.turnTail?.inject as unknown as (id: SessionId) => BranchSuggestionTailInjected)(source)
      await tail.keepBranchSuggestion('keep-on-current')
      const draft = (b.draftReview?.inject as unknown as (id: SessionId) => DraftContextReviewInjected)(source)
      draft.discard()
      b.expanded.mockReturnValue(false)
      actions.close()
      expect(b.closeDetails).not.toHaveBeenCalled()
      expect(b.calls.filter(call => call.method === 'focusNodeExcerpt')).toEqual([{
        method: 'focusNodeExcerpt', args: [source, { revision: 4 }, b.record.owner, 0, 5, 'Focused by user', 'contextify-client'],
      }])
      expect(b.calls.filter(call => call.method === 'reviewWorkState')).toEqual([{
        method: 'reviewWorkState', args: [source, b.proposal, child, 'reject', 'contextify-client'],
      }])
      expect(b.calls.some(call => call.method === 'keepBranchSuggestion')).toBe(true)
    } finally { await b.fiber.dispose() }
  })

  it('shows a Remote error without changing editor contents or opening a destination', async () => {
    const b = await bench()
    try {
      b.remoteFace.get = async () => ({ ok: false, error: new RemoteError('gateway/internal', 'Host unavailable', {}) })
      await expect(b.panel.mapActions.reset()).rejects.toThrow('Host unavailable')
      expect(b.moveDraft).not.toHaveBeenCalled()
      expect(b.open).not.toHaveBeenCalled()
    } finally { await b.fiber.dispose() }
  })

  it('cancels the exact Deep Remote request without applying its late proposal', async () => {
    const b = await bench()
    const gate = Promise.withResolvers<RemoteResult<ContextRecommendationProposal>>()
    try {
      b.remoteFace.recommend = () => gate.promise
      const review = b.panel.mapActions.recommend('deep')
      await vi.waitFor(() => { expect(b.panel.hooks.contextify.getSnapshot().recommendation.phase).toBe('running') })
      await b.panel.mapActions.cancelRecommendation()
      gate.resolve({ ok: true, value: b.proposal })
      await review
      expect(b.calls.filter(call => call.method === 'cancelRecommendation')).toEqual([{
        method: 'cancelRecommendation', args: [source],
      }])
      expect(b.panel.hooks.contextify.getSnapshot().recommendation.phase).toBe('idle')
      expect(b.calls.some(call => call.method === 'setNodeModes')).toBe(false)
    } finally { gate.resolve({ ok: true, value: b.proposal }); await b.fiber.dispose() }
  })

  it.each(['manual', 'branch', 'tail', 'reject-route', 'accept-route'] as const)('requires the live editor scope for %s actions', async (operation) => {
    const b = await bench()
    const route: Mutable<ContextRouteAdvice> = { action: 'navigate', objective: 'draft', targetSessionId: child,
      reason: 'continue', base: { activeSessionId: source, planRevision: 4, graphRevision: 'family-7' } }
    try {
      b.sessionScope.mockReturnValue(undefined)
      const tail = (b.turnTail?.inject as unknown as (id: SessionId) => BranchSuggestionTailInjected)(source)
      const pending = operation === 'manual' ? b.panel.mapActions.moveDraftHere(child)
        : operation === 'branch' ? b.panel.mapActions.branch(b.record)
          : operation === 'tail' ? tail.moveBranchSuggestion('suggestion')
            : operation === 'reject-route' ? b.panel.mapActions.rejectRoute(route)
              : b.panel.mapActions.acceptRoute(route)
      await expect(pending).rejects.toThrow(/current Session|draft changed/)
      expect(b.moveDraft).not.toHaveBeenCalled()
      expect(b.open).not.toHaveBeenCalled()
    } finally { await b.fiber.dispose() }
  })

  it.each(['missing-map', 'revision', 'active-session', 'same-target', 'outside-family', 'editor-phase'] as const)('rejects a manual transfer with %s', async (condition) => {
    const b = await bench()
    try {
      if (condition !== 'missing-map') await (b.panel.hooks.contextify as ContextifyController).refresh()
      b.draftState.draft = 'Continue planning'
      if (condition === 'revision') b.page.revision = 'changed'
      if (condition === 'active-session') b.page.activeSessionId = child
      if (condition === 'editor-phase') b.draftState.phase = 'adjudicating'
      await expect(b.panel.mapActions.moveDraftHere(condition === 'same-target' ? source : condition === 'outside-family' ? sid('outsider') : child))
        .rejects.toThrow(/ready|destination|Write a draft/)
      expect(b.moveDraft).not.toHaveBeenCalled()
      expect(b.calls.some(call => call.method === 'recordManualRoute')).toBe(false)
    } finally { await b.fiber.dispose() }
  })

  it('rejects lifecycle changes before the Map is ready', async () => {
    const b = await bench()
    try {
      await expect(b.panel.mapActions.setWorkState(child, 'completed')).rejects.toThrow('ready')
      expect(b.calls.some(call => call.method === 'setWorkState')).toBe(false)
    } finally { await b.fiber.dispose() }
  })

  it('records a route rejection only for the exact current draft', async () => {
    const b = await bench()
    const route: Mutable<ContextRouteAdvice> = { action: 'return', objective: 'Return to writing', targetSessionId: child,
      reason: 'resume', base: { activeSessionId: source, planRevision: 4, graphRevision: 'family-7' } }
    try {
      await expect(b.panel.mapActions.rejectRoute(route)).rejects.toThrow('draft changed')
      b.draftState.draft = ` ${route.objective} `
      await b.panel.mapActions.rejectRoute(route)
      expect(b.calls.filter(call => call.method === 'reviewRoute')).toEqual([{
        method: 'reviewRoute', args: [source, route, 'reject', undefined, 'contextify-client'],
      }])
    } finally { await b.fiber.dispose() }
  })

  it.each(['active', 'graph', 'plan', 'page-session', 'phase', 'missing-target', 'outside-target', 'transfer'] as const)('keeps the current editor after a reviewed route fails %s validation', async (condition) => {
    const b = await bench()
    const route: Mutable<ContextRouteAdvice> = { action: 'navigate', objective: 'Draft', targetSessionId: child,
      reason: 'use', base: { activeSessionId: source, planRevision: 4, graphRevision: 'family-7' } }
    try {
      b.draftState.draft = route.objective
      if (condition === 'active') route.base = { ...route.base, activeSessionId: child }
      if (condition === 'graph') route.base = { ...route.base, graphRevision: 'old' }
      if (condition === 'plan') route.base = { ...route.base, planRevision: 1 }
      if (condition === 'page-session') b.page.activeSessionId = child
      if (condition === 'phase') b.draftState.phase = 'adjudicating'
      if (condition === 'missing-target') delete route.targetSessionId
      if (condition === 'outside-target') route.targetSessionId = sid('outsider')
      if (condition === 'transfer') b.moveDraft.mockReturnValue(false)
      await expect(b.panel.mapActions.acceptRoute(route)).rejects.toThrow(/stale|draft changed|unavailable/)
      expect(b.open).not.toHaveBeenCalled()
    } finally { await b.fiber.dispose() }
  })

  it.each(['unloaded', 'no-boundary', 'valid'] as const)('uses a reviewed completed-Turn boundary for new branches: %s', async (condition) => {
    const b = await bench()
    const route: Mutable<ContextRouteAdvice> = { action: 'branch', objective: 'A new task', reason: 'parallel',
      base: { activeSessionId: source, planRevision: 4, graphRevision: 'family-7' } }
    try {
      b.draftState.draft = route.objective
      if (condition === 'no-boundary') b.page.records = [{ ...b.record, branchAtSeq: null }]
      if (condition !== 'unloaded') await (b.panel.hooks.contextify as ContextifyController).refresh()
      if (condition === 'valid') {
        await b.panel.mapActions.acceptRoute(route)
        expect(b.fork).toHaveBeenCalledWith({ sessionId: source, atSeq: 9, increaseTitle: true })
        expect(b.open).toHaveBeenCalledWith(child)
      } else {
        await expect(b.panel.mapActions.acceptRoute(route)).rejects.toThrow(/stale|completed/)
        expect(b.fork).not.toHaveBeenCalled()
      }
      expect(() => nativeBranchSource({ ...b.record, branchAtSeq: null })).toThrow('completed Turn')
    } finally { await b.fiber.dispose() }
  })
  it.each([
    { label: 'ordinary native fork', origin: false, addressed: false, blank: false, expected: 1 },
    { label: 'addressed execution detail', origin: false, addressed: true, blank: false, expected: 0 },
    { label: 'cataloged execution detail', origin: true, addressed: false, blank: false, expected: 0 },
    { label: 'blank native fork', origin: false, addressed: false, blank: true, expected: 0 },
  ])('auto-opens only supported nonempty native Sessions: $label', async ({ origin, addressed, blank, expected }) => {
    const b = await bench()
    const state: SessionListState = {
      ids: [child], current: child, phase: 'ready', subagentsByParent: {}, jobsBySession: {},
      currentAddress: addressed ? { parentSessionId: source, childSessionId: child, mode: 'continuable' } : undefined,
      byId: { [child]: {
        id: child, parentId: source, displayTitle: 'Child', running: false, blank, updatedAt: 0,
        ...(origin ? { origin: 'subagent' as const } : {}),
      } },
    }
    const useSessions: SnapshotSelectorHook<SessionListState> = selector => selector(state)
    // The registry erases component props; this entry's declared standard seat is useSessions.
    const Opener = b.opener?.component as ComponentType<{ open: () => void; useSessions: typeof useSessions }>
    const mounted = render(<Opener open={b.openDetails} useSessions={useSessions} />)
    try {
      expect(b.openDetails).toHaveBeenCalledTimes(expected)
    } finally {
      mounted.unmount()
      await b.fiber.dispose()
    }
  })

  it('resolves registry and guide copy through the current language', async () => {
    const b = await bench()
    const definition = b.registerTab.mock.calls[0]?.[0]
    expect(definition).toBeDefined()
    expect(definition?.title('sidebar://context-map')).toBe('Context Map')
    expect(definition?.guide?.[0]?.title()).toBe('Context Map')
    expect(definition?.guide?.[0]?.description?.()).toBe('Inspect branches and control conversation context')
    b.ctx.locale.setLocale('zh')
    expect(definition?.title('sidebar://context-map')).toBe('Context Map')
    expect(definition?.guide?.[0]?.title()).toBe('Context Map')
    expect(definition?.guide?.[0]?.description?.()).toBe('查看分支并管理对话 Context')
    await b.fiber.dispose()
  })

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
      args: [source, child, 'contextify-client', 'Use the previous Web evidence'],
    }])
  })

  it('keeps the current Session selected when the draft cannot be transferred', async () => {
    const b = await bench()
    b.moveDraft.mockReturnValueOnce(false)
    await expect(b.panel.mapActions.branch(b.record)).rejects.toThrow(/draft changed/)
    expect(b.open).not.toHaveBeenCalled()
    expect(b.calls.some(call => call.method === 'recordManualBranch')).toBe(false)
  })

  it('records explicit manual navigation only after successfully moving the captured draft', async () => {
    const b = await bench()
    await (b.panel.hooks.contextify as never as { refresh: () => Promise<void> }).refresh()
    b.draftState.draft = 'Continue the Web planning task'
    b.draftState.draftRev = 14
    await b.panel.mapActions.moveDraftHere(child)
    expect(b.moveDraft).toHaveBeenCalledWith(source, child, { draft: b.draftState.draft, draftRev: 14 })
    expect(b.calls.filter(call => call.method === 'recordManualRoute')).toEqual([{
      method: 'recordManualRoute', args: [source, child, expect.any(String), 'family-7',
        'contextify-client', 'Continue the Web planning task'],
    }])
    expect(b.open).toHaveBeenCalledWith(child)
    b.panel.mapActions.locate(b.record)
    expect(b.calls.filter(call => call.method === 'recordManualRoute')).toHaveLength(1)
  })

  it('does not learn a manual route for an empty or unsuccessfully transferred draft', async () => {
    const b = await bench()
    await (b.panel.hooks.contextify as never as { refresh: () => Promise<void> }).refresh()
    await expect(b.panel.mapActions.moveDraftHere(child)).rejects.toThrow(/Write a draft/)
    expect(b.moveDraft).not.toHaveBeenCalled()
    b.draftState.draft = 'A nonempty draft'
    b.moveDraft.mockReturnValueOnce(false)
    await expect(b.panel.mapActions.moveDraftHere(child)).rejects.toThrow(/draft changed/)
    expect(b.calls.filter(call => call.method === 'recordManualRoute')).toHaveLength(0)
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

  it('passes explicit approval of the proposed Context with a native draft transfer', async () => {
    const b = await bench()
    b.draftState.draft = 'Continue writing'
    const route = { action: 'navigate' as const,
      base: { planRevision: 4, graphRevision: 'family-7', activeSessionId: source },
      objective: 'Continue writing', targetSessionId: child, reason: 'Resume writing' }
    await b.panel.mapActions.acceptRoute(route, true)
    expect(b.calls.filter(call => call.method === 'reviewRoute')).toEqual([{
      method: 'reviewRoute', args: [source, route, 'accept', child, 'contextify-client', true],
    }])
    expect(b.open).toHaveBeenCalledWith(child)
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
        'Bring the prior Web evidence into this draft', 'local', true],
    }])
    await actions.review('Compare the current Web sources', 'fast')
    expect(b.calls.filter(call => call.method === 'recommend')[1]?.args).toEqual([
      source, { planRevision: 4, graphRevision: 'family-7', activeSessionId: source },
      'Compare the current Web sources', 'fast', true,
    ])
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

  it('clears advice invalidated by a policy reset while retaining the current Context Plan', async () => {
    const b = await bench()
    await b.panel.mapActions.recommend()
    expect(b.panel.hooks.contextify.getSnapshot().recommendation.phase).toBe('ready')
    await b.panel.mapActions.resetPolicy()
    expect(b.calls.filter(call => call.method === 'resetPolicy')).toEqual([{
      method: 'resetPolicy', args: [source, 'contextify-client'],
    }])
    expect(b.panel.hooks.contextify.getSnapshot().recommendation.phase).toBe('idle')
    expect(b.calls.filter(call => call.method === 'reset' || call.method === 'setNodeModes')).toHaveLength(0)
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

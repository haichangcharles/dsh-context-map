// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ContextMapPanelInjected } from '../src/client/ContextMapPanel.tsx'
import type { ContextMessageActionInjected } from '../src/client/ContextMessageAction.tsx'
import { apply, inject } from '../src/client/index.ts'

const sid = (value: string): SessionId => value as SessionId
const source = sid('session-1')
const child = sid('session-child')

/** Mount the browser plugin over real Cordis slots and deterministic fake service faces. */
async function bench() {
  const ctx = new Context()
  const calls: Array<{ method: string; args: unknown[] }> = []
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const view = {
    plan: {
      kind: 'contextify/plan', version: 2, revision: 4, stateRevision: 4,
      history: { past: [3], future: [] }, excluded: [], included: [],
    },
    graphAsOfSeq: 7, selectedCount: 1, totalNodeCount: 1, canUndo: true, canRedo: false,
  }
  const record = {
    id: 'session-1:7', owner: { sessionId: source, seq: 7 }, role: 'user' as const,
    preview: 'hello', time: 7, branchAtSeq: 9, sessionIds: [source], activeEventSeq: 7,
  }
  const answer = <T,>(method: string, value: T) => (...args: unknown[]) => {
    calls.push({ method, args })
    return Promise.resolve({ ok: true as const, value })
  }
  ctx.provide('remote.contextify', {
    get: answer('get', view),
    familyPage: answer('familyPage', {
      asOfSeq: 7,
      rootSessionId: source,
      activeSessionId: source,
      sessions: [{ id: source, seedLength: 0, depth: 0, tipNodeId: record.id }],
      edges: [],
      records: [record],
      totalNodeCount: 1,
    }),
    setNodeMode: answer('setNodeMode', view),
    setNodeModes: answer('setNodeModes', view),
    reset: answer('reset', view),
    undo: answer('undo', view),
    redo: answer('redo', view),
  })
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  ctx.provide('layout', { openDetails, closeDetails, toggleSidebar: vi.fn() })
  const fork = vi.fn(async () => child)
  const open = vi.fn()
  ctx.provide('sessions', { fork, open })
  const revealMessage = vi.fn()
  const openPinnedDetails = vi.fn()
  ctx.provide('conversation', { revealMessage, openPinnedDetails } as never)
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.details.pinned': { kind: 'list', scope: 'session' },
      'conversation.chat.user-actions': { kind: 'list', scope: 'session' },
      'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const pinned = ctx.slots.entries('conversation.details.pinned')[0]
  const injectPanel = pinned?.inject as unknown as ((sessionId: SessionId) => ContextMapPanelInjected)
  const userAction = ctx.slots.entries('conversation.chat.user-actions')[0]
  const assistantAction = ctx.slots.entries('conversation.chat.assistant-actions')[0]
  return {
    ctx, fiber, calls, closeDetails, openDetails, fork, open, revealMessage, openPinnedDetails, record,
    panel: injectPanel(source),
    pinned,
    userAction,
    assistantAction,
    opener: ctx.slots.entries('shell.overlay')[0],
  }
}

describe('ui-contextify browser plugin', () => {
  it('shares one native-family controller across the pinned map and both Chat action slots', async () => {
    const b = await bench()
    expect(b.pinned?.options).toMatchObject({ id: 'contextify', order: 0 })
    expect(b.opener?.options).toMatchObject({ id: 'contextify-open-details' })
    expect(b.userAction?.options).toMatchObject({ id: 'contextify', order: 20 })
    expect(b.assistantAction?.options).toMatchObject({ id: 'contextify', order: 20 })

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
      method: 'setNodeMode', args: [source, { revision: 4 }, b.record.owner, 'exclude'],
    }])
    expect(b.fork).toHaveBeenCalledWith({ sessionId: source, atSeq: 9, increaseTitle: true })
    expect(b.open).toHaveBeenNthCalledWith(1, child)
    expect(b.revealMessage).toHaveBeenCalledWith(source, 7)
    expect(b.openPinnedDetails).toHaveBeenCalledWith(source)
    expect(b.openDetails).toHaveBeenCalledOnce()
    expect(b.closeDetails).toHaveBeenCalledOnce()
  })

  it('removes all four slot contributions with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.details.pinned')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.chat.user-actions')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.chat.assistant-actions')).toHaveLength(0)
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })
})

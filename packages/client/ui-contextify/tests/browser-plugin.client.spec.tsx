// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ContextMapPanelActions } from '../src/client/ContextMapPanel.tsx'
import { apply, inject } from '../src/client/index.ts'

const sid = (value: string): SessionId => value as SessionId

/** Mount the browser plugin over real Cordis slots and deterministic fake service faces. */
async function bench() {
  const ctx = new Context()
  const calls: Array<{ method: string; args: unknown[] }> = []
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const answer = <T,>(method: string, value: T) => (...args: unknown[]) => {
    calls.push({ method, args })
    return Promise.resolve({ ok: true as const, value })
  }
  ctx.provide('remote.contextify', {
    get: answer('get', {
      plan: { revision: 4, mainlinePathId: 'root', activePathId: 'root', paths: [], overrides: [] },
      graphAsOfSeq: 7, activeTipSeq: 7, selectedCount: 1, totalNodeCount: 1,
    }),
    graphPage: answer('graphPage', {
      records: [{ seq: 7, parentSeq: null, pathId: 'root', turn: 1, role: 'user', sourceKind: 'user', locked: false, preview: 'hello' }],
      nextAfterSeq: undefined,
    }),
    createBranch: answer('createBranch', {}),
    selectPath: answer('selectPath', {}),
    returnToMainline: answer('returnToMainline', {}),
    setNodeMode: answer('setNodeMode', {}),
  })
  const openDetails = vi.fn()
  const closeDetails = vi.fn()
  ctx.provide('layout', { openDetails, closeDetails, toggleSidebar: vi.fn() })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.details.pinned': { kind: 'list', scope: 'session' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const entry = ctx.slots.entries('conversation.details.pinned')[0]
  const injectActions = entry?.inject as unknown as ((sessionId: SessionId) => ContextMapPanelActions)
  return {
    ctx, fiber, calls, closeDetails,
    actions: injectActions(sid('session-1')),
    pinned: entry,
    opener: ctx.slots.entries('shell.overlay')[0],
  }
}

describe('ui-contextify browser plugin', () => {
  it('registers the pinned map and adapts its actions to the generated Remote namespace', async () => {
    const b = await bench()
    expect(b.pinned?.options).toMatchObject({ id: 'contextify', order: 0 })
    expect(b.opener?.options).toMatchObject({ id: 'contextify-open-details' })
    expect(await b.actions.load()).toMatchObject({
      view: { plan: { revision: 4 } },
      records: [{ seq: 7, preview: 'hello' }],
    })
    await b.actions.setNodeMode(7, 'exclude', 4)
    await b.actions.createBranch(7, 4)
    b.actions.close()
    expect(b.calls).toEqual([
      { method: 'get', args: ['session-1'] },
      { method: 'graphPage', args: ['session-1', undefined, 500] },
      { method: 'setNodeMode', args: ['session-1', { revision: 4 }, 7, 'exclude'] },
      { method: 'createBranch', args: ['session-1', { revision: 4 }, 7, undefined] },
    ])
    expect(b.closeDetails).toHaveBeenCalledOnce()
  })

  it('removes both slot contributions with the plugin fiber', async () => {
    const b = await bench()
    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.details.pinned')).toHaveLength(0)
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
  })
})

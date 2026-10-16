/** A reviewed Context set survives native navigation without another inference. */
import { expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'

function append(session: Session, text: string): string {
  const turn = session.seq + 1
  session.append('turn/start', { turn })
  const event = session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'mock', model: 'mock' }, content: [] }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return `${session.id}:${String(event.seq)}`
}

type Harness = Awaited<ReturnType<typeof lineageHarness>>
async function setup(b: Harness, mode: 'clean' | 'with-side' | 'unchanged' = 'clean', pin = false, excerpt = false) {
  const valid = append(b.parent.session, 'Plan the community event')
  const noise = append(b.parent.session, 'Unrelated discarded topic')
  const seed = b.parent.session.snapshotEvents()
  const child = (await b.ctx.agents.create({ sessionId: SessionId('scope-handoff-child'), seed,
    inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: b.parent.id, isSeeded: true },
    agentOptions: { provider: 'mock', model: 'mock' } })).agent
  const side = append(child.session, 'A different brainstorm')
  if (pin) await b.ctx.contextify.setNodeMode(b.parent, { revision: b.ctx.contextify.get(b.parent).plan.revision },
    { sessionId: b.parent.id, seq: Number(valid.split(':').at(-1)) }, 'exclude', 'contextify-client')
  if (excerpt) await b.ctx.contextify.focusNodeExcerpt(child, { revision: b.ctx.contextify.get(child).plan.revision },
    { sessionId: b.parent.id, seq: Number(valid.split(':').at(-1)) }, 0, 4, 'Keep the opening')
  let requests = 0
  b.adapter.stream = async function * () {
    requests++
    yield * textResponse(JSON.stringify({ include: [], archive: [],
      exclude: (mode === 'with-side' ? [noise] : mode === 'unchanged' ? [side] : [noise, side])
        .map(nodeId => ({ nodeId, reason: 'Outside this task' })) }))
  }
  const page = await b.ctx.contextify.familyPage(child)
  const base = { activeSessionId: child.id, planRevision: b.ctx.contextify.get(child).plan.revision,
    graphRevision: page.revision }
  const proposal = await b.ctx.contextify.recommend(child, base, 'Return to the mainline', 'fast', true)
  if (proposal.route === undefined) throw new Error('missing native Return advice')
  const route = proposal.route
  const accept = (carryContext = true) => b.ctx.contextify.reviewRoute(child, route, 'accept', b.parent.id, 'contextify-client', carryContext)
  return { child, proposal, route, base, valid, noise, side, accept, requests: () => requests }
}

it('carries an explicitly approved scope into the parent and records its original decision base', async () => {
  const b = await lineageHarness()
  try {
    const s = await setup(b)
    expect(s.proposal.proposedNodeIds).toEqual([s.valid])
    await s.accept()
    expect(b.ctx.contextify.get(b.parent).plan.excluded.map(item => item.nodeId)).toEqual([s.noise])
    const reviewed = b.parent.session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-reviewed')
    expect(reviewed?.data).toMatchObject({ sourceBase: s.base })
    expect(b.ctx.contextify.get(s.child).plan.revision).toBe(s.base.planRevision)
    expect(s.requests()).toBe(1)
    await s.accept()
    await expect(s.accept(false)).rejects.toThrow('already decided')
  } finally { await b.close() }
})

it.each(['with-side', 'unchanged'] as const)('preserves %s scope with no extra inference', async (mode) => {
  const b = await lineageHarness()
  try {
    const s = await setup(b, mode)
    const before = b.ctx.contextify.get(b.parent).plan.revision
    await s.accept()
    const view = b.ctx.contextify.get(b.parent)
    if (mode === 'with-side') expect(view.plan.included.map(item => item.nodeId)).toEqual([s.side])
    else expect(view.plan.revision).toBe(before)
    expect(s.requests()).toBe(1)
    expect(b.parent.session.snapshotEvents().some(event => event.type === 'contextify/recommendation-reviewed'
      && event.data.sourceBase?.activeSessionId === s.child.id)).toBe(true)
  } finally { await b.close() }
})

it('preserves a conflicting manual target exclusion and does not record acceptance', async () => {
  const b = await lineageHarness()
  try {
    const s = await setup(b, 'clean', true)
    const before = b.ctx.contextify.get(b.parent).plan
    await expect(s.accept()).rejects.toThrow('conflicts')
    expect(b.ctx.contextify.get(b.parent).plan).toEqual(before)
    expect(s.child.session.snapshotEvents().some(event => event.type === 'contextify/route-choice')).toBe(false)
  } finally { await b.close() }
})

it('requires an accepted existing destination and preserves an existing target review', async () => {
  const b = await lineageHarness()
  try {
    const s = await setup(b)
    await expect(b.ctx.contextify.reviewRoute(s.child, s.route, 'reject', undefined, 'contextify-client', true)).rejects.toThrow('existing destination')
    const page = await b.ctx.contextify.familyPage(b.parent)
    await b.ctx.contextify.recommend(b.parent, { activeSessionId: b.parent.id, graphRevision: page.revision,
      planRevision: b.ctx.contextify.get(b.parent).plan.revision }, 'Review this target', 'fast')
    await expect(s.accept()).rejects.toThrow('finish the destination')
  } finally { await b.close() }
})

it('clears a failed carried proposal so a later valid explicit operation can succeed', async () => {
  const b = await lineageHarness()
  try {
    const s = await setup(b)
    const mutation = vi.spyOn(b.ctx.contextify as unknown as { applyNodeModes(): Promise<unknown> }, 'applyNodeModes').mockRejectedValueOnce(new Error('destination write interrupted'))
    await expect(s.accept()).rejects.toThrow('write interrupted')
    mutation.mockRestore()
    await s.accept()
    expect(b.ctx.contextify.get(b.parent).plan.excluded.map(item => item.nodeId)).toEqual([s.noise])
  } finally { vi.restoreAllMocks(); await b.close() }
})

type FamilyReader = { loadFamily(session: Session): Promise<unknown> }
it.each(['graph', 'reset', 'source-plan'] as const)('rejects a %s change after loading the target snapshot', async (change) => {
  const b = await lineageHarness()
  try {
    const s = await setup(b)
    const service = b.ctx.contextify as unknown as FamilyReader
    const read = service.loadFamily.bind(service)
    // Wrap a real completed storage read; the edit occurs while its caller is suspended.
    vi.spyOn(service, 'loadFamily').mockImplementation(async (session) => {
      const family = await read(session)
      if (session.id === b.parent.id) {
        if (change === 'graph') append(s.child.session, 'New intervening message')
        else if (change === 'reset') await b.ctx.contextify.resetPolicy(s.child, 'contextify-client')
        else b.ctx.contextify.reset(s.child, { revision: s.base.planRevision })
      }
      return family
    })
    await expect(s.accept()).rejects.toThrow(/changed|cleared/)
    expect(b.ctx.contextify.get(b.parent).plan.excluded).toEqual([])
  } finally { vi.restoreAllMocks(); await b.close() }
})

it('refuses a destination Agent disposed after the source revision was verified', async () => {
  const b = await lineageHarness()
  try {
    const s = await setup(b)
    const service = b.ctx.contextify as unknown as FamilyReader
    const read = service.loadFamily.bind(service)
    vi.spyOn(service, 'loadFamily').mockImplementation(async (session) => {
      const family = await read(session)
      await b.disposeParent()
      return family
    })
    await expect(s.accept()).rejects.toThrow('unavailable')
  } finally { vi.restoreAllMocks(); await b.close() }
})

it.each(['target-plan', 'source-plan', 'reset', 'graph', 'dispose'] as const)('rejects a %s edit after the final family read', async (change) => {
  const b = await lineageHarness()
  try {
    const s = await setup(b)
    const service = b.ctx.contextify as unknown as FamilyReader
    const read = service.loadFamily.bind(service)
    let targetReads = 0
    vi.spyOn(service, 'loadFamily').mockImplementation(async (session) => {
      const family = await read(session)
      if (session.id === b.parent.id && ++targetReads === 2) {
        if (change === 'target-plan') b.ctx.contextify.reset(b.parent, { revision: b.ctx.contextify.get(b.parent).plan.revision })
        else if (change === 'source-plan') b.ctx.contextify.reset(s.child, { revision: s.base.planRevision })
        else if (change === 'reset') await b.ctx.contextify.resetPolicy(s.child, 'contextify-client')
        else if (change === 'graph') append(s.child.session, 'Intervening task')
        else await b.disposeParent()
      }
      return family
    })
    await expect(s.accept()).rejects.toThrow(/stale|changed|cleared|live|unavailable/)
    expect(b.parent.session.snapshotEvents().some(event => event.type === 'contextify/recommendation-reviewed')).toBe(false)
    expect(s.child.session.snapshotEvents().some(event => event.type === 'contextify/route-choice')).toBe(false)
  } finally { vi.restoreAllMocks(); await b.close() }
})

it('does not expand a reviewed source excerpt into the full destination message', async () => {
  const b = await lineageHarness()
  try {
    const s = await setup(b, 'clean', false, true)
    await expect(s.accept()).rejects.toThrow('replaced')
    expect(b.ctx.contextify.get(b.parent).plan.excluded).toEqual([])
  } finally { await b.close() }
})

it('detects a new live branch below an unloaded family parent after the final read', async () => {
  const b = await lineageHarness()
  try {
    const seed = b.parent.session.snapshotEvents()
    const member = await b.ctx.agents.create({ sessionId: SessionId('unloaded-family-member'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: b.parent.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' } })
    append(member.agent.session, 'Earlier parked branch')
    await member.dispose()
    const s = await setup(b)
    const service = b.ctx.contextify as unknown as FamilyReader
    const read = service.loadFamily.bind(service)
    let targetReads = 0
    vi.spyOn(service, 'loadFamily').mockImplementation(async (session) => {
      const family = await read(session)
      if (session.id === b.parent.id && ++targetReads === 2) {
        b.ctx.sessions.create(SessionId('new-child-of-unloaded'), { meta: { parentSession: SessionId('unloaded-family-member') } })
      }
      return family
    })
    await expect(s.accept()).rejects.toThrow('changed')
    expect(b.parent.session.snapshotEvents().some(event => event.type === 'contextify/recommendation-reviewed')).toBe(false)
  } finally { vi.restoreAllMocks(); await b.close() }
})

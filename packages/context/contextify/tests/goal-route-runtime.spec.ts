import { expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'
import { CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings } from '../src/types.ts'
import { compileContextify } from '../src/plan.ts'

function append(session: Session, text: string) {
  const turn = session.seq + 1
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'Recorded task response.' }],
  }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}
type Fixture = Awaited<ReturnType<typeof lineageHarness>>
function promptAccess(b: Fixture) {
  return b.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
}
async function fork(b: Fixture, parent: Fixture['parent'], id: string) {
  const seed = parent.session.snapshotEvents()
  return (await b.ctx.agents.create({ sessionId: SessionId(id), seed, inheritedEventCount: SessionLogOffset(seed.length),
    meta: { parentSession: parent.id, isSeeded: true }, agentOptions: { provider: 'mock', model: 'mock' } })).agent
}
function jev(body: { questions: Record<string, { type: string; criteria?: Record<string, string> }> }) {
  return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
    if (q.type === 'noul') return [key, { type: 'noul', noul: key === 'wholeTask' ? 1 : .05 }]
    const choice = q.criteria?.p0 === undefined ? 'active' : 'p0'
    return [key, { type: 'choice', choice, probabilities: { [choice]: 1 } }]
  })) as Record<string, unknown> })
}
function requestBody(init?: RequestInit): Parameters<typeof jev>[0] {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON fixture request')
  return JSON.parse(init.body) as Parameters<typeof jev>[0]
}
function configure(b: Fixture, response: string, credential = true) {
  promptAccess(b).promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, fastDecisionProvider: 'goal-model-jev',
    context: { additional: 'Keep the entire selected task and its ancestors. Independent services are siblings.', override: '' } })
  if (credential) b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
  return vi.spyOn(b.adapter, 'stream').mockImplementation(async function* (options) {
    b.adapter.requests.push(options)
    yield* textResponse(response)
  })
}
async function review(b: Fixture, agent: Fixture['parent'], draft = 'Arrange transport for the trip.') {
  const page = await b.ctx.contextify.familyPage(agent)
  return b.ctx.contextify.recommend(agent, { activeSessionId: agent.id, graphRevision: page.revision,
    planRevision: b.ctx.contextify.get(agent).plan.revision }, draft, 'fast', true)
}

it('proposes a parent Branch through native review and compiles only its approved task scope', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Find dinner for the trip.')
    const hotel = await fork(b, b.parent, 'goal-runtime-hotel')
    append(hotel.session, 'Find lodging for the trip.')
    configure(b, JSON.stringify({ goal: 'Arrange transport', assignment: 'new', sessionId: b.parent.id }))
    fetcher.mockImplementation(async (_url, init) => {
      expect(hotel.session.snapshotEvents().at(-1)?.type).toBe('contextify/recommendation-request')
      expect(JSON.stringify(requestBody(init))).not.toContain('fixture-only-key')
      return jev(requestBody(init))
    })
    const result = await review(b, hotel)
    expect(result.route).toMatchObject({ action: 'branch', forkParentSessionId: b.parent.id })
    expect(result.personalization?.reviewer).toBe('goal-model-jev')
    expect(b.adapter.requests).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(b.ctx.contextify.get(hotel).plan.revision).toBe(1)
    const taxi = await fork(b, b.parent, 'goal-runtime-taxi')
    await b.ctx.contextify.reviewRoute(hotel, result.route!, 'accept', taxi.id, undefined, true)
    const compiled = compileContextify({ session: taxi.session, turn: taxi.session.seq + 1, step: 1 })
    expect(JSON.stringify(compiled.messages)).toContain('Find dinner for the trip.')
    expect(JSON.stringify(compiled.messages)).not.toContain('Find lodging for the trip.')
    const requestLogs = hotel.session.snapshotEvents().filter(e => e.type === 'contextify/recommendation-request')
    expect(requestLogs).toHaveLength(2)
    expect(JSON.stringify(requestLogs)).not.toContain('fixture-only-key')
  } finally { fetcher.mockRestore(); await b.close() }
})

it('abstains without a Jev request or inferred selection changes', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Write a plan.')
    configure(b, '{"goal":"Ambiguous continuation","assignment":"unknown","sessionId":null}')
    fetcher.mockRejectedValue(new Error('No second call is allowed'))
    const result = await review(b, b.parent, 'Please handle that.')
    expect(result.route).toBeUndefined()
    expect(result.selection).toEqual([])
    expect(b.adapter.requests).toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore(); await b.close() }
})

it('checks Jev credentials before spending a goal-model call', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Write a plan.')
    configure(b, '{}', false)
    await expect(review(b, b.parent)).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
    expect(b.adapter.requests).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore(); await b.close() }
})

it('rejects an invented destination before Jev and leaves the Plan unchanged', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Write a plan.')
    configure(b, '{"goal":"Invent work","assignment":"existing","sessionId":"outside-family"}')
    await expect(review(b, b.parent)).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
    expect(b.ctx.contextify.get(b.parent).plan.revision).toBe(1)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore(); await b.close() }
})

it('learns from recorded Branch operations and removes examples when personalization is disabled or reset', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Plan dinner.')
    const child = await fork(b, b.parent, 'goal-history-child')
    append(child.session, 'Plan lodging.')
    await b.ctx.contextify.recordManualBranch(b.parent, child.id, 'contextify-client', 'Keep lodging separate from dinner')
    configure(b, JSON.stringify({ goal: 'Review lodging', assignment: 'existing', sessionId: child.id }))
    fetcher.mockImplementation(async (_url, init) => jev(requestBody(init)))
    const captured = () => {
      const event = child.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-request' && e.data.maxTokens === 512)
      if (event?.type !== 'contextify/recommendation-request') throw new Error('Goal request missing')
      return JSON.parse(event.data.userText) as { confirmedExamples: { action: string; choice: string }[] }
    }
    await review(b, child, 'Please organize the lodging notes.')
    expect(captured().confirmedExamples).toContainEqual(expect.objectContaining({ action: 'branch', choice: 'accept' }))
    const enabledSettings = promptAccess(b).promptSettings()
    promptAccess(b).promptSettings = () => ({ ...enabledSettings, personalizationEnabled: false })
    await review(b, child, 'Please organize the lodging notes.')
    expect(captured().confirmedExamples).toEqual([])
    promptAccess(b).promptSettings = () => enabledSettings
    await b.ctx.contextify.resetPolicy(child, 'contextify-client')
    await review(b, child, 'Please organize the lodging notes.')
    expect(captured().confirmedExamples).toEqual([])
  } finally { fetcher.mockRestore(); await b.close() }
})

it('returns to the parent and later reactivates the other task with its complete reviewed Context', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'DINNER_MAINLINE')
    const child = await fork(b, b.parent, 'goal-reactivate-child')
    append(child.session, 'TAXI_TASK_DETAIL')
    configure(b, JSON.stringify({ goal: 'Continue dinner', assignment: 'existing', sessionId: b.parent.id }))
    fetcher.mockImplementation(async (_url, init) => jev(requestBody(init)))
    const returning = await review(b, child, 'Please organize the dinner notes.')
    expect(returning.route?.action).toBe('return')
    await b.ctx.contextify.reviewRoute(child, returning.route!, 'accept', b.parent.id, undefined, true)
    const afterReturn = compileContextify({ session: b.parent.session, turn: b.parent.session.seq + 1, step: 1 })
    expect(JSON.stringify(afterReturn.messages)).not.toContain('TAXI_TASK_DETAIL')
    vi.spyOn(b.adapter, 'stream').mockImplementation(async function* (options) {
      b.adapter.requests.push(options)
      yield* textResponse(JSON.stringify({ goal: 'Continue transport', assignment: 'existing', sessionId: child.id }))
    })
    const resuming = await review(b, b.parent, 'Please organize the transport notes.')
    expect(resuming.route).toMatchObject({ action: 'navigate', targetSessionId: child.id })
    await b.ctx.contextify.reviewRoute(b.parent, resuming.route!, 'accept', child.id, undefined, true)
    const reactivated = compileContextify({ session: child.session, turn: child.session.seq + 1, step: 1 })
    expect(JSON.stringify(reactivated.messages)).toContain('TAXI_TASK_DETAIL')
    expect(JSON.stringify(reactivated.messages)).toContain('DINNER_MAINLINE')
  } finally { fetcher.mockRestore(); await b.close() }
})

it('does not continue to Jev when a valid-looking goal was truncated by the model', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Write a plan.')
    const output = JSON.stringify({ goal: 'Continue planning', assignment: 'existing', sessionId: b.parent.id })
    configure(b, output)
    vi.spyOn(b.adapter, 'stream').mockImplementation(async function* (options) {
      b.adapter.requests.push(options)
      yield* textResponse(output).filter(chunk => chunk.type !== 'finish')
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })
    fetcher.mockImplementation(async (_url, init) => jev(requestBody(init)))
    await expect(review(b, b.parent)).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore(); await b.close() }
})

it('cancels goal generation before a second provider call and releases the review owner', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Write a plan.')
    configure(b, '{}')
    vi.spyOn(b.adapter, 'stream').mockImplementation(async function* (options) {
      b.adapter.requests.push(options)
      await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield* textResponse('{}')
    })
    const result = review(b, b.parent)
    const assertion = expect(result).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' })
    await vi.waitFor(() => { expect(b.adapter.requests).toHaveLength(1) })
    b.ctx.contextify.cancelRecommendation(b.parent)
    await assertion
    expect(fetcher).not.toHaveBeenCalled()
    vi.spyOn(b.adapter, 'stream').mockImplementation(async function* () {
      yield* textResponse('{"goal":"Uncertain task","assignment":"unknown","sessionId":null}')
    })
    await expect(review(b, b.parent)).resolves.toMatchObject({ selection: [] })
  } finally { fetcher.mockRestore(); await b.close() }
})

it('keeps abstention empty even when matching prior Context choices would add an off-path source', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Dinner restaurant vegetarian budget Cambridge')
    const first = await fork(b, b.parent, 'goal-preference-first')
    append(first.session, 'Dinner restaurant vegetarian budget Cambridge')
    const firstNode = (await b.ctx.contextify.familyPage(b.parent)).records.find(node => node.owner.sessionId === first.id && node.role === 'user')!
    await b.ctx.contextify.setNodeMode(b.parent, { revision: 1 }, firstNode.owner, 'include', 'contextify-client')
    const second = await fork(b, b.parent, 'goal-preference-second')
    append(second.session, 'Dinner restaurant vegetarian budget Cambridge updated')
    configure(b, '{"goal":"Uncertain scope","assignment":"unknown","sessionId":null}')
    const result = await review(b, b.parent, 'Dinner restaurant vegetarian budget Cambridge')
    expect(result.selection).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    // Negative control: the same real history activates ordinary personalization.
    const settings = promptAccess(b).promptSettings()
    promptAccess(b).promptSettings = () => ({ ...settings, fastDecisionProvider: 'parent-model' })
    vi.spyOn(b.adapter, 'stream').mockImplementation(async function* () {
      yield* textResponse('{"include":[],"exclude":[],"archive":[]}')
    })
    const normal = await review(b, b.parent, 'Dinner restaurant vegetarian budget Cambridge')
    expect(normal.selection.some(item => item.action === 'include' && item.nodeId.startsWith(`${second.id}:`))).toBe(true)
  } finally { fetcher.mockRestore(); await b.close() }
})

it('cancels stalled credential preflight without a model call and releases the family', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  let finish: ((value: { value: string }) => void) | undefined
  try {
    append(b.parent.session, 'Write a plan.')
    configure(b, '{"goal":"Uncertain scope","assignment":"unknown","sessionId":null}', false)
    const resolve = vi.fn(() => new Promise<{ value: string }>((done) => { finish = done }))
    b.ctx.provide('credentials', { resolve } as never)
    const pending = review(b, b.parent)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' })
    await vi.waitFor(() => { expect(resolve).toHaveBeenCalledTimes(1) })
    b.ctx.contextify.cancelRecommendation(b.parent)
    await assertion
    expect(b.adapter.requests).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    resolve.mockImplementation(async () => ({ value: 'fixture-only-key' }))
    await expect(review(b, b.parent)).resolves.toMatchObject({ selection: [] })
  } finally { finish?.({ value: 'fixture-only-key' }); fetcher.mockRestore(); await b.close() }
})

it('keeps Local draft routing available after many manual Context choices without relaxing Fast limits', async () => {
  const b = await lineageHarness()
  try {
    for (let i = 0; i < 35; i++) append(b.parent.session, `Planning note ${i}`)
    const page = await b.ctx.contextify.familyPage(b.parent, undefined, 500)
    const mutations = page.records.filter(node => node.role === 'user').slice(0, 33)
      .map(node => ({ node: node.owner, mode: 'exclude' as const }))
    await b.ctx.contextify.setNodeModes(b.parent, { revision: b.ctx.contextify.get(b.parent).plan.revision }, mutations)
    const current = await b.ctx.contextify.familyPage(b.parent)
    const base = { activeSessionId: b.parent.id, graphRevision: current.revision,
      planRevision: b.ctx.contextify.get(b.parent).plan.revision }
    const before = compileContextify({ session: b.parent.session, turn: b.parent.session.seq + 1, step: 1 })
    await expect(b.ctx.contextify.recommend(b.parent, base, 'New topic: Independent planning task', 'fast', true))
      .rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_TOO_LARGE' })
    const local = await b.ctx.contextify.recommend(b.parent, base, 'New topic: Independent planning task', 'local', true)
    expect(local.route?.action).toBe('branch')
    expect(local.currentNodeIds).toEqual(local.proposedNodeIds)
    const events = b.parent.session.snapshotEvents()
    const seed = events.slice(0, events.findLastIndex(event => event.type === 'turn/end') + 1)
    const child = (await b.ctx.agents.create({ sessionId: SessionId('local-many-pins-child'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: b.parent.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    if (local.route === undefined) throw new Error('Local Branch proposal missing')
    await b.ctx.contextify.reviewRoute(b.parent, local.route, 'accept', child.id, undefined, true)
    expect(compileContextify({ session: child.session, turn: child.session.seq + 1, step: 1 }).messages).toEqual(before.messages)
    const childPage = await b.ctx.contextify.familyPage(child)
    const back = await b.ctx.contextify.recommend(child, { activeSessionId: child.id, graphRevision: childPage.revision,
      planRevision: b.ctx.contextify.get(child).plan.revision }, 'Return to the mainline', 'local', true)
    expect(back.route?.action).toBe('return')
    if (back.route === undefined) throw new Error('Local Return proposal missing')
    await b.ctx.contextify.reviewRoute(child, back.route, 'accept', b.parent.id, undefined, true)
    expect(b.ctx.contextify.get(b.parent).plan.revision).toBe(base.planRevision)
    expect(compileContextify({ session: b.parent.session, turn: b.parent.session.seq + 1, step: 1 })).toEqual(before)
    expect(b.adapter.requests).toEqual([])
  } finally { await b.close() }
})

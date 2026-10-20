import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'
import { CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings, type ContextRecommendationProposal } from '../src/types.ts'
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
function jev(body: { questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }> }) {
  return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
    if (q.type === 'noul') {
      const preserved = key.startsWith('n') && q.instructions.includes('"baseIncluded":true')
      return [key, { type: 'noul', noul: key === 'wholeTask' || preserved ? 1 : .05 }]
    }
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

// All model/credential/fetch responses below are engineering fixtures, not provider effects.
async function setupScope(id: string) {
  const b = await lineageHarness()
  append(b.parent.session, 'Parent brainstorming constraints.')
  const child = await fork(b, b.parent, id)
  append(child.session, 'Own writing task.')
  configure(b, JSON.stringify({ goal: 'Continue own writing', retention: 'task-owned', assignment: 'existing', sessionId: child.id }))
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => jev(requestBody(init)))
  return { b, child, fetcher }
}
async function applyScope(b: Fixture, child: Fixture['parent'], proposal: ContextRecommendationProposal, key?: string, declined: readonly string[] = [], origin: 'contextify-client' | null = 'contextify-client') {
  const nodes = (await b.ctx.contextify.familyPage(child)).records
  const mutations = proposal.selection.filter(item => !declined.includes(item.nodeId)).map((item) => {
    const node = nodes.find(n => n.id === item.nodeId)!
    const active = node.sessionIds.includes(child.id)
    return { node: node.owner, mode: item.action === 'include' ? active ? 'natural' as const : 'include' as const : 'exclude' as const }
  })
  await b.ctx.contextify.setNodeModes(child, { revision: proposal.base.planRevision }, mutations,
    proposal.base.graphRevision, origin ?? undefined, declined, key)
}
it('learns only an acknowledged complete changed scope while old Clients still apply it', async () => {
  for (const acknowledged of [false, true]) {
    const { b, child, fetcher } = await setupScope('scope-ack-' + String(acknowledged))
    try {
      const proposal = await review(b, child, 'Continue own writing with only this task.')
      expect(proposal.scopePolicy).toMatchObject({ mode: 'task-owned', assignment: 'existing', sessionId: child.id, sourceCount: 2 })
      await applyScope(b, child, proposal, acknowledged ? proposal.scopePolicy!.key : undefined)
      const event = child.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-reviewed')
      expect(event?.type === 'contextify/recommendation-reviewed' ? event.data.scopePolicy : undefined).toEqual(acknowledged ? proposal.scopePolicy : undefined)
      const compiled = JSON.stringify(compileContextify({ session: child.session, turn: child.session.seq + 1, step: 1 }).messages)
      expect(compiled).toContain('Own writing task.'); expect(compiled).not.toContain('Parent brainstorming constraints.')
      const next = await review(b, child, 'Continue the next writing section.')
      expect(next.personalization?.scopePolicyExamples?.length ?? 0).toBe(acknowledged ? 1 : 0)
      const goalRequests = child.session.snapshotEvents().filter(e => e.type === 'contextify/recommendation-request' && e.data.userText.includes('confirmedScopePolicies'))
      if (acknowledged) expect(JSON.stringify(goalRequests)).toContain('task-owned')
      else expect(goalRequests).toHaveLength(0)
    } finally { fetcher.mockRestore(); await b.close() }
  }
})

it('removes complete policy examples on Undo/reset and suppresses disabled, partial and wrong-key approvals', async () => {
  const { b, child, fetcher } = await setupScope('scope-history')
  try {
    const proposal = await review(b, child)
    await applyScope(b, child, proposal, proposal.scopePolicy!.key)
    expect((await review(b, child)).personalization?.scopePolicyExamples).toHaveLength(1)
    b.ctx.contextify.undo(child, { revision: b.ctx.contextify.get(child).plan.revision })
    expect((await review(b, child)).personalization?.scopePolicyExamples).toBeUndefined()
    b.ctx.contextify.redo(child, { revision: b.ctx.contextify.get(child).plan.revision })
    expect((await review(b, child)).personalization?.scopePolicyExamples).toHaveLength(1)
    await b.ctx.contextify.resetPolicy(child, 'contextify-client')
    expect((await review(b, child)).personalization?.scopePolicyExamples).toBeUndefined()
  } finally { fetcher.mockRestore(); await b.close() }
  for (const condition of ['wrong-key', 'partial', 'disabled', 'worker']) {
    const { b, child, fetcher } = await setupScope('scope-negative-' + condition)
    try {
      if (condition === 'disabled') {
        const settings = promptAccess(b).promptSettings()
        promptAccess(b).promptSettings = () => ({ ...settings, personalizationEnabled: false })
      }
      const proposal = await review(b, child)
      await applyScope(b, child, proposal, condition === 'wrong-key' ? 'invalid' : proposal.scopePolicy!.key,
        condition === 'partial' ? [proposal.selection[0]!.nodeId] : [], condition === 'worker' ? null : 'contextify-client')
      const events = child.session.snapshotEvents().filter(e => e.type === 'contextify/recommendation-reviewed')
      expect(events.every(e => e.type === 'contextify/recommendation-reviewed' && e.data.scopePolicy === undefined)).toBe(true)
    } finally { fetcher.mockRestore(); await b.close() }
  }
})

it('retains source descriptor identity only on complete carried Context, never route-only approval', async () => {
  for (const carry of [false, true]) {
    const { b, child, fetcher } = await setupScope('scope-carry-source-' + String(carry))
    try {
      const destination = await fork(b, b.parent, 'scope-carry-target-' + String(carry))
      append(destination.session, 'A separate task to resume.')
      configure(b, JSON.stringify({ goal: 'Resume separate task', retention: 'task-owned', assignment: 'existing', sessionId: destination.id }), false)
      const proposal = await review(b, child, 'Resume the separate task.')
      expect(proposal.scopePolicy).toMatchObject({ sessionId: destination.id, mode: 'task-owned' })
      expect(proposal.route).toMatchObject({ action: 'navigate', targetSessionId: destination.id })
      await b.ctx.contextify.reviewRoute(child, proposal.route!, 'accept', destination.id, 'contextify-client', carry, proposal.scopePolicy!.key)
      const reviews = destination.session.snapshotEvents().filter(e => e.type === 'contextify/recommendation-reviewed')
      if (carry) {
        expect(reviews.at(-1)?.type === 'contextify/recommendation-reviewed' ? reviews.at(-1)!.data : undefined).toMatchObject({ sourceBase: proposal.base, scopePolicy: proposal.scopePolicy })
        expect((await review(b, destination)).personalization?.scopePolicyExamples).toHaveLength(1)
      } else expect(reviews).toHaveLength(0)
    } finally { fetcher.mockRestore(); await b.close() }
  }
})

it('does not relabel a newly published pending review with a previous sheet acknowledgement', async () => {
  const { b, child, fetcher } = await setupScope('scope-pending-identity')
  try {
    const first = await review(b, child, 'First unsent writing request.')
    const second = await review(b, child, 'Second unsent writing request.')
    await applyScope(b, child, second, first.scopePolicy!.key)
    const event = child.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-reviewed')
    expect(event?.type === 'contextify/recommendation-reviewed' ? event.data.scopePolicy : undefined).toBeUndefined()
  } finally { fetcher.mockRestore(); await b.close() }
})

it('applies explicitly borrowed Jev sources without calling them a pure complete policy', async () => {
  const { b, child, fetcher } = await setupScope('scope-exception-source')
  try {
    const sibling = await fork(b, b.parent, 'scope-exception-sibling')
    append(sibling.session, 'EXCEPTION_ONLY_BORROWED_SOURCE')
    fetcher.mockImplementation(async (_url, init) => {
      const body = requestBody(init), wire = await jev(body).json() as { answers: Record<string, unknown> }
      for (const [key, q] of Object.entries(body.questions)) {
        if (key.startsWith('n') && q.instructions.includes('EXCEPTION_ONLY_BORROWED_SOURCE')) wire.answers[key] = { type: 'noul', noul: 1 }
      }
      return Response.json(wire)
    })
    const proposal = await review(b, child)
    expect(proposal.scopePolicy).toBeUndefined()
    await applyScope(b, child, proposal, 'non-authoritative-key')
    const compiled = JSON.stringify(compileContextify({ session: child.session, turn: child.session.seq + 1, step: 1 }).messages)
    expect(compiled).toContain('EXCEPTION_ONLY_BORROWED_SOURCE')
    expect((await review(b, child)).personalization?.scopePolicyExamples).toBeUndefined()
  } finally { fetcher.mockRestore(); await b.close() }
})

it('keeps complete scopes beyond the scoring slate and never learns no-op, cancelled or stale approvals', async () => {
  const { b, child, fetcher } = await setupScope('scope-beyond-slate')
  try {
    for (let i = 0; i < 18; i++) append(child.session, `Owned historical source ${i}`)
    const proposal = await review(b, child)
    expect(proposal.scopePolicy?.sourceCount).toBe(38)
    await applyScope(b, child, proposal, proposal.scopePolicy!.key)
    expect(b.ctx.contextify.get(child).selectedCount).toBe(38)
    const unchanged = await review(b, child)
    expect(unchanged.selection).toEqual([])
    await applyScope(b, child, unchanged, unchanged.scopePolicy!.key)
    const last = child.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-reviewed')
    expect(last?.type === 'contextify/recommendation-reviewed' ? last.data.scopePolicy : undefined).toBeUndefined()
    expect((await review(b, child)).personalization?.scopePolicyExamples).toHaveLength(1)
  } finally { fetcher.mockRestore(); await b.close() }
  for (const cause of ['dismissed', 'stale', 'replacement']) {
    const { b, child, fetcher } = await setupScope('scope-unavailable-' + cause)
    try {
      const proposal = await review(b, child)
      if (cause === 'dismissed') await b.ctx.contextify.dismissRecommendation(child, proposal)
      else {
        const nodes = (await b.ctx.contextify.familyPage(child)).records
        const node = nodes.find(n => n.owner.sessionId === (cause === 'replacement' ? child.id : b.parent.id))!
        if (cause === 'replacement') await b.ctx.contextify.archiveNode(child, { revision: proposal.base.planRevision }, node.owner, 'Engineering replacement')
        else await b.ctx.contextify.setNodeMode(child, { revision: proposal.base.planRevision }, node.owner, 'exclude')
      }
      await expect(applyScope(b, child, proposal, proposal.scopePolicy!.key)).rejects.toBeInstanceOf(Error)
      expect(child.session.snapshotEvents().some(e => e.type === 'contextify/recommendation-reviewed' && e.data.scopePolicy !== undefined)).toBe(false)
    } finally { fetcher.mockRestore(); await b.close() }
  }
})


it('restores the same confirmed policy from JSONL after cold resume and preserves its reset across another resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scope-policy-cold-resume-'))
  const opened: Fixture[] = []
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => jev(requestBody(init)))
  const childId = SessionId('scope-policy-durable-child')
  try {
    const first = await lineageHarness(false, { root })
    opened.push(first)
    append(first.parent.session, 'PERSISTED_PARENT_ONLY')
    const child = await fork(first, first.parent, childId)
    append(child.session, 'PERSISTED_CHILD_ONLY')
    configure(first, JSON.stringify({ goal: 'Continue writing', retention: 'task-owned', assignment: 'existing', sessionId: childId }))
    const proposal = await review(first, child, 'Keep only the writing task.')
    await applyScope(first, child, proposal, proposal.scopePolicy!.key)
    const approved = child.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-reviewed')!
    const beforeExamples = (await review(first, child)).personalization?.scopePolicyExamples
    expect(beforeExamples).toEqual([expect.objectContaining({ sourceSessionId: childId, sourceEventSeq: approved.seq,
      mode: 'task-owned', objective: 'Keep only the writing task.' })])
    const beforeScope = compileContextify({ session: child.session, turn: child.session.seq + 1, step: 1 }).messages
    await first.ctx.sessions.flush(child.session)
    await first.ctx.sessions.flush(first.parent.session)
    await first.close()
    opened.pop()

    const second = await lineageHarness(false, { root, resumeParent: true })
    opened.push(second)
    expect(second.ctx).not.toBe(first.ctx)
    const resumed = (await second.ctx.agents.resume({ resumeSessionId: childId })).agent
    configure(second, JSON.stringify({ goal: 'Continue writing', retention: 'task-owned', assignment: 'existing', sessionId: childId }))
    const body = () => JSON.stringify(compileContextify({ session: resumed.session, turn: resumed.session.seq + 1, step: 1 }).messages)
    expect(JSON.parse(body())).toEqual(beforeScope)
    expect(body()).toContain('PERSISTED_CHILD_ONLY')
    expect(body()).not.toContain('PERSISTED_PARENT_ONLY')
    expect((await review(second, resumed)).personalization?.scopePolicyExamples).toEqual(beforeExamples)
    const request = resumed.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-request'
      && e.data.userText.includes('confirmedScopePolicies'))
    expect(request?.type === 'contextify/recommendation-request' && request.data.userText).toContain('task-owned')
    second.ctx.contextify.undo(resumed, { revision: second.ctx.contextify.get(resumed).plan.revision })
    expect((await review(second, resumed)).personalization?.scopePolicyExamples).toBeUndefined()
    second.ctx.contextify.redo(resumed, { revision: second.ctx.contextify.get(resumed).plan.revision })
    expect((await review(second, resumed)).personalization?.scopePolicyExamples).toEqual(beforeExamples)
    await second.ctx.contextify.resetPolicy(resumed, 'contextify-client')
    await second.ctx.sessions.flush(resumed.session)
    await second.close()
    opened.pop()

    const third = await lineageHarness(false, { root, resumeParent: true })
    opened.push(third)
    const afterReset = (await third.ctx.agents.resume({ resumeSessionId: childId })).agent
    configure(third, JSON.stringify({ goal: 'Continue writing', retention: 'task-owned', assignment: 'existing', sessionId: childId }))
    expect((await review(third, afterReset)).personalization?.scopePolicyExamples).toBeUndefined()
  } finally {
    fetcher.mockRestore()
    try { for (const b of opened.reverse()) await b.close() }
    finally { await rm(root, { recursive: true, force: true }) }
  }
})

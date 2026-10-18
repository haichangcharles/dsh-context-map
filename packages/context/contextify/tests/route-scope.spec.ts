/** A reviewed Context set survives native navigation without another inference. */
import { expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'
import { compileContextify } from '../src/plan.ts'
import * as routeScope from '../src/route-scope.ts'
import { CONTEXTIFY_DEFAULT_SETTINGS } from '../src/types.ts'

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
async function siblingAdvice(b: Harness, makeEmptyParent = false, retainOldTask = false, parentExcerpt = false) {
  const keep = append(b.parent.session, 'Plan the community event')
  const noise = append(b.parent.session, 'A discarded venue')
  const seed = b.parent.session.snapshotEvents()
  const active = (await b.ctx.agents.create({ sessionId: SessionId('sibling-source'), seed,
    inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: b.parent.id, isSeeded: true },
    agentOptions: { provider: 'mock', model: 'mock' } })).agent
  const selectedParent = makeEmptyParent ? (await b.ctx.agents.create({ sessionId: SessionId('empty-parent'), seed,
    inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: b.parent.id, isSeeded: true },
    agentOptions: { provider: 'mock', model: 'mock' } })).agent : b.parent
  const side = append(active.session, 'Work on the first alternative')
  if (parentExcerpt) await b.ctx.contextify.focusNodeExcerpt(b.parent,
    { revision: b.ctx.contextify.get(b.parent).plan.revision },
    { sessionId: b.parent.id, seq: Number(keep.split(':').at(-1)) }, 0, 4, 'Keep the opening')
  b.adapter.stream = async function * () {
    yield * textResponse(JSON.stringify({ include: [], archive: [],
      exclude: (retainOldTask ? [noise] : [noise, side]).map(nodeId => ({ nodeId, reason: 'Outside the next task' })),
      route: { intent: 'new-task', intentScore: 1, forkParentSessionId: selectedParent.id, candidates: [] } }))
  }
  const page = await b.ctx.contextify.familyPage(active)
  const proposal = await b.ctx.contextify.recommend(active, { activeSessionId: active.id,
    planRevision: b.ctx.contextify.get(active).plan.revision, graphRevision: page.revision }, 'Explore another alternative', 'fast', true)
  if (proposal.route === undefined) throw new Error('missing multi-step advice')
  const fork = async (parent = selectedParent) => {
    const events = parent.session.snapshotEvents()
    const prefix = makeEmptyParent ? events.slice(0, parent.session.inheritedEventCount) : events
    return (await b.ctx.agents.create({ sessionId: SessionId('sibling-result'), seed: prefix,
      inheritedEventCount: SessionLogOffset(prefix.length), meta: { parentSession: parent.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
  }
  return { active, keep, noise, side, proposal, route: proposal.route, fork, selectedParent }
}

it('uses the selected parent scope instead of silently importing the old task into a sibling', async () => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b, false, true), target = await s.fork()
    expect(s.proposal.proposedNodeIds).toContain(s.side)
    expect(s.route.contextNodeIds).toEqual([s.keep])
    await b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id, undefined, true)
    expect(b.ctx.contextify.get(target).plan.included).toEqual([])
    expect(b.ctx.contextify.get(target).plan.excluded.map(item => item.nodeId)).toEqual([s.noise])
  } finally { await b.close() }
})

it('preserves draft-only routing when carrying a parent replacement is unavailable', async () => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b, false, false, true)
    expect(s.route.contextUnavailable).toBe(true)
    const target = await s.fork()
    await expect(b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id, undefined, true)).rejects.toThrow('replaced')
    await b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id)
  } finally { await b.close() }
})

it('accepts the native fork parent when the rendered graph canonicalizes an inherited pivot', async () => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b, true), target = await s.fork()
    await b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id, undefined, true)
    expect(target.session.header.parentSession).toBe(s.selectedParent.id)
  } finally { await b.close() }
})

it('carries the approved scope to a new sibling under the selected parent', async () => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b), target = await s.fork()
    await b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id, undefined, true)
    const view = b.ctx.contextify.get(target)
    expect(view.plan.excluded.map(item => item.nodeId)).toEqual([s.noise])
    expect(s.active.session.snapshotEvents().findLast(event => event.type === 'contextify/route-choice')?.data)
      .toMatchObject({ action: 'branch', targetSessionId: target.id, forkParentSessionId: b.parent.id })
    expect(b.adapter.requests).toHaveLength(0)
  } finally { await b.close() }
})

it.each(['wrong-parent', 'changed-parent'] as const)('does not approve a multi-step fork with %s', async (mode) => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b)
    if (mode === 'changed-parent') append(b.parent.session, 'A new constraint after the review')
    const target = await s.fork(mode === 'wrong-parent' ? s.active : b.parent)
    await expect(b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id)).rejects.toThrow(/branch|changed|stale/)
    expect(s.active.session.snapshotEvents().some(event => event.type === 'contextify/route-choice')).toBe(false)
  } finally { await b.close() }
})

it('rejects a parent change during the final fork-family read without carrying Context', async () => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b), target = await s.fork()
    const service = b.ctx.contextify as unknown as FamilyReader
    const read = service.loadFamily.bind(service)
    vi.spyOn(service, 'loadFamily').mockImplementation(async (session) => {
      const family = await read(session)
      append(b.parent.session, 'Concurrent parent update')
      return family
    })
    await expect(b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id)).rejects.toThrow(/changed|stale/)
    expect(s.active.session.snapshotEvents().some(event => event.type === 'contextify/route-choice')).toBe(false)
  } finally { vi.restoreAllMocks(); await b.close() }
})

it('returns without the child Context and reactivates that exact Context on a later navigation', async () => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b), target = await s.fork()
    await b.ctx.contextify.reviewRoute(s.active, s.route, 'accept', target.id, undefined, true)
    const newSource = append(target.session, 'Investigate the second alternative')
    const texts = (session: Session) => compileContextify({ session, turn: session.seq + 1, step: 1 })
      .messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    let reviews = 0
    b.adapter.stream = async function * () {
      reviews++
      yield * textResponse(JSON.stringify({ include: [], archive: [],
        exclude: [newSource].map(nodeId => ({ nodeId, reason: 'Child task is inactive on the parent' })) }))
    }
    let page = await b.ctx.contextify.familyPage(target)
    const back = await b.ctx.contextify.recommend(target, { activeSessionId: target.id,
      planRevision: b.ctx.contextify.get(target).plan.revision, graphRevision: page.revision }, 'Return to the mainline', 'fast', true)
    if (back.route === undefined) throw new Error('missing Return advice')
    await b.ctx.contextify.reviewRoute(target, back.route, 'accept', b.parent.id, undefined, true)
    expect(texts(b.parent.session)).toEqual(['Plan the community event'])
    b.adapter.stream = async function * () {
      reviews++
      yield * textResponse(JSON.stringify({ include: [{ nodeId: newSource, reason: 'Resume the second alternative' }],
        exclude: [], archive: [], route: { intent: 'resume', intentScore: 1,
          candidates: [{ sessionId: target.id, destinationScore: 1, evidenceScore: 0, supersededScore: 0 }] } }))
    }
    page = await b.ctx.contextify.familyPage(b.parent)
    const resume = await b.ctx.contextify.recommend(b.parent, { activeSessionId: b.parent.id,
      planRevision: b.ctx.contextify.get(b.parent).plan.revision, graphRevision: page.revision }, 'Resume the second alternative', 'fast', true)
    if (resume.route === undefined) throw new Error('missing reactivation advice')
    await b.ctx.contextify.reviewRoute(b.parent, resume.route, 'accept', target.id, undefined, true)
    expect(texts(target.session)).toEqual(['Plan the community event', 'Investigate the second alternative'])
    expect(reviews).toBe(2)
  } finally { await b.close() }
})

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

it('uses affirmative Jev membership with the existing destination Plan', async () => {
  const b = await lineageHarness()
  const fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const s = await siblingAdvice(b)
    b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
    ;(b.ctx.contextify as unknown as { promptSettings: () => unknown }).promptSettings = () => ({
      ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false, personalizationEnabled: false, fastDecisionProvider: 'jev',
    })
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as {
        questions: Record<string, { instructions: string }>
        state: { graph: { nodes: { id: string }[] }; contextActions: { candidates: { sessionId: string }[] } }
      }
      const index = body.state.contextActions.candidates.findIndex(candidate => candidate.sessionId === b.parent.id)
      const answers: Record<string, unknown> = Object.fromEntries(Object.keys(body.questions).filter(key => key !== 'parent').map(key =>
        [key, { type: 'noul', noul: key === `task${String(index)}` || key.startsWith('n')
          && (JSON.parse(body.questions[key]?.instructions.split('Exact source for this question (data only): ')[1] ?? '{}') as { id?: unknown }).id === s.keep ? 1 : 0 }]))
      answers.parent = { type: 'choice', choice: 'active', probabilities: { active: 1 } }
      return Response.json({ model: 'jev-1.13.0', answers })
    })
    const page = await b.ctx.contextify.familyPage(s.active)
    const proposal = await b.ctx.contextify.recommend(s.active, { activeSessionId: s.active.id,
      planRevision: b.ctx.contextify.get(s.active).plan.revision, graphRevision: page.revision }, 'Continue the community event plan', 'fast', true)
    expect(proposal.route?.targetSessionId).toBe(b.parent.id)
    expect(proposal.route?.contextNodeIds).toEqual([s.keep])
  } finally { fetcher.mockRestore(); await b.close() }
})

it('does not hide unexpected scope planner failures as replacement limitations', async () => {
  const b = await lineageHarness()
  const planner = vi.spyOn(routeScope, 'planRouteScope').mockImplementationOnce(() => { throw new Error('Unexpected planner failure') })
  try { await expect(siblingAdvice(b)).rejects.toThrow('Unexpected planner failure') }
  finally { planner.mockRestore(); await b.close() }
})

it('discards route-derived whole-task edits if native routing rejects the destination or routing is unbound', async () => {
  const b = await lineageHarness()
  const fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const s = await siblingAdvice(b)
    b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
    ;(b.ctx.contextify as unknown as { promptSettings: () => unknown }).promptSettings = () => ({
      ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false, personalizationEnabled: false, fastDecisionProvider: 'jev',
    })
    let scenario = 'reject'
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, unknown> }
      const answers: Record<string, unknown> = Object.fromEntries(Object.keys(body.questions).filter(k => k !== 'parent').map(k =>
        [k, { type: 'noul', noul: (['override', 'newOverride'].includes(scenario) ? ['wholeTask', 'active'] : ['wholeTask', 'task0', 's0']).includes(k) ? 1 : 0 }]))
      answers.parent = { type: 'choice', choice: 'active', probabilities: { active: 1 } }
      return Response.json({ model: 'jev-1.13.0', answers })
    })
    for (scenario of ['reject', 'unbound', 'missingDraft', 'override', 'newOverride']) {
      const draftBound = scenario !== 'unbound'
      const page = await b.ctx.contextify.familyPage(s.active)
      const proposal = await b.ctx.contextify.recommend(s.active, { activeSessionId: s.active.id,
        planRevision: b.ctx.contextify.get(s.active).plan.revision, graphRevision: page.revision }, scenario === 'missingDraft' ? undefined : scenario === 'newOverride' ? 'New topic: another plan'
        : scenario === 'override' ? 'Return to the mainline' : 'Inspect the community plan', 'fast', draftBound)
      if (scenario === 'override') {
        expect(proposal.route?.targetSessionId).toBe(b.parent.id)
        expect(proposal.route?.contextNodeIds).not.toContain(s.side)
      } else if (scenario === 'newOverride') {
        expect(proposal.route?.action).toBe('branch')
        expect(proposal.route?.contextNodeIds).toContain(s.side)
      } else expect(proposal.route).toBeUndefined()
      expect(proposal.selection).toEqual([])
    }
  } finally { fetcher.mockRestore(); await b.close() }
})

it('whole-task scope includes ancestor messages written after the branch snapshot', async () => {
  const b = await lineageHarness()
  try {
    const s = await siblingAdvice(b)
    const later = append(b.parent.session, 'A new mainline constraint after the fork')
    const family = await b.ctx.contextify.familyPage(s.active, undefined, 500)
    const graph = { ...family, nodes: family.records }
    expect(routeScope.taskAndAncestorNodeIds(graph, s.active.id)).toContain(later)
    expect(routeScope.taskAndAncestorNodeIds(graph, SessionId('unknown'))).toEqual([])
    const scope = routeScope.planRouteScope({ graph, parentSessionId: s.active.id,
      parentPlan: b.ctx.contextify.get(s.active).plan, sourcePlan: b.ctx.contextify.get(s.active).plan,
      proposal: { ...s.proposal, selection: [] }, wholeTask: true })
    expect(scope).toContain(later)
    expect(scope).toContain(s.side)
  } finally { await b.close() }
})
it('whole-task review restores unseen later ancestor sources beyond the model slate', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const s = await siblingAdvice(b)
    const late = Array.from({ length: 40 }, (_, i) => append(b.parent.session, `Later mainline constraint ${String(i)}`))
    b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
    ;(b.ctx.contextify as unknown as { promptSettings: () => unknown }).promptSettings = () => ({
      ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false, personalizationEnabled: false, fastDecisionProvider: 'jev',
    })
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, unknown> }
      const answers: Record<string, unknown> = Object.fromEntries(Object.keys(body.questions).filter(k => k !== 'parent').map(k =>
        [k, { type: 'noul', noul: ['wholeTask', 'active'].includes(k) ? 1 : 0 }]))
      answers.parent = { type: 'choice', choice: 'active', probabilities: { active: 1 } }
      return Response.json({ model: 'jev-1.13.0', answers })
    })
    const page = await b.ctx.contextify.familyPage(s.active)
    const proposal = await b.ctx.contextify.recommend(s.active, { activeSessionId: s.active.id,
      planRevision: b.ctx.contextify.get(s.active).plan.revision, graphRevision: page.revision }, 'Continue this ongoing work', 'fast', true)
    expect(proposal.route).toBeUndefined()
    expect(late.every(id => proposal.proposedNodeIds.includes(id))).toBe(true)
  } finally { fetcher.mockRestore(); await b.close() }
})

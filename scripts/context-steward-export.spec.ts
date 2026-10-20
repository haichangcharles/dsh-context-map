/** Existing native export preserves reversible management; every model response is an engineering fixture. */
import { expect, it, vi } from 'vitest'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { lineageHarness } from '../packages/context/contextify/tests/lineage-coverage-harness.ts'
import { textResponse } from '../packages/core/agent-loop/tests/mock-adapter.ts'
import { CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings } from '../packages/context/contextify/src/types.ts'
import { compileContextify, currentContextPlan } from '../packages/context/contextify/src/plan.ts'
import { scopePolicyExamplesFromInspections } from '../packages/context/contextify/src/scope-policy.ts'
import { contextPolicyWatermarks } from '../packages/context/contextify/src/policy-memory.ts'
import { readSessionLogText } from '../packages/session-query/session-log-export/src/archive.ts'
import { scanLog, toHeaderLine, eventLines } from '../packages/session/session-persistence-jsonl/src/format.ts'

function append(session: Session, text: string) {
  const turn = session.seq + 1
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'Fixture response.' }],
  }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function installJevFixture() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    if (typeof init?.body !== 'string') throw new Error('Expected fixture request body')
    const body = JSON.parse(init.body) as { questions: Record<string, {
      type: string
      instructions: string
      criteria?: Record<string, string>
    }> }
    return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
      if (q.type === 'noul') return [key, { type: 'noul', noul: key === 'wholeTask'
        || key.startsWith('n') && q.instructions.includes('"baseIncluded":true') ? 1 : .05 }]
      const choice = q.criteria?.p0 === undefined ? 'active' : 'p0'
      return [key, { type: 'choice', choice, probabilities: { [choice]: 1 } }]
    })) as Record<string, unknown> })
  })
}

it('restores selected native logs with original approval references and reversible policy eligibility', async () => {
  const b = await lineageHarness()
  let restoreFetch = () => {}
  try {
    append(b.parent.session, 'PARENT_BRAINSTORMING_ONLY')
    const seed = b.parent.session.snapshotEvents()
    const child = (await b.ctx.agents.create({ sessionId: SessionId('export-writing'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: b.parent.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    await b.ctx.contextify.recordManualBranch(b.parent, child.id, 'contextify-client', 'Write the first draft.')
    append(child.session, 'CHILD_WRITING_ONLY')
    const access = b.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    access.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, fastDecisionProvider: 'goal-model-jev' })
    b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
    b.adapter.stream = async function* (options) {
      b.adapter.requests.push(options)
      yield* textResponse(JSON.stringify({ goal: 'Continue writing', retention: 'task-owned',
        assignment: 'existing', sessionId: child.id }))
    }
    const fetcher = installJevFixture()
    restoreFetch = () => { fetcher.mockRestore() }
    const page = await b.ctx.contextify.familyPage(child)
    const proposal = await b.ctx.contextify.recommend(child, { activeSessionId: child.id,
      graphRevision: page.revision, planRevision: b.ctx.contextify.get(child).plan.revision },
    'Keep only this writing task.', 'fast', true)
    expect(proposal.scopePolicy?.mode).toBe('task-owned')
    await b.ctx.contextify.presentRecommendation(child, proposal, 'contextify-client')
    const nodes = (await b.ctx.contextify.familyPage(child)).records
    await b.ctx.contextify.setNodeModes(child, { revision: proposal.base.planRevision }, proposal.selection.map(item => ({
      node: nodes.find(node => node.id === item.nodeId)!.owner,
      mode: item.action === 'exclude' ? 'exclude' : 'include',
    })), proposal.base.graphRevision, 'contextify-client', [], proposal.scopePolicy!.key)
    const approved = child.session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-reviewed')!
    expect(approved.type === 'contextify/recommendation-reviewed' && approved.data.scopePolicy).toEqual(proposal.scopePolicy)
    await b.ctx.contextify.recordManualRoute(child, b.parent.id, 'fixture-return',
      (await b.ctx.contextify.familyPage(child)).revision, 'contextify-client', 'Return to the main plan.')
    await b.ctx.contextify.recordManualRoute(b.parent, child.id, 'fixture-reactivate',
      (await b.ctx.contextify.familyPage(b.parent)).revision, 'contextify-client', 'Resume writing.')

    let frozenInput: string | undefined
    let frozenOutcome: string | undefined
    const exported = async (expectedExamples: number) => {
      const sessions = [b.parent.session, child.session]
      const observations = []
      for (const session of sessions) {
        await b.ctx.sessions.flush(session)
        const before = session.snapshotEvents()
        const raw = await readSessionLogText(b.ctx.sessionPersistence, session.id)
        expect(raw).toBeDefined()
        const decoded = scanLog(Buffer.from(raw!))
        expect(decoded.events).toEqual(before)
        expect(decoded.meta).toEqual({ ...session.header, delegationDepth: session.header.delegationDepth ?? 0 })
        expect(decoded.inheritedEventCount).toBe(session.inheritedEventCount)
        expect(session.snapshotEvents()).toEqual(before)
        const restored = Session.fromRestore(session.id, decoded.events, decoded.meta, decoded.inheritedEventCount, 'detached')
        expect(compileContextify({ session: restored, turn: restored.seq + 1, step: 1 }).messages)
          .toEqual(compileContextify({ session, turn: session.seq + 1, step: 1 }).messages)
        observations.push({ meta: decoded.meta, events: decoded.events, inheritedEventCount: decoded.inheritedEventCount })
      }
      const own = observations[1]!.events.slice(observations[1]!.inheritedEventCount)
      expect(own.find(event => event.seq === approved.seq)).toEqual(approved)
      const presentations = own.filter(event => event.type === 'contextify/recommendation-presented')
      expect(presentations).toHaveLength(1)
      const presentation = presentations[0]!
      const requests = own.filter(event => event.type === 'contextify/recommendation-request')
        .filter(event => event.seq < presentation.seq)
      const goals = requests.filter(event => event.data.provider === 'mock')
      const jevs = requests.filter(event => event.data.provider === 'typesafe')
      expect(goals).toHaveLength(1)
      expect(jevs).toHaveLength(1)
      expect(requests).toHaveLength(2)
      const goal = goals[0]!, jev = jevs[0]!
      const traceId = goal.data.recommendationTraceId
      expect(traceId).toEqual(expect.any(String))
      expect(jev.data.recommendationTraceId).toBe(traceId)
      expect(presentation.data.recommendationTraceId).toBe(traceId)
      expect(approved.type === 'contextify/recommendation-reviewed' ? approved.data.recommendationTraceId : undefined).toBe(traceId)
      expect(goal.seq).toBeLessThan(jev.seq)
      expect(jev.seq).toBeLessThan(presentation.seq)
      expect(presentation.seq).toBeLessThan(approved.seq)
      for (const request of requests) {
        expect(request.data.base).toEqual(presentation.data.base)
        expect(request.data.objective).toBe('Keep only this writing task.')
      }
      expect(approved.type === 'contextify/recommendation-reviewed' && approved.data.base).toEqual(presentation.data.base)
      const source = observations[1]!
      const inputPrefix = source.events.slice(0, goal.seq)
      expect(inputPrefix.every(event => event.seq < goal.seq)).toBe(true)
      const before = Session.fromRestore(source.meta.id, inputPrefix, source.meta,
        SessionLogOffset(source.inheritedEventCount), 'detached')
      expect(currentContextPlan(before).revision).toBe(goal.data.base.planRevision)
      const beforeMessages = compileContextify({ session: before, turn: before.seq + 1, step: 1 }).messages
      expect(JSON.stringify(beforeMessages)).toContain('PARENT_BRAINSTORMING_ONLY')
      expect(JSON.stringify(beforeMessages)).toContain('CHILD_WRITING_ONLY')
      const input = JSON.stringify({ nativePrefix: inputPrefix, stages: requests.map(request => ({
        sessionId: source.meta.id, seq: request.seq, request: request.data,
      })) })
      if (frozenInput === undefined) frozenInput = input
      expect(input).toBe(frozenInput)
      const after = Session.fromRestore(source.meta.id, source.events.slice(0, approved.seq + 1), source.meta,
        SessionLogOffset(source.inheritedEventCount), 'detached')
      const afterMessages = compileContextify({ session: after, turn: after.seq + 1, step: 1 }).messages
      expect(JSON.stringify(afterMessages)).not.toContain('PARENT_BRAINSTORMING_ONLY')
      expect(JSON.stringify(afterMessages)).toContain('CHILD_WRITING_ONLY')
      const outcome = JSON.stringify({ sessionId: source.meta.id, seq: approved.seq, approval: approved.data, afterMessages })
      if (frozenOutcome === undefined) frozenOutcome = outcome
      expect(outcome).toBe(frozenOutcome)
      const types = own.map(event => event.type)
      expect(types.indexOf('contextify/recommendation-request')).toBeLessThan(types.indexOf('contextify/recommendation-presented'))
      expect(types.indexOf('contextify/recommendation-presented')).toBeLessThan(types.indexOf('contextify/recommendation-reviewed'))
      expect(own.find(event => event.type === 'contextify/manual-route')?.data).toMatchObject({ action: 'return', targetSessionId: b.parent.id })
      expect(observations[0]!.events.find(event => event.type === 'contextify/manual-route')?.data)
        .toMatchObject({ action: 'navigate', targetSessionId: child.id })
      const examples = scopePolicyExamplesFromInspections(observations, contextPolicyWatermarks(observations))
      expect(examples).toHaveLength(expectedExamples)
      if (expectedExamples > 0) expect(examples[0]).toMatchObject({ sourceSessionId: child.id, sourceEventSeq: approved.seq })
      expect((await b.ctx.contextify.stewardProfile(child)).scopePolicyExamples).toEqual(examples)
      return observations
    }
    const original = await exported(1)
    const contradictory = original.map((inspection) => {
      const events = inspection.events.map(event => event.type === 'contextify/plan'
        && event.data.revision === proposal.base.planRevision + 1
        ? { ...event, data: { ...event.data, excluded: [] } } : event)
      const raw = `${JSON.stringify(toHeaderLine(inspection.meta, inspection.inheritedEventCount))}\n${eventLines(events)}\n`
      const decoded = scanLog(Buffer.from(raw))
      const restored = Session.fromRestore(decoded.meta.id, decoded.events, decoded.meta,
        SessionLogOffset(decoded.inheritedEventCount), 'detached')
      if (restored.id === child.id) {
        expect(JSON.stringify(compileContextify({ session: restored, turn: restored.seq + 1, step: 1 }).messages))
          .toContain('PARENT_BRAINSTORMING_ONLY')
      }
      return { meta: restored.header, events: restored.snapshotEvents(), inheritedEventCount: restored.inheritedEventCount }
    })
    // Counterfactual imported bytes, not a claim that Host generated this contradiction.
    expect(scopePolicyExamplesFromInspections(contradictory, contextPolicyWatermarks(contradictory))).toEqual([])
    b.ctx.contextify.undo(child, { revision: b.ctx.contextify.get(child).plan.revision })
    await exported(0)
    b.ctx.contextify.redo(child, { revision: b.ctx.contextify.get(child).plan.revision })
    await exported(1)
    await b.ctx.contextify.resetPolicy(child, 'contextify-client')
    const final = await exported(0)
    expect(final.flatMap(item => item.events).some(event => event.type === 'contextify/policy-reset')).toBe(true)
    expect(b.adapter.requests).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally {
    restoreFetch()
    await b.close()
  }
})


it('keeps repeated request prefixes separate from unresolved attempts and cross-Session Carry outcomes', async () => {
  const b = await lineageHarness()
  let restoreFetch = () => {}
  try {
    append(b.parent.session, 'TRACE_PARENT_ONLY')
    const fork = async (id: string) => {
      const seed = b.parent.session.snapshotEvents()
      return (await b.ctx.agents.create({ sessionId: SessionId(id), seed,
        inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: b.parent.id, isSeeded: true },
        agentOptions: { provider: 'mock', model: 'mock' } })).agent
    }
    const source = await fork('trace-source'), destination = await fork('trace-destination')
    append(source.session, 'TRACE_SOURCE_ONLY')
    append(destination.session, 'TRACE_DESTINATION_ONLY')
    const access = b.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    access.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, fastDecisionProvider: 'goal-model-jev' })
    b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
    const stream = async function* (options: Parameters<typeof b.adapter.stream>[0]) {
      b.adapter.requests.push(options)
      yield* textResponse(JSON.stringify({ goal: 'Resume destination', retention: 'task-owned',
        assignment: 'existing', sessionId: destination.id }))
    }
    b.adapter.stream = stream
    const fetcher = installJevFixture()
    restoreFetch = () => { fetcher.mockRestore() }
    const recommend = async () => {
      const page = await b.ctx.contextify.familyPage(source)
      return b.ctx.contextify.recommend(source, { activeSessionId: source.id, graphRevision: page.revision,
        planRevision: b.ctx.contextify.get(source).plan.revision }, 'Resume the other task.', 'fast', true)
    }
    const dismissed = await recommend()
    await b.ctx.contextify.presentRecommendation(source, dismissed, 'contextify-client')
    await b.ctx.contextify.dismissRecommendation(source, dismissed, 'contextify-client')
    b.adapter.stream = async function* (options) {
      b.adapter.requests.push(options)
      await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield* textResponse('{}')
    }
    const pending = recommend()
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' })
    await vi.waitFor(() => { expect(b.adapter.requests).toHaveLength(2) })
    b.ctx.contextify.cancelRecommendation(source)
    await cancelled
    b.adapter.stream = stream
    const carried = await recommend()
    expect(carried.base).toEqual(dismissed.base)
    expect(carried.route).toMatchObject({ action: 'navigate', targetSessionId: destination.id })
    await b.ctx.contextify.presentRecommendation(source, carried, 'contextify-client')
    await b.ctx.contextify.reviewRoute(source, carried.route!, 'accept', destination.id,
      'contextify-client', true, carried.scopePolicy!.key)
    const read = async (session: Session) => {
      await b.ctx.sessions.flush(session)
      const raw = await readSessionLogText(b.ctx.sessionPersistence, session.id)
      expect(raw).toBeDefined()
      const decoded = scanLog(Buffer.from(raw!))
      expect(decoded.events).toEqual(session.snapshotEvents())
      return decoded
    }
    const from = await read(source.session), to = await read(destination.session)
    const own = from.events.slice(from.inheritedEventCount)
    const requests = own.filter(event => event.type === 'contextify/recommendation-request')
    expect(requests).toHaveLength(5)
    const ids = [...new Set(requests.map(event => event.data.recommendationTraceId))]
    expect(ids).toHaveLength(3)
    expect(ids.every(id => typeof id === 'string')).toBe(true)
    const groups = ids.map(id => ({
      requests: requests.filter(event => event.data.recommendationTraceId === id),
      presented: own.filter(event => event.type === 'contextify/recommendation-presented')
        .filter(event => event.data.recommendationTraceId === id),
      dismissed: own.filter(event => event.type === 'contextify/recommendation-dismissed')
        .filter(event => event.data.recommendationTraceId === id),
      routes: own.filter(event => event.type === 'contextify/route-choice')
        .filter(event => event.data.recommendationTraceId === id),
    }))
    expect(groups.map(group => [group.requests.length, group.presented.length, group.dismissed.length, group.routes.length]))
      .toEqual([[2, 1, 1, 0], [1, 0, 0, 0], [2, 1, 0, 1]])
    // No native closure certifies why the middle attempt ended; cancellation is known only to this driver.
    expect(own.filter(event => event.type === 'contextify/recommendation-reviewed')).toEqual([])
    const carrying = groups[2]!, first = carrying.requests[0]!, second = carrying.requests[1]!
    expect(first.seq).toBeLessThan(second.seq)
    expect(second.seq).toBeLessThan(carrying.presented[0]!.seq)
    expect(carrying.presented[0]!.seq).toBeLessThan(carrying.routes[0]!.seq)
    expect(carrying.routes[0]!.data).toMatchObject({ choice: 'accept', targetSessionId: destination.id })
    expect(first.data.base).toEqual(dismissed.base)
    expect(second.data.base).toEqual(first.data.base)
    expect(first.data.objective).toBe('Resume the other task.')
    expect(second.data.objective).toBe(first.data.objective)
    const inputPrefix = from.events.slice(0, first.seq)
    expect(inputPrefix.every(event => event.seq < first.seq)).toBe(true)
    expect(inputPrefix.some(event => event.type === 'contextify/recommendation-dismissed'
      && event.data.recommendationTraceId === ids[0])).toBe(true)
    expect(inputPrefix.some(event => 'recommendationTraceId' in event.data
      && event.data.recommendationTraceId === ids[2])).toBe(false)
    const input = Session.fromRestore(source.id, inputPrefix, from.meta, from.inheritedEventCount, 'detached')
    expect(currentContextPlan(input).revision).toBe(first.data.base.planRevision)
    const compile = (session: Session) => compileContextify({ session, turn: session.seq + 1, step: 1 }).messages
    const beforeMessages = compile(input)
    expect(JSON.stringify(beforeMessages)).toContain('TRACE_PARENT_ONLY')
    expect(JSON.stringify(beforeMessages)).toContain('TRACE_SOURCE_ONLY')
    expect(JSON.stringify(beforeMessages)).not.toContain('TRACE_DESTINATION_ONLY')
    // These are different model information times, not interchangeable snapshots of the first input.
    const stageInput = carrying.requests.map(event => ({ sessionId: source.id, seq: event.seq, request: event.data }))
    expect(stageInput.map(stage => stage.request.provider)).toEqual(['mock', 'typesafe'])
    expect(second.data.userText).toContain('Resume destination')
    expect(to.meta.id).toBe(destination.id)
    const toOwn = to.events.slice(to.inheritedEventCount)
    const reviews = toOwn.filter(event => event.type === 'contextify/recommendation-reviewed')
      .filter(event => event.data.recommendationTraceId === ids[2])
    expect(reviews).toHaveLength(1)
    const review = reviews[0]!
    expect(review.data.sourceBase).toEqual(first.data.base)
    expect(review.data.base.activeSessionId).toBe(destination.id)
    const plan = toOwn.filter(event => event.type === 'contextify/plan' && event.seq < review.seq).at(-1)!
    expect(plan).toBeDefined()
    const preApply = Session.fromRestore(destination.id, to.events.slice(0, plan.seq),
      to.meta, to.inheritedEventCount, 'detached')
    expect(currentContextPlan(preApply).revision).toBe(review.data.base.planRevision)
    const appliedPrefix = to.events.slice(0, review.seq + 1)
    const applied = Session.fromRestore(destination.id, appliedPrefix, to.meta, to.inheritedEventCount, 'detached')
    const afterMessages = compile(applied)
    expect(afterMessages).toEqual(compile(destination.session))
    expect(JSON.stringify(afterMessages)).toContain('TRACE_DESTINATION_ONLY')
    expect(JSON.stringify(afterMessages)).not.toContain('TRACE_PARENT_ONLY')
    expect(JSON.stringify(afterMessages)).not.toContain('TRACE_SOURCE_ONLY')
    expect(review.data.scopePolicy?.mode).toBe('task-owned')
    const frozen = JSON.stringify({ inputPrefix, stageInput, appliedPrefix, afterMessages })
    const page = await b.ctx.contextify.familyPage(source)
    const local = await b.ctx.contextify.recommend(source, { activeSessionId: source.id,
      graphRevision: page.revision, planRevision: b.ctx.contextify.get(source).plan.revision },
    'Later local-only request.', 'local', true)
    await b.ctx.contextify.presentRecommendation(source, local, 'contextify-client')
    append(source.session, 'TRACE_LATER_INPUT_ONLY')
    const later = await read(source.session)
    const localExposure = later.events.filter(event => event.type === 'contextify/recommendation-presented').at(-1)!
    expect(localExposure.data.recommendationTraceId).toEqual(expect.any(String))
    expect(ids).not.toContain(localExposure.data.recommendationTraceId)
    expect(later.events.filter(event => event.type === 'contextify/recommendation-request')
      .filter(event => event.data.recommendationTraceId === localExposure.data.recommendationTraceId)).toEqual([])
    // A Local exposure without request snapshots has incomplete input; no request is invented from its outcome.
    expect(later.events.slice(0, first.seq)).toEqual(inputPrefix)
    expect(JSON.stringify({ inputPrefix, stageInput, appliedPrefix, afterMessages })).toBe(frozen)
    expect(compile(input)).toEqual(beforeMessages)
    expect(compile(applied)).toEqual(afterMessages)
    expect(JSON.stringify(beforeMessages)).not.toContain('TRACE_LATER_INPUT_ONLY')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(b.adapter.requests).toHaveLength(3)
  } finally { restoreFetch(); await b.close() }
})

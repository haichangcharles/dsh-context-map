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
import { scanLog } from '../packages/session/session-persistence-jsonl/src/format.ts'

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
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
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
    await exported(1)
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

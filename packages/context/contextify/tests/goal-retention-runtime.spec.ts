/** Explicit preservation uses the complete native family, not only the model slate. */
import { expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'
import { CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings } from '../src/types.ts'
import { compileContextify } from '../src/plan.ts'

function append(session: Session, text: string) {
  const turn = session.seq + 1
  session.append('turn/start', { turn })
  const event = session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'mock', model: 'mock' }, content: [],
  }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return `${session.id}:${String(event.seq)}`
}
type Harness = Awaited<ReturnType<typeof lineageHarness>>
async function fork(b: Harness, parent: Harness['parent'], id: string) {
  const seed = parent.session.snapshotEvents()
  return (await b.ctx.agents.create({ sessionId: SessionId(id), seed, inheritedEventCount: SessionLogOffset(seed.length),
    meta: { parentSession: parent.id, isSeeded: true }, agentOptions: { provider: 'mock', model: 'mock' } })).agent
}
function configure(b: Harness, response: object, provider: ContextifyPromptSettings['fastDecisionProvider'] = 'goal-model-jev') {
  ;(b.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }).promptSettings = () => ({
    ...CONTEXTIFY_DEFAULT_SETTINGS, personalizationEnabled: false, fastDecisionProvider: provider,
  })
  if (provider === 'goal-model-jev') b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
  b.adapter.stream = async function* (options) {
    b.adapter.requests.push(options)
    yield* textResponse(JSON.stringify(response))
  }
}
async function review(b: Harness, agent: Harness['parent'], draft = 'Keep only the selected task own messages.') {
  const page = await b.ctx.contextify.familyPage(agent)
  return b.ctx.contextify.recommend(agent, { activeSessionId: agent.id, graphRevision: page.revision,
    planRevision: b.ctx.contextify.get(agent).plan.revision }, draft, 'fast', true)
}

it('keeps a pending current turn after public sibling imports and exclusions', async () => {
  const b = await lineageHarness()
  try {
    const first = append(b.parent.session, 'REMOVE_FIRST')
    const second = append(b.parent.session, 'REMOVE_SECOND')
    append(b.parent.session, 'RETAIN_ANCESTOR')
    const child = await fork(b, b.parent, 'current-tail-child')
    const imported = append(b.parent.session, 'BORROWED_LATER')
    const turn = child.session.seq + 1
    child.session.append('turn/start', { turn })
    child.session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'CURRENT_PENDING' }] }), { surfaceOp: 'append' })
    const ref = (id: string) => ({ sessionId: b.parent.id, seq: SessionSeq(Number(id.split(':').at(-1))) })
    await b.ctx.contextify.setNodeModes(child, { revision: b.ctx.contextify.get(child).plan.revision }, [
      { node: ref(first), mode: 'exclude' }, { node: ref(second), mode: 'exclude' },
      { node: ref(imported), mode: 'include' },
    ])
    const compiled = compileContextify({ session: child.session, turn, step: 1 })
    const users = compiled.messages.filter(message => message.role === 'user')
      .map(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    expect(users).toEqual(['RETAIN_ANCESTOR', 'BORROWED_LATER', 'CURRENT_PENDING'])
    expect(compiled.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'CURRENT_PENDING' }])
    expect(b.adapter.requests).toHaveLength(0)
  } finally { await b.close() }
})

it.each(['continue', 'return'] as const)('preserves a complete >32-source owned scope on %s', async (operation) => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const inherited = append(b.parent.session, 'ANCESTOR_ONLY')
    const task = await fork(b, b.parent, 'retention-task')
    const own = Array.from({ length: 40 }, (_, i) => append(task.session, `OWN_${String(i)}`))
    const child = operation === 'return' ? await fork(b, task, 'retention-child') : task
    if (child !== task) append(child.session, 'OLD_ACTIVE_CHILD')
    configure(b, { goal: 'Continue selected task', assignment: 'existing', sessionId: task.id, retention: 'task-owned' })
    let asked = 0
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, { instructions: string }> }
      expect(body.questions).not.toHaveProperty('wholeTask')
      const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
        if (key.startsWith('n')) {
          asked++
          expect(question.instructions).toContain('Preservation base membership')
        }
        return [key, { type: 'noul', noul: key.startsWith('n') && question.instructions.includes('"baseIncluded":true') ? 1 : 0 }]
      }))
      return Response.json({ model: 'jev-1.13.0', answers })
    })
    const proposal = await review(b, child)
    expect(asked).toBeLessThan(own.length)
    expect(new Set(proposal.proposedNodeIds)).toEqual(new Set(own))
    expect(proposal.proposedNodeIds).not.toContain(inherited)
    if (operation === 'return') {
      expect(proposal.route?.action).toBe('return')
      expect(new Set(proposal.route?.contextNodeIds)).toEqual(new Set(own))
      await b.ctx.contextify.reviewRoute(child, proposal.route!, 'accept', task.id, undefined, true)
      const compiled = JSON.stringify(compileContextify({ session: task.session, turn: task.session.seq + 1, step: 1 }).messages)
      expect(compiled).not.toContain('ANCESTOR_ONLY')
      expect(compiled).not.toContain('OLD_ACTIVE_CHILD')
      for (let i = 0; i < own.length; i++) expect(compiled).toContain(`OWN_${String(i)}`)
    } else {
      expect(proposal.route).toBeUndefined()
      const page = await b.ctx.contextify.familyPage(task)
      await b.ctx.contextify.setNodeModes(task, { revision: proposal.base.planRevision }, proposal.selection.map(item => ({
        node: page.records.find(node => node.id === item.nodeId)!.owner,
        mode: item.action === 'include' ? 'include' : 'exclude',
      })), proposal.base.graphRevision)
      const compiled = JSON.stringify(compileContextify({ session: task.session, turn: task.session.seq + 1, step: 1 }).messages)
      expect(compiled).not.toContain('ANCESTOR_ONLY')
      for (let i = 0; i < own.length; i++) expect(compiled).toContain(`OWN_${String(i)}`)
      b.ctx.contextify.undo(task, { revision: b.ctx.contextify.get(task).plan.revision })
      const undone = JSON.stringify(compileContextify({ session: task.session, turn: task.session.seq + 1, step: 1 }).messages)
      expect(undone).toContain('ANCESTOR_ONLY')
    }
  } finally { fetcher.mockRestore(); await b.close() }
})

it('abstains from an unidentified retention policy before Jev or any scope changes', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'Keep this source untouched')
    configure(b, { goal: 'Continue task', assignment: 'existing', sessionId: b.parent.id, retention: 'unknown' })
    fetcher.mockRejectedValue(new Error('Unknown retention must not invoke Jev'))
    const proposal = await review(b, b.parent)
    expect(proposal.route).toBeUndefined()
    expect(proposal.selection).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(b.ctx.contextify.get(b.parent).plan.revision).toBe(1)
  } finally { fetcher.mockRestore(); await b.close() }
})

it('starts a new owned task empty and carries only an explicitly reviewed borrowed source', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const borrowed = append(b.parent.session, 'BORROW_THIS_CONSTRAINT')
    append(b.parent.session, 'PARENT_IS_PLACEMENT_ONLY')
    const active = await fork(b, b.parent, 'retention-previous')
    append(active.session, 'PREVIOUS_TASK')
    configure(b, { goal: 'New independent work', assignment: 'new', sessionId: b.parent.id, retention: 'task-owned' })
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, { instructions: string }> }
      const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => {
        if (key.startsWith('n')) {
          expect(question.instructions).toContain('"baseIncluded":false')
          expect(question.instructions).toContain('mere relevance is insufficient')
        }
        return [key, { type: 'noul', noul: key.startsWith('n') && question.instructions.includes('BORROW_THIS_CONSTRAINT') ? 1 : 0 }]
      }))
      return Response.json({ model: 'jev-1.13.0', answers })
    })
    const proposal = await review(b, active)
    expect(proposal.route).toMatchObject({ action: 'branch', forkParentSessionId: b.parent.id, contextNodeIds: [borrowed] })
    const target = await fork(b, b.parent, 'retention-new-owned')
    await b.ctx.contextify.reviewRoute(active, proposal.route!, 'accept', target.id, undefined, true)
    const compiled = JSON.stringify(compileContextify({ session: target.session, turn: target.session.seq + 1, step: 1 }).messages)
    expect(compiled).toContain('BORROW_THIS_CONSTRAINT')
    expect(compiled).not.toContain('PARENT_IS_PLACEMENT_ONLY')
    expect(compiled).not.toContain('PREVIOUS_TASK')
  } finally { fetcher.mockRestore(); await b.close() }
})

it('applies reviewed source exceptions without silently restoring the whole base', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const borrowed = append(b.parent.session, 'EXPLICIT_BORROW')
    append(b.parent.session, 'UNREQUESTED_ANCESTOR')
    const task = await fork(b, b.parent, 'retention-exceptions')
    const keep = append(task.session, 'OWN_KEEP')
    append(task.session, 'EXPLICIT_EXCLUDE')
    configure(b, { goal: 'Keep task with requested exceptions', assignment: 'existing', sessionId: task.id, retention: 'task-owned' })
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, { instructions: string }> }
      const answers = Object.fromEntries(Object.entries(body.questions).map(([key, question]) => [key,
        { type: 'noul', noul: key.startsWith('n') && ['EXPLICIT_BORROW', 'OWN_KEEP'].some(text => question.instructions.includes(text)) ? 1 : 0 }]))
      return Response.json({ model: 'jev-1.13.0', answers })
    })
    expect(new Set((await review(b, task)).proposedNodeIds)).toEqual(new Set([borrowed, keep]))
  } finally { fetcher.mockRestore(); await b.close() }
})

it.each(['Return to the mainline', 'New topic: begin an independent task'])('keeps unknown retention abstained despite %s', async (draft) => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'MAINLINE_UNCHANGED')
    const child = await fork(b, b.parent, 'retention-unknown-child')
    append(child.session, 'CHILD_UNCHANGED')
    configure(b, { goal: 'Unidentified retention', assignment: 'existing', sessionId: b.parent.id, retention: 'unknown' })
    fetcher.mockRejectedValue(new Error('Unknown retention must not invoke Jev'))
    const before = b.ctx.contextify.get(child).plan
    const proposal = await review(b, child, draft)
    expect(proposal.route).toBeUndefined()
    expect(proposal.selection).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(b.ctx.contextify.get(child).plan).toEqual(before)
  } finally { fetcher.mockRestore(); await b.close() }
})

it('refuses to restore replaced destination text while carrying preserved Context on Return', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const original = append(b.parent.session, 'DESTINATION_ORIGINAL_TEXT')
    const child = await fork(b, b.parent, 'retention-replacement-child')
    append(child.session, 'CHILD_SOURCE')
    const node = (await b.ctx.contextify.familyPage(b.parent)).records.find(record => record.id === original)!
    await b.ctx.contextify.focusNodeExcerpt(b.parent, { revision: b.ctx.contextify.get(b.parent).plan.revision },
      node.owner, 0, 4, 'Keep only the approved excerpt')
    const sourceBefore = b.ctx.contextify.get(child).plan
    const destinationBefore = b.ctx.contextify.get(b.parent).plan
    configure(b, { goal: 'Continue parent', assignment: 'existing', sessionId: b.parent.id, retention: 'task-owned' })
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, { instructions: string }> }
      return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key,
        { type: 'noul', noul: key.startsWith('n') && q.instructions.includes('"baseIncluded":true') ? 1 : 0 }])) })
    })
    const proposal = await review(b, child)
    expect(proposal.route).toMatchObject({ action: 'return', targetSessionId: b.parent.id, contextUnavailable: true })
    await expect(b.ctx.contextify.reviewRoute(child, proposal.route!, 'accept', b.parent.id, undefined, true))
      .rejects.toThrow('replaced')
    expect(b.ctx.contextify.get(child).plan).toEqual(sourceBefore)
    expect(b.ctx.contextify.get(b.parent).plan).toEqual(destinationBefore)
  } finally { fetcher.mockRestore(); await b.close() }
})

it.each(['goal-model-jev', 'goal-model-native'] as const)('abstains when a required native lineage is unavailable with %s', async (provider) => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const orphan = (await b.ctx.agents.create({ sessionId: SessionId('retention-orphan'),
      meta: { parentSession: SessionId('retention-unavailable-parent') },
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    append(orphan.session, 'OWN_SOURCE_WITH_MISSING_ANCESTRY')
    configure(b, { goal: 'Preserve native lineage', assignment: 'existing', sessionId: orphan.id, retention: 'task-lineage' }, provider)
    fetcher.mockRejectedValue(new Error('Unverified lineage must not invoke Jev'))
    const proposal = await review(b, orphan)
    expect(proposal.route).toBeUndefined()
    expect(proposal.selection).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    expect(b.ctx.contextify.get(orphan).plan.revision).toBe(1)
  } finally { fetcher.mockRestore(); await b.close() }
})

it.each([
  { assignment: 'existing', target: 'active', draft: 'Return to the mainline' },
  { assignment: 'existing', target: 'active', draft: 'New topic: begin independent work' },
  { assignment: 'new', target: 'parent', draft: 'Return to the mainline' },
] as const)('does not guess a preserved scope when explicit routing contradicts $assignment/$target: $draft', async (scenario) => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'MAINLINE_SCOPE')
    const child = await fork(b, b.parent, 'retention-conflicting-child')
    append(child.session, 'CHILD_SCOPE')
    configure(b, { goal: 'Preserve assigned work', assignment: scenario.assignment,
      sessionId: scenario.target === 'active' ? child.id : b.parent.id, retention: 'task-owned' })
    fetcher.mockImplementation(async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { questions: Record<string, { instructions: string }> }
      return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => [key,
        { type: 'noul', noul: key.startsWith('n') && q.instructions.includes('"baseIncluded":true') ? 1 : 0 }])) })
    })
    const before = b.ctx.contextify.get(child).plan
    const proposal = await review(b, child, scenario.draft)
    expect(proposal.route).toBeUndefined()
    expect(proposal.selection).toEqual([])
    expect(b.ctx.contextify.get(child).plan).toEqual(before)
  } finally { fetcher.mockRestore(); await b.close() }
})


it.each(['continue', 'return'] as const)('uses exact native task Context without Jev credentials on %s', async (operation) => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'EXACT_ANCESTOR_ONLY')
    const task = await fork(b, b.parent, 'exact-native-task')
    const texts = Array.from({ length: 40 }, (_, i) => `EXACT_OWN_${String(i)}`)
    const own = texts.map(text => append(task.session, text))
    const active = operation === 'return' ? await fork(b, task, 'exact-native-child') : task
    if (active !== task) append(active.session, 'EXACT_OLD_CHILD')
    const provider = 'goal-model-native'
    configure(b, { goal: 'Continue the selected task', assignment: 'existing', sessionId: task.id, retention: 'task-owned' }, provider)
    fetcher.mockRejectedValue(new Error('Exact native mode must not invoke a Jev transport'))
    const proposal = await review(b, active, 'Keep only the selected task own complete Context.')
    expect(proposal.personalization?.reviewer).toBe('goal-model-native')
    expect(new Set(proposal.proposedNodeIds)).toEqual(new Set(own))
    expect(b.adapter.requests).toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(active.session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-request')).toHaveLength(1)
    if (operation === 'return') {
      expect(proposal.route).toMatchObject({ action: 'return', targetSessionId: task.id })
      expect(new Set(proposal.route?.contextNodeIds)).toEqual(new Set(own))
      await b.ctx.contextify.reviewRoute(active, proposal.route!, 'accept', task.id, undefined, true)
    } else {
      const page = await b.ctx.contextify.familyPage(task)
      await b.ctx.contextify.setNodeModes(task, { revision: proposal.base.planRevision }, proposal.selection.map(item => ({
        node: page.records.find(record => record.id === item.nodeId)!.owner,
        mode: item.action === 'include' ? 'include' : 'exclude',
      })), proposal.base.graphRevision)
    }
    const userTexts = (session: Session) => compileContextify({ session, turn: session.seq + 1, step: 1 }).messages
      .flatMap(message => message.role === 'user' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(userTexts(task.session)).toEqual(texts)
    if (operation === 'return') {
      configure(b, { goal: 'Resume the side task', assignment: 'existing', sessionId: active.id, retention: 'task-owned' }, provider)
      const reactivated = await review(b, task, 'Resume the side task using only its own complete Context.')
      expect(reactivated.route).toMatchObject({ action: 'navigate', targetSessionId: active.id })
      await b.ctx.contextify.reviewRoute(task, reactivated.route!, 'accept', active.id, undefined, true)
      append(active.session, 'EXACT_LATER_QUERY')
      expect(userTexts(active.session)).toEqual(['EXACT_OLD_CHILD', 'EXACT_LATER_QUERY'])
      expect(b.adapter.requests).toHaveLength(2)
      expect(fetcher).not.toHaveBeenCalled()
    }
  } finally { fetcher.mockRestore(); await b.close() }
})


it.each(['task-owned', 'task-lineage'] as const)('creates an exact native sibling with %s Context', async (retention) => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const root = append(b.parent.session, 'EXACT_ROOT_CONTEXT')
    const old = await fork(b, b.parent, 'exact-native-old-task')
    append(old.session, 'EXACT_UNRELATED_TASK')
    configure(b, { goal: 'A new independent task', assignment: 'new', sessionId: b.parent.id, retention }, 'goal-model-native')
    fetcher.mockRejectedValue(new Error('Native sibling review must not call Jev'))
    const proposal = await review(b, old, 'A separate work item with the requested complete task Context.')
    expect(proposal.route).toMatchObject({ action: 'branch', forkParentSessionId: b.parent.id })
    expect(proposal.route?.contextNodeIds).toEqual(retention === 'task-owned' ? [] : [root])
    const target = await fork(b, b.parent, 'exact-native-new-task')
    await b.ctx.contextify.reviewRoute(old, proposal.route!, 'accept', target.id, undefined, true)
    append(target.session, 'EXACT_NEW_INPUT')
    const users = compileContextify({ session: target.session, turn: target.session.seq + 1, step: 1 }).messages
      .flatMap(message => message.role === 'user' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    expect(users).toEqual(retention === 'task-owned' ? ['EXACT_NEW_INPUT'] : ['EXACT_ROOT_CONTEXT', 'EXACT_NEW_INPUT'])
    expect(b.adapter.requests).toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore(); await b.close() }
})

it.each(['unknown', 'relevance', 'unknown-assignment', 'other-without-draft', 'new-without-draft'] as const)(
  'abstains from unsupported exact native intent: %s', async (kind) => {
    const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      append(b.parent.session, 'EXACT_UNKNOWN_ROOT')
      const active = await fork(b, b.parent, 'exact-unknown-active')
      append(active.session, 'EXACT_UNKNOWN_ACTIVE')
      const noDraft = kind.endsWith('without-draft')
      configure(b, { goal: 'Unidentified complete task scope',
        assignment: kind === 'unknown-assignment' ? 'unknown' : kind === 'new-without-draft' ? 'new' : 'existing',
        sessionId: kind === 'unknown-assignment' ? null : noDraft ? b.parent.id : active.id,
        retention: kind === 'unknown' || kind === 'relevance' ? kind : 'task-owned' }, 'goal-model-native')
      fetcher.mockRejectedValue(new Error('Abstention cannot fall back to Jev'))
      const before = b.ctx.contextify.get(active).plan
      const page = await b.ctx.contextify.familyPage(active)
      const proposal = await b.ctx.contextify.recommend(active, { activeSessionId: active.id, graphRevision: page.revision,
        planRevision: before.revision }, 'Preserve the requested work.', 'fast', !noDraft)
      expect(proposal.route).toBeUndefined()
      expect(proposal.selection).toEqual([])
      expect(b.ctx.contextify.get(active).plan).toEqual(before)
      expect(b.adapter.requests).toHaveLength(1)
      expect(fetcher).not.toHaveBeenCalled()
    } finally { fetcher.mockRestore(); await b.close() }
  },
)

it.each(['continue', 'return'] as const)('refuses replaced original bodies in exact native %s', async (operation) => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const original = append(b.parent.session, 'EXACT_ORIGINAL_BODY')
    const active = operation === 'return' ? await fork(b, b.parent, 'exact-replaced-child') : b.parent
    if (active !== b.parent) append(active.session, 'EXACT_OTHER_CONTEXT')
    const node = (await b.ctx.contextify.familyPage(b.parent)).records.find(record => record.id === original)!
    await b.ctx.contextify.focusNodeExcerpt(b.parent, { revision: b.ctx.contextify.get(b.parent).plan.revision },
      node.owner, 0, 5, 'Keep the approved short excerpt')
    const before = b.ctx.contextify.get(b.parent).plan
    const compiledBefore = compileContextify({ session: b.parent.session, turn: b.parent.session.seq + 1, step: 1 }).messages
    configure(b, { goal: 'Preserve complete original task', assignment: 'existing', sessionId: b.parent.id,
      retention: 'task-owned' }, 'goal-model-native')
    fetcher.mockRejectedValue(new Error('Exact replacement refusal must not call Jev'))
    await expect(review(b, active)).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
    expect(b.ctx.contextify.get(b.parent).plan).toEqual(before)
    expect(compileContextify({ session: b.parent.session, turn: b.parent.session.seq + 1, step: 1 }).messages).toEqual(compiledBefore)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore(); await b.close() }
})

it('keeps the initial exact base authoritative after an explicit route conflict', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    append(b.parent.session, 'EXACT_CONFLICT_PARENT')
    const active = await fork(b, b.parent, 'exact-route-conflict')
    append(active.session, 'EXACT_CONFLICT_CHILD')
    configure(b, { goal: 'Preserve active task', assignment: 'existing', sessionId: active.id, retention: 'task-owned' }, 'goal-model-native')
    fetcher.mockRejectedValue(new Error('A route conflict must not call Jev'))
    const before = b.ctx.contextify.get(active).plan
    await expect(review(b, active, 'Return to the mainline')).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
    expect(b.ctx.contextify.get(active).plan).toEqual(before)
    expect(fetcher).not.toHaveBeenCalled()
  } finally { fetcher.mockRestore(); await b.close() }
})


it.each([{ kind: 'missing', objective: undefined }, { kind: 'empty', objective: '' },
  { kind: 'truncated', objective: 'x'.repeat(5000) }])('does not apply a new task scope without an exact routable draft: $kind', async ({ objective }) => {
  const b = await lineageHarness()
  try {
    append(b.parent.session, 'EXACT_DRAFT_REQUIRED_SOURCE')
    configure(b, { goal: 'New work', assignment: 'new', sessionId: b.parent.id, retention: 'task-owned' }, 'goal-model-native')
    const page = await b.ctx.contextify.familyPage(b.parent)
    const before = b.ctx.contextify.get(b.parent).plan
    const proposal = await b.ctx.contextify.recommend(b.parent, { activeSessionId: b.parent.id,
      graphRevision: page.revision, planRevision: before.revision }, objective, 'fast', true)
    expect(proposal.route).toBeUndefined()
    expect(proposal.selection).toEqual([])
    expect(b.ctx.contextify.get(b.parent).plan).toEqual(before)
    expect(b.adapter.requests).toHaveLength(1)
  } finally { await b.close() }
})


it('preserves the current owned task without a draft while keeping inherited Context inactive', async () => {
  const b = await lineageHarness()
  try {
    append(b.parent.session, 'NONDRAFT_ANCESTOR')
    const task = await fork(b, b.parent, 'exact-nondraft-current')
    const own = append(task.session, 'NONDRAFT_TASK')
    configure(b, { goal: 'Preserve this task', assignment: 'existing', sessionId: task.id, retention: 'task-owned' }, 'goal-model-native')
    const page = await b.ctx.contextify.familyPage(task)
    const result = await b.ctx.contextify.recommend(task, { activeSessionId: task.id, graphRevision: page.revision,
      planRevision: b.ctx.contextify.get(task).plan.revision }, undefined, 'fast')
    expect(result.route).toBeUndefined()
    expect(result.proposedNodeIds).toEqual([own])
    const input = task.session.snapshotEvents().find(event => event.type === 'contextify/recommendation-request')
    expect(input?.type === 'contextify/recommendation-request' ? input.data.system : '').toMatchSnapshot()
  } finally { await b.close() }
})


it('abstains from individual Web source exceptions in exact native mode without a model call', async () => {
  const b = await lineageHarness()
  try {
    append(b.parent.session, 'Compare the source reports')
    const callId = ToolCallId('exact-native-web-source')
    const call = b.parent.session.append('tool/call', { turn: 2, step: 1, callId, name: 'web_fetch',
      arguments: '{"url":"https://source.test/old"}' })
    b.parent.session.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: 'ORIGINAL_WEB_CONTEXT' }], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
    configure(b, {}, 'goal-model-native')
    const before = b.ctx.contextify.get(b.parent).plan
    const result = await review(b, b.parent, 'Ignore https://source.test/old. Continue the comparison.')
    expect(result.selection).toEqual([])
    expect(result.route).toBeUndefined()
    expect(b.adapter.requests).toEqual([])
    expect(b.ctx.contextify.get(b.parent).plan).toEqual(before)
  } finally { await b.close() }
})


it('refuses a manual Exclude conflict and allows exact review after the user clears it', async () => {
  const b = await lineageHarness()
  try {
    append(b.parent.session, 'MANUAL_ANCESTOR')
    const task = await fork(b, b.parent, 'exact-manual-task')
    const own = append(task.session, 'MANUAL_EXCLUDED_TASK_SOURCE')
    const node = (await b.ctx.contextify.familyPage(task)).records.find(record => record.id === own)!
    await b.ctx.contextify.setNodeMode(task, { revision: b.ctx.contextify.get(task).plan.revision }, node.owner, 'exclude', 'contextify-client')
    configure(b, { goal: 'Preserve this task', assignment: 'existing', sessionId: task.id, retention: 'task-owned' }, 'goal-model-native')
    const before = b.ctx.contextify.get(task).plan
    await expect(review(b, task)).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
    expect(b.ctx.contextify.get(task).plan).toEqual(before)
    expect(JSON.stringify(compileContextify({ session: task.session, turn: task.session.seq + 1, step: 1 }).messages))
      .not.toContain('MANUAL_EXCLUDED_TASK_SOURCE')
    await b.ctx.contextify.setNodeMode(task, { revision: before.revision }, node.owner, 'natural', 'contextify-client')
    expect((await review(b, task)).proposedNodeIds).toEqual([own])
    expect(b.adapter.requests).toHaveLength(2)
  } finally { await b.close() }
})

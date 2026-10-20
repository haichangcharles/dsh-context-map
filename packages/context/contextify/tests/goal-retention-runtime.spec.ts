/** Explicit preservation uses the complete native family, not only the model slate. */
import { expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
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
function configure(b: Harness, response: object) {
  ;(b.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }).promptSettings = () => ({
    ...CONTEXTIFY_DEFAULT_SETTINGS, personalizationEnabled: false, fastDecisionProvider: 'goal-model-jev',
  })
  b.ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-key' }) } as never)
  b.adapter.stream = async function* () { yield* textResponse(JSON.stringify(response)) }
}
async function review(b: Harness, agent: Harness['parent'], draft = 'Keep only the selected task own messages.') {
  const page = await b.ctx.contextify.familyPage(agent)
  return b.ctx.contextify.recommend(agent, { activeSessionId: agent.id, graphRevision: page.revision,
    planRevision: b.ctx.contextify.get(agent).plan.revision }, draft, 'fast', true)
}

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

it('abstains when a required native lineage is unavailable before Jev', async () => {
  const b = await lineageHarness(), fetcher = vi.spyOn(globalThis, 'fetch')
  try {
    const orphan = (await b.ctx.agents.create({ sessionId: SessionId('retention-orphan'),
      meta: { parentSession: SessionId('retention-unavailable-parent') },
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    append(orphan.session, 'OWN_SOURCE_WITH_MISSING_ANCESTRY')
    configure(b, { goal: 'Preserve native lineage', assignment: 'existing', sessionId: orphan.id, retention: 'task-lineage' })
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

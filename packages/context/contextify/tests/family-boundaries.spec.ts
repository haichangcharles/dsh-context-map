/** Native family projection boundaries, including incomplete persisted lineage. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, type ImageBlock } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { projectSessionFamily } from '../src/family.ts'
import type { ContextFamilyInspection } from '../src/types.ts'

const inspect = (session: Session): ContextFamilyInspection => ({ meta: session.header,
  events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount })
const image: ImageBlock = { type: 'image', attachment: {
  attachmentId: 'family-image' as ImageBlock['attachment']['attachmentId'], mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
async function withStore(run: (ctx: Context) => void): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try { run(ctx) } finally { await ctx.fiber.dispose() }
}
function user(session: Session, text: string): void {
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

// Event times are millisecond-resolution persisted data. Replaying equal or
// ordered values exercises public inspection input, without private clock mocks.
const at = (inspection: ContextFamilyInspection, time: number): ContextFamilyInspection => ({ ...inspection,
  events: inspection.events.map(event => ({ ...event, time })) })

describe('native Session-family boundary contracts', () => {
  it('rejects an unavailable active Session instead of inventing a family', () => {
    expect(() => projectSessionFamily({ activeSessionId: SessionId('absent'), sessions: [] }))
      .toThrow('is unavailable')
  })

  it('retains image messages and worker reports without leaking private reasoning', async () => withStore((ctx) => {
    const root = ctx.sessions.create(SessionId('family-images'))
    root.append('turn/start', { turn: 1 })
    root.append('system/message', { turn: 1, step: 1, message: createSystemMessage('Private system rules', 'fixture-system') }, { surfaceOp: 'append' })
    root.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [image] }), { surfaceOp: 'append' })
    const senderSessionId = SessionId('worker')
    const reports = [
      createUserMessage({ source: { kind: 'agent-message', form: 'relay', senderSessionId },
        content: [{ type: 'text', text: 'agent-message' }] }),
      createUserMessage({ source: { kind: 'subagent-settled', form: 'notice',
        summary: 'Worker completed its source-bound report.', senderSessionId },
      content: [{ type: 'text', text: 'subagent-settled' }] }),
    ]
    for (const report of reports) root.append('user/message', report, { surfaceOp: 'append' })
    root.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({
      content: [{ type: 'reasoning', text: 'private' }, image], source: { provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    root.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const graph = projectSessionFamily({ activeSessionId: root.id, sessions: [inspect(root)] })
    expect(graph.nodes.map(node => [node.role, node.sourceKind, node.preview]))
      .toEqual([['user', 'chat', '[Image]'], ['user', 'worker', 'agent-message'],
        ['user', 'worker', 'subagent-settled'], ['assistant', 'chat', '[Image]']])
  }))

  it('keeps a failed Web result inspectable while denying importable Web action provenance', async () => withStore((ctx) => {
    const root = ctx.sessions.create(SessionId('family-error-web'))
    root.append('turn/start', { turn: 1 })
    const callId = ToolCallId('failed-search')
    const call = root.append('tool/call', { turn: 1, step: 1, callId, name: 'web_search', arguments: '{}' })
    root.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId,
      content: [{ type: 'text', text: 'Search unavailable' }], isError: true }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    root.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const graph = projectSessionFamily({ activeSessionId: root.id, sessions: [inspect(root)] })
    expect(graph.nodes).toHaveLength(1)
    expect(graph.nodes[0]).toMatchObject({ sourceKind: 'web', preview: 'Search unavailable' })
    expect(graph.nodes[0]?.webAction).toBeUndefined()
  }))

  it('keeps a child readable when its native parent inspection is unavailable', async () => withStore((ctx) => {
    const root = ctx.sessions.create(SessionId('family-missing-parent'))
    root.append('turn/start', { turn: 1 })
    user(root, 'Original root input')
    const boundary = root.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const child = ctx.sessions.fork(root, boundary.seq, SessionId('family-orphan-child'))
    const graph = projectSessionFamily({ activeSessionId: child.id, sessions: [inspect(child)] })
    expect(graph.rootSessionId).toBe(child.id)
    expect(graph.nodes.map(node => node.owner.sessionId)).toEqual([child.id])
    expect(graph.sessions).toHaveLength(1)
    expect(graph.sessions[0]?.parentSessionId).toBe(root.id)
  }))

  it('handles empty native fork metadata and cyclic persisted parent links without recursion', async () => withStore((ctx) => {
    const a = ctx.sessions.create(SessionId('family-cycle-a'), { meta: { parentSession: SessionId('family-cycle-b') } })
    const b = ctx.sessions.create(SessionId('family-cycle-b'), { meta: { parentSession: a.id } })
    const graph = projectSessionFamily({ activeSessionId: a.id, sessions: [inspect(b), inspect(a)] })
    expect(graph.sessions.map(session => [session.id, session.depth, session.tipNodeId]))
      .toEqual([[a.id, 0, null], [b.id, 1, null]])
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  }))

  it('uses legacy lifecycle timestamps until a later human turn reopens the task', async () => withStore((ctx) => {
    const root = ctx.sessions.create(SessionId('family-legacy-state'))
    user(root, 'Earlier input')
    root.append('contextify/work-state', { targetSessionId: root.id, state: 'completed', uiOrigin: 'contextify-client' })
    const sameTime = at(inspect(root), 100)
    expect(projectSessionFamily({ activeSessionId: root.id, sessions: [sameTime] }).sessions[0])
      .toMatchObject({ workState: 'completed', workStateSource: 'explicit' })
    user(root, 'Resume this task')
    const later = inspect(root)
    const events = later.events.map(event => ({ ...event, time: event.type === 'user/message' && event.seq > 0 ? 101 : 100 }))
    expect(projectSessionFamily({ activeSessionId: root.id, sessions: [{ ...later, events }] }).sessions[0])
      .toMatchObject({ workState: 'open', workStateSource: 'derived' })
  }))

  it('orders simultaneous owned task-state choices by Session and native event sequence', async () => withStore((ctx) => {
    const a = ctx.sessions.create(SessionId('family-choice-a'))
    const b = ctx.sessions.create(SessionId('family-choice-b'), { meta: { parentSession: a.id } })
    a.append('contextify/work-state', { targetSessionId: b.id, state: 'completed', uiOrigin: 'contextify-client' })
    b.append('contextify/work-state', { targetSessionId: b.id, state: 'parked', uiOrigin: 'contextify-client' })
    b.append('contextify/work-state', { targetSessionId: b.id, state: 'open', uiOrigin: 'contextify-client' })
    const graph = projectSessionFamily({ activeSessionId: a.id, sessions: [at(inspect(b), 10), at(inspect(a), 10)] })
    expect(graph.sessions.find(session => session.id === b.id))
      .toMatchObject({ workState: 'open', workStateSource: 'explicit' })
  }))
})

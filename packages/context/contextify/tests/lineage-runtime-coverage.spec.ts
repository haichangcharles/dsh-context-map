/** Public pre-step lifecycle, source-tool guards and bounded quarantine behavior. */
import { expect, it } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import { recordDelegationSlice } from '../src/revision-lineage.ts'
import { REVISION_LINEAGE_COMPILER_ID } from '../src/revision-lineage-runtime.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'

const human = () => createUserMessage({ content: [{ type: 'text', text: 'human source' }], source: { kind: 'user' } })

/** Invoke the public around-middleware event exactly as the Harness step driver does. */
async function step(ctx: Awaited<ReturnType<typeof lineageHarness>>['ctx'], agent: Agent,
  messages: UserMessage[], turn = 1, terminal?: PreStepDecision): Promise<PreStepDecision> {
  return agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages, turn, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve(terminal ?? { kind: 'enter', messages }))
}

it('leaves rejected steps, subagent execution details and independent compilers unmodified', async () => {
  const b = await lineageHarness(true)
  try {
    const initial = b.parent.session.snapshotEvents()
    expect(await step(b.ctx, b.parent, [], 1, { kind: 'reject' })).toEqual({ kind: 'reject' })
    expect(b.parent.session.snapshotEvents()).toEqual(initial)
    const child = await b.ctx.agents.create({ sessionId: SessionId('runtime-owned-child'), meta: { origin: 'subagent' } })
    expect(await step(b.ctx, child.agent, [])).toEqual({ kind: 'enter', messages: [] })
    expect(b.ctx.contextCompiler.descriptor(child.agent.session).id).toBe('surface')
    b.ctx.contextCompiler.register({ id: 'independent', version: 1, select: () => ({ eventSeqs: [] }) })
    b.ctx.contextCompiler.select(b.parent.session, 'independent')
    expect(await step(b.ctx, b.parent, [])).toEqual({ kind: 'enter', messages: [] })
    expect(b.parent.session.snapshotEvents().some(event => event.type === 'contextify/request-read-set')).toBe(false)
  } finally { await b.close() }
})

it('quarantines only uncertified worker messages, retains the newest64, copies inspection and clears on disposal', async () => {
  const b = await lineageHarness(true)
  try {
    expect(b.ctx.contextifyRevisionLineage.quarantinedFor(b.parent.id)).toEqual([])
    const source = b.parent.session.append('user/message', human(), { surfaceOp: 'append' }).seq
    const child = SessionId('runtime-certified-child')
    recordDelegationSlice(b.parent.session, child, [source])
    const accepted = createUserMessage({ content: [{ type: 'text', text: 'certified worker' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Source-bound worker completed.', senderSessionId: child } })
    const ordinary = human()
    const rejected = Array.from({ length: 70 }, (_, i) => createUserMessage({ content: [{ type: 'text', text: String(i) }],
      source: i % 2 === 0 ? { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('uncertified') }
        : { kind: 'subagent-settled', form: 'notice', summary: 'Uncertified worker completed.', senderSessionId: SessionId('uncertified') } }))
    const decision = await step(b.ctx, b.parent, [ordinary, accepted, ...rejected])
    expect(decision).toEqual({ kind: 'enter', messages: [ordinary, accepted] })
    expect(b.ctx.contextCompiler.descriptor(b.parent.session).id).toBe(REVISION_LINEAGE_COMPILER_ID)
    const quarantined = b.ctx.contextifyRevisionLineage.quarantinedFor(b.parent.id)
    expect(quarantined.map(message => message.id)).toEqual(rejected.slice(-64).map(message => message.id))
    expect(b.ctx.contextifyRevisionLineage.quarantinedFor(b.parent.id)).not.toBe(quarantined)
    expect(b.ctx.contextifyRevisionLineage.quarantinedFor(b.parent.id)).toHaveLength(64)
    b.parent.session.append('user/message', ordinary, { surfaceOp: 'append' })
    b.parent.session.append('user/message', accepted, { surfaceOp: 'append' })
    b.parent.session.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'tracked answer' }],
        source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    b.ctx.contextCompiler.select(b.parent.session, 'surface')
    await step(b.ctx, b.parent, [], 2)
    expect(b.ctx.contextCompiler.descriptor(b.parent.session).id).toBe(REVISION_LINEAGE_COMPILER_ID)
    await step(b.ctx, b.parent, [], 3)
    expect(b.parent.session.snapshotEvents().filter(event => event.type === 'contextify/request-read-set')).toHaveLength(3)
    expect(b.parent.session.snapshotEvents().filter(event => event.type === 'context/compiler')).toHaveLength(3)
    await b.disposeParent()
    expect(b.ctx.contextifyRevisionLineage.quarantinedFor(b.parent.id)).toEqual([])
  } finally { await b.close() }
})

it('rejects source tools without protected ownership and rejects empty or oversized protected delegation', async () => {
  const b = await lineageHarness(true)
  try {
    const execute = (name: string, args: unknown, agent?: Agent) => b.ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('runtime-source-tool'), name, arguments: args,
      ...(agent === undefined ? {} : { agent }),
    })
    expect((await execute('list_context_sources', {})).error?.message).toContain('protected parent')
    expect((await execute('delegate_context_sources', { source_event_seqs: [0] }, b.parent)).error?.message)
      .toContain('protected parent')
    await step(b.ctx, b.parent, [])
    for (const seqs of [[], Array.from({ length: 9 }, (_, i) => i)]) {
      expect((await execute('delegate_context_sources', { source_event_seqs: seqs }, b.parent)).error?.message)
        .toContain('one to eight')
    }
    expect((await execute('list_context_sources', {}, b.parent)).isError).toBe(false)
  } finally { await b.close() }
})

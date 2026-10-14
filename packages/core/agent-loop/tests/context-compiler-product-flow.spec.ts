import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import LlmRuntime, { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { compileContextify, createInitialContextPlan, nextPlan, undoPlan } from '../../../context/contextify/src/plan.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ContextCompilerRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function messageText(message: Message): string {
  return message.content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('context compiler product flow', () => {
  it('sends the edited logical sources after a mixed checkpoint and restores the checkpoint on Undo', async () => {
    const adapter = new MockAdapter([
      textResponse('answer A'),
      textResponse('answer B'),
      textResponse('answer after Exclude'),
      textResponse('answer after Undo'),
    ])
    const ctx = await harness(adapter)
    try {
      ctx.contextCompiler.register({
        id: 'contextify-test', version: 3,
        select: request => ({ eventSeqs: compileContextify(request).eventSeqs }),
      })
      const agent = await ctx.agentLoop.create(SessionId('mixed-checkpoint-provider-send'), {
        provider: 'mock', model: 'mock',
      })
      ctx.contextCompiler.select(agent.session, 'contextify-test')
      const initial = createInitialContextPlan()
      agent.session.append('contextify/plan', initial)

      send(agent, 'source A')
      await agent.whenIdle()
      send(agent, 'source B')
      await agent.whenIdle()

      const messages = agent.session.snapshotEvents().filter(event =>
        event.type === 'user/message' || event.type === 'assistant/message')
      expect(messages).toHaveLength(4)
      const [userA, assistantA, userB, assistantB] = messages
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'checkpoint A+B' }],
        source: { kind: 'plugin', plugin: 'compact' },
      }), {
        surfaceOp: { op: 'replace', startSeq: userA!.seq, endSeq: assistantB!.seq },
        sourceEventSeqs: [userA!.seq, assistantA!.seq, userB!.seq, assistantB!.seq],
      })
      const excluded = nextPlan(initial, {
        excluded: [
          { nodeId: 'source-a-user', eventSeq: userA!.seq },
          { nodeId: 'source-a-assistant', eventSeq: assistantA!.seq },
        ], included: [], replacements: [],
      })
      agent.session.append('contextify/plan', excluded)

      send(agent, 'question after Exclude')
      await agent.whenIdle()
      const excludedRequest = adapter.requests[2]!.messages.map(messageText)
      expect(excludedRequest).toContain('source B')
      expect(excludedRequest).toContain('answer B')
      expect(excludedRequest).not.toContain('source A')
      expect(excludedRequest).not.toContain('answer A')
      expect(excludedRequest).not.toContain('checkpoint A+B')

      const restored = undoPlan(agent.session, excluded)
      expect(restored).not.toBeNull()
      agent.session.append('contextify/plan', restored!)
      send(agent, 'question after Undo')
      await agent.whenIdle()
      expect(adapter.requests[3]!.messages.map(messageText)).toContain('checkpoint A+B')
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses an unsupported durable Surface compiler version before model I/O', async () => {
    const adapter = new MockAdapter([textResponse('must not run')])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('surface-version-mismatch'), { provider: 'mock', model: 'mock' })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      agent.session.append('context/compiler', { id: 'surface', version: 99 })
      send(agent, 'go')
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(0)
      expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'COMPILER_VERSION_MISMATCH' })]))
    } finally { await ctx.fiber.dispose() }
  })

  it('turns a mutable Context Map plan into the exact reordered model request and survives replay', async () => {
    const adapter = new MockAdapter([
      textResponse('draft that the next branch will exclude'),
      textResponse('answer from the controlled context'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('context-map-product-flow'), {
      provider: 'mock',
      model: 'mock',
    })

    // This mutable list stands in for the Context Map UI's saved plan. The
    // provider resolves human-readable plan entries to durable event seqs;
    // production Contextify will persist stable node ids instead.
    let visibleOrder = ['root requirement']
    ctx.contextCompiler.register({
      id: 'context-map-mock',
      version: 1,
      select: ({ session }) => ({
        eventSeqs: visibleOrder.map((wanted) => {
          const match = session.snapshotEvents().find((event) => {
            const message = session.deriveEventMessage(event)
            return message !== null && messageText(message) === wanted
          })
          if (match === undefined) throw new Error(`mock Context Map node not found: ${wanted}`)
          return match.seq
        }),
      }),
    })
    ctx.contextCompiler.select(agent.session, 'context-map-mock')

    send(agent, 'root requirement')
    await agent.whenIdle()

    // A lightweight branch is a different selection/order over the same
    // durable session log, not a second Session. It keeps the root and the new
    // follow-up, drops the previous assistant draft, and controls their order.
    visibleOrder = ['branch follow-up', 'root requirement']
    send(agent, 'branch follow-up')
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.messages.map(messageText))).toEqual([
      ['root requirement'],
      ['branch follow-up', 'root requirement'],
    ])
    expect(agent.session.deriveMessages().map(messageText)).toEqual([
      'You are an AI agent powered by DeepSeek Harness.',
      'root requirement',
      'draft that the next branch will exclude',
      'branch follow-up',
      'answer from the controlled context',
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'context/compiler')).toHaveLength(1)
    expect(agent.session.requestHeader()?.contextCompiler).toEqual({
      id: 'context-map-mock',
      version: 1,
    })

    const replayed = Session.create(SessionId('context-map-product-flow-replayed'), [
      ...agent.session.snapshotEvents(),
    ])
    expect(ctx.contextCompiler.descriptor(replayed)).toEqual({
      id: 'context-map-mock',
      version: 1,
    })
    expect(ctx.contextCompiler.compile({ session: replayed, turn: 2, step: 1 }).messages.map(messageText))
      .toEqual(['branch follow-up', 'root requirement'])
  })
})

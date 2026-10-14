import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, LlmError  } from '@deepseek-ai/dsh-llm'
import type { LlmFailure, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function fail(message: string, code: string): () => never {
  return () => {
    throw new LlmError(message, code)
  }
}

describe('agent/request-error', () => {
  it('recompiles selected context after recovery changes the durable selection', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('ok')])
    const ctx = await harness(adapter)
    try {
      await ctx.plugin(ContextCompilerRegistry)
      const agent = await ctx.agentLoop.create(SessionId('compiler-recovery'), { provider: 'mock', model: 'mock' })
      ctx.contextCompiler.register({ id: 'latest-snapshot', version: 1, select: ({ session }) => ({
        eventSeqs: session.snapshotEvents().filter(event => event.type === 'context/compiler-snapshot').slice(-1).map(event => event.seq),
      }) })
      const snapshot = (text: string) => agent.session.append('context/compiler-snapshot', {
        id: text,
        message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      })
      snapshot('before recovery')
      ctx.contextCompiler.select(agent.session, 'latest-snapshot')
      ctx.on('agent/request-error', async () => { snapshot('after recovery'); return { kind: 'retry' } })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.requests.map(request => request.messages)).toEqual([
        [expect.objectContaining({ content: [{ type: 'text', text: 'before recovery' }] })],
        [expect.objectContaining({ content: [{ type: 'text', text: 'after recovery' }] })],
      ])
    } finally { await ctx.fiber.dispose() }
  })

  it('does not offer middleware failures to request recovery', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-narrow'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request', () => {
      throw new LlmError('middleware failed', 'MIDDLEWARE')
    })
    ctx.on('agent/request-error', async () => {
      recoveries += 1
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(recoveries).toBe(0)
    expect(adapter.requests).toHaveLength(0)
  })

  it('lets each failed request return a retry action before its turn closes', async () => {
    const adapter = new MockAdapter([
      fail('busy', 'RATE_LIMIT'),
      fail('unavailable', 'SERVICE_UNAVAILABLE'),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-retry'), { provider: 'mock', model: 'mock' })
    const seen: {
      turn: number
      step: number
      failure: LlmFailure
      retryPolicy: ResolvedRetryPolicy | undefined
    }[] = []
    const statuses: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent) statuses.push(status)
    })
    ctx.on('agent/request-error', async ({ agent: subject, turn, step, failure, retryPolicy }) => {
      expect(subject).toBe(agent)
      seen.push({ turn, step, failure, retryPolicy })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(seen.map(item => ({
      turn: item.turn,
      step: item.step,
      code: item.failure.code,
    }))).toEqual([
      {
        turn: 1,
        step: 1,
        code: 'RATE_LIMIT',
      },
      {
        turn: 1,
        step: 1,
        code: 'SERVICE_UNAVAILABLE',
      },
    ])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(seen.map(item => item.retryPolicy)).toEqual([
      expect.objectContaining({ mode: 'normal' }),
      expect.objectContaining({ mode: 'normal' }),
    ])
    expect(statuses).toEqual(['running', 'idle'])
    expect(agent.session.snapshotEvents().flatMap(event =>
      event.type === 'request/header' ? [event.data.reason] : [])).toEqual(['initial'])
  })

  it('lets cancellation win over a retry action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-cancel'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.cancel({ kind: 'user' })
      return { kind: 'retry' }
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
    })
  })

  it('does not retry when the recovery listener fails before returning its action', async () => {
    const adapter = new MockAdapter([fail('busy', 'RATE_LIMIT'), textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('request-error-recovery-failed'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/request-error', async () => {
      throw new Error('recovery failed')
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })
  })

  it('keeps an untouched surface compiler transparent on the native request header', async () => {
    const adapter = new MockAdapter([textResponse('Planning answer')])
    const ctx = await harness(adapter)
    try {
      await ctx.plugin(ContextCompilerRegistry)
      const agent = await ctx.agentLoop.create(SessionId('surface-compiler-transparent'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Plan the next writing phase' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.messages).toContainEqual(expect.objectContaining({ content: [{ type: 'text', text: 'Plan the next writing phase' }] }))
      expect(agent.session.requestHeader()?.contextCompiler).toBeUndefined()
      expect(agent.session.snapshotEvents().some(event => event.type === 'context/compiler')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses replaying a selected compiler when its plugin is absent', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const seed = Session.create(SessionId('missing-compiler-replay'))
      seed.append('context/compiler', { id: 'contextify', version: 3 })
      await expect(ctx.agentLoop.createAgent(ctx, { sessionId: seed.id, seed: seed.snapshotEvents(), agentOptions: { provider: 'mock', model: 'mock' } })).rejects.toThrow('selected Context Compiler plugin is unavailable')
      expect(adapter.requests).toEqual([])
      expect(ctx.agents.get(seed.id)).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a durable request compiler header after its plugin becomes unavailable', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    try {
      const agent = await ctx.agentLoop.create(SessionId('missing-header-compiler'), { provider: 'mock', model: 'mock' })
      agent.session.append('request/header', { header: { config: { provider: 'mock', model: 'mock' }, contextCompiler: { id: 'surface', version: 1 } }, reason: 'resume' })
      const errors: unknown[] = []
      ctx.on('agent/error', ({ error }) => { errors.push(error) })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue the project' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(errors).toContainEqual(expect.objectContaining({ message: 'The selected Context Compiler plugin is unavailable' }))
      expect(adapter.requests).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

})

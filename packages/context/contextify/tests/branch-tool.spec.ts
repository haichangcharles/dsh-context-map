/** Contextify model tools follow Agent scopes rather than the Host catalog. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ContextifyService from '../src/index.ts'
import * as ContextifyBranchTool from '../src/branch-tool.ts'

it('registers only for an explicitly composed Agent and removes the scoped tool on disposal', async () => {
  const ctx = new Context()
  const dir = await mkdtemp(join(tmpdir(), 'dsh-branch-tool-'))
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ContextCompilerRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: dir })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(ContextifyService)
    const selected = await ctx.agents.create({ sessionId: SessionId('branch-tool-enabled'),
      setup: async (agentCtx) => { await agentCtx.plugin(ContextifyBranchTool) } })
    const minimal = await ctx.agents.create({ sessionId: SessionId('branch-tool-omitted') })
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([])
    const disabled = await ctx.agents.create({ sessionId: SessionId('branch-tool-disabled'),
      setup: async (agentCtx) => { await agentCtx.plugin(ContextifyBranchTool, { enabled: false }) } })
    expect(ctx.tools.schemas(disabled.agent).map(tool => tool.name)).toEqual([])
    expect(ctx.tools.schemas(selected.agent).map(tool => tool.name)).toEqual(['request_context_branch'])
    expect(ctx.tools.schemas(minimal.agent).map(tool => tool.name)).toEqual([])
    const denied = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('branch-tool-out-of-scope'), name: 'request_context_branch',
      arguments: { reason: 'Do not reach the other Agent' }, agent: minimal.agent })
    expect(denied.isError).toBe(true)
    expect(denied.error?.message).toContain('unknown tool')
    selected.agent.session.append('turn/start', { turn: 1 })
    selected.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Please move this exchange into a branch.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const requested = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('branch-tool-scoped-request'), name: 'request_context_branch',
      arguments: { reason: 'The user requested a separate branch.' }, agent: selected.agent })
    expect(requested.isError).toBe(false)
    expect(requested.value).toEqual({ status: 'pending_user_confirmation' })
    selected.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await selected.dispose()
    expect(ctx.tools.schemas(selected.agent).map(tool => tool.name)).toEqual([])
    expect(ctx.tools.schemas(minimal.agent).map(tool => tool.name)).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps a preset consumer dormant when the Host does not compose Contextify', async () => {
  const ctx = new Context()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const handle = await ctx.agents.create({ sessionId: SessionId('branch-tool-no-host'),
      setup: async (agentCtx) => { await agentCtx.plugin(ContextifyBranchTool) } })
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([])
    expect(ctx.tools.schemas(handle.agent).map(tool => tool.name)).toEqual([])
  } finally {
    await ctx.fiber.dispose()
  }
})

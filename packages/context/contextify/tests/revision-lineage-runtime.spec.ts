/** Legacy and fresh Contextify Sessions in the real Harness Agent Loop. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import { createUserMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import ContextifyService from '../src/index.ts'
import ContextifyRevisionLineageRuntime, {
  REVISION_LINEAGE_COMPILER_ID,
} from '../src/revision-lineage-runtime.ts'
import { CONTEXTIFY_DEFAULT_SETTINGS } from '../src/types.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

class AnswerAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of textResponse('Acknowledged.')) yield chunk
  }
}

it('leaves legacy answers on the ordinary surface compiler while recording new Sessions from their first request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-contextify-lineage-rollout-'))
  const ctx = new Context()
  const adapter = new AnswerAdapter()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ContextCompilerRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: dir })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(ContextifyService)
    const contextify = ctx.contextify as unknown as {
      promptSettings: () => typeof CONTEXTIFY_DEFAULT_SETTINGS
    }
    contextify.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS,
      automaticBranchReview: false })
    ctx.llm.registerAdapter(['mock'], adapter)

    const legacy = await ctx.agentLoop.create(SessionId('lineage-rollout-legacy'), {
      provider: 'mock', model: 'mock',
    }, { cwd: dir })
    const send = async (agent: typeof legacy, message: string, expectedTurns: number) => {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: message }], source: { kind: 'user' },
      }))
      await vi.waitFor(() => {
        expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end'))
          .toHaveLength(expectedTurns)
        expect(agent.status).toBe('idle')
      }, { timeout: 10_000 })
    }
    await send(legacy, 'Earlier answer without read set', 1)
    expect(ctx.contextCompiler.descriptor(legacy.session).id).toBe('surface')

    await ctx.plugin(ContextifyRevisionLineageRuntime)
    await send(legacy, 'Continue the old Session', 2)
    expect(ctx.contextCompiler.descriptor(legacy.session).id).toBe('surface')
    expect(legacy.session.snapshotEvents().filter(event =>
      event.type === 'contextify/request-read-set')).toHaveLength(0)

    const fresh = await ctx.agentLoop.create(SessionId('lineage-rollout-fresh'), {
      provider: 'mock', model: 'mock',
    }, { cwd: dir })
    await send(fresh, 'First protected request', 1)
    expect(ctx.contextCompiler.descriptor(fresh.session).id).toBe(REVISION_LINEAGE_COMPILER_ID)
    expect(fresh.session.snapshotEvents().filter(event =>
      event.type === 'contextify/request-read-set')).toHaveLength(1)
    expect(adapter.requests.filter(request => request.sessionId === legacy.id)).toHaveLength(2)
    expect(adapter.requests.filter(request => request.sessionId === fresh.id)).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

it('lists selected sources and starts a source-bound worker while rejecting ordinary delegation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-contextify-lineage-tool-'))
  const ctx = new Context()
  const adapter = new AnswerAdapter()
  try {
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(ContextCompilerRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: dir })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    await ctx.plugin(ContextifyService)
    await ctx.plugin(ContextifyRevisionLineageRuntime)
    const contextify = ctx.contextify as unknown as {
      promptSettings: () => typeof CONTEXTIFY_DEFAULT_SETTINGS
    }
    contextify.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS,
      automaticBranchReview: false })
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId('lineage-tool-parent'), {
      provider: 'mock', model: 'mock',
    }, { cwd: dir })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compare the policy pages' }],
      source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(parent.status).toBe('idle')
    }, { timeout: 10_000 })
    expect(ctx.contextCompiler.descriptor(parent.session).id).toBe(REVISION_LINEAGE_COMPILER_ID)
    const source = parent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.source.kind === 'user')
    if (source === undefined) throw new Error('human source missing')
    const list = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('lineage-list'), name: 'list_context_sources', arguments: {}, agent: parent })
    expect(list.isError).toBe(false)
    if (typeof list.value !== 'string') throw new Error('Source listing must return JSON text')
    const listed: unknown = JSON.parse(list.value)
    expect(listed).toHaveProperty('sources', expect.arrayContaining([{ seq: source.seq, kind: 'human',
      preview: 'Compare the policy pages' }]))

    ctx.tools.register(defineTool({ name: 'subagent', description: 'ordinary delegation fixture',
      parameters: {}, output: { schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('must not start'),
    }))
    const ordinary = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('lineage-ordinary'), name: 'subagent', arguments: {}, agent: parent })
    expect(ordinary.isError).toBe(true)
    expect(ordinary.error?.message).toContain('source binding')

    const delegated = await ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('lineage-bound'), name: 'delegate_context_sources',
      arguments: { source_event_seqs: [source.seq] }, agent: parent })
    expect(delegated.isError).toBe(false)
    expect(delegated.value).toHaveProperty('subagentId', expect.any(String))
    expect(parent.session.snapshotEvents().filter(event =>
      event.type === 'contextify/delegation-slice').map(event => event.data.sourceEventSeqs))
      .toEqual([[source.seq]])
    if (typeof delegated.value !== 'object' || delegated.value === null || !('subagentId' in delegated.value)
      || typeof delegated.value.subagentId !== 'string') throw new Error('Delegation did not return a worker id')
    const childId = SessionId(delegated.value.subagentId)
    await vi.waitFor(() => {
      expect(adapter.requests.some(request => request.sessionId === childId)).toBe(true)
    }, { timeout: 10_000 })
    expect(JSON.stringify(adapter.requests.find(request => request.sessionId === childId)?.messages))
      .toContain('Compare the policy pages')
  } finally {
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

/** Real Harness services with an in-process model fixture; no provider API. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import ContextifyService from '../src/index.ts'
import ContextifyRevisionLineageRuntime from '../src/revision-lineage-runtime.ts'

class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    for (const chunk of textResponse('Recorded source acknowledged.')) yield chunk
  }
}

/** Real lifecycle services; a supplied storage root belongs to the caller and survives close. */
export async function lineageHarness(runtime = false, storage?: { root: string; resumeParent?: boolean }) {
  const ctx = new Context()
  const root = storage?.root ?? await mkdtemp(join(tmpdir(), 'contextify-lineage-coverage-'))
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(ContextCompilerRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ContextifyService)
  if (runtime) await ctx.plugin(ContextifyRevisionLineageRuntime)
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const parentHandle = storage?.resumeParent === true
    ? await ctx.agents.resume({ resumeSessionId: SessionId('coverage-parent') })
    : await ctx.agents.create({ sessionId: SessionId('coverage-parent'),
      agentOptions: { provider: 'mock', model: 'mock' }, meta: { cwd: root } })
  const parent = parentHandle.agent
  return {
    ctx, parent, adapter, disposeParent: () => parentHandle.dispose(),
    close: async () => {
      await ctx.fiber.dispose()
      if (storage === undefined) await rm(root, { recursive: true, force: true })
    },
  }
}

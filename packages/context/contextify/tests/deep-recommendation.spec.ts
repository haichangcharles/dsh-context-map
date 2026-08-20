import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import {
  buildDeepRecommendationSnapshot,
  cleanupStaleDeepSnapshots,
  deepSnapshotGuard,
  runDeepRecommendation,
  serializeDeepRecommendationSnapshot,
  withDeepSnapshot,
} from '../src/deep-recommendation.ts'
import type { ContextFamilyGraph, ContextPlanSnapshot } from '../src/types.ts'

const root = 'deep-root' as SessionId
const sibling = 'deep-sibling' as SessionId
const graph: ContextFamilyGraph = {
  rootSessionId: root,
  activeSessionId: root,
  sessions: [
    { id: root, seedLength: 0, depth: 0, tipNodeId: 'root:2' },
    { id: sibling, parentSessionId: root, seedLength: 1, depth: 1, tipNodeId: 'sibling:1' },
  ],
  nodes: [
    {
      id: 'root:1', owner: { sessionId: root, seq: 1 }, role: 'user', preview: 'short user preview',
      time: 1, branchAtSeq: 2, sessionIds: [root, sibling], activeEventSeq: 1,
    },
    {
      id: 'root:2', owner: { sessionId: root, seq: 2 }, role: 'assistant', preview: 'short answer preview',
      time: 2, branchAtSeq: 3, sessionIds: [root], activeEventSeq: 2,
    },
    {
      id: 'sibling:1', owner: { sessionId: sibling, seq: 1 }, role: 'user', preview: 'off-path preview',
      time: 3, branchAtSeq: 2, sessionIds: [sibling], activeEventSeq: null,
    },
  ],
  edges: [
    { id: 'edge-1', source: 'root:1', target: 'root:2', sessionIds: [root] },
    { id: 'edge-2', source: 'root:1', target: 'sibling:1', sessionIds: [sibling] },
  ],
}
const plan: ContextPlanSnapshot = {
  kind: 'contextify/plan',
  version: 3,
  revision: 7,
  stateRevision: 7,
  history: { past: [6], future: [] },
  excluded: [{ nodeId: 'root:1', eventSeq: 1 }],
  included: [{ nodeId: 'sibling:1', snapshotSeq: 10, position: 1 }],
  replacements: [{
    nodeId: 'root:2', snapshotSeq: 11, originalEventSeq: 2,
    role: 'assistant', kind: 'placeholder', reason: 'obsolete',
  }],
}

function snapshot() {
  return buildDeepRecommendationSnapshot({
    graph,
    graphRevision: 'graph-7',
    plan,
    objective: 'prepare the next architecture decision',
    contents: {
      'root:1': 'full user input that is not truncated',
      'root:2': '[Placeholder: intentionally empty]',
      'sibling:1': 'full sibling input from another branch',
    },
    effectiveIncludedNodeIds: ['root:2', 'sibling:1'],
  })
}

function registerNoopDeepTools(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({
    name: 'read', description: '',
    parameters: { file_path: { type: 'string', required: true } },
    async execute() { return [{ type: 'text', text: '' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'grep', description: '',
    parameters: { path: { type: 'string', required: true } },
    async execute() { return [{ type: 'text', text: '' }] },
  }))
}

describe('Deep Context recommendation snapshot', () => {
  it('allows read and grep only against the exact frozen snapshot path', () => {
    const filePath = '/private/context-review/context-tree.jsonl'
    const guard = deepSnapshotGuard(filePath)
    const execution = (name: string, args: Record<string, unknown>): ToolExecution => ({
      id: `call-${name}`,
      name,
      arguments: args,
    } as ToolExecution)

    expect(guard(execution('read', { file_path: filePath }))).toBeUndefined()
    expect(guard(execution('read', { file_path: 'context-tree.jsonl' }))).toBeUndefined()
    expect(guard(execution('grep', { path: filePath, pattern: 'node' }))).toBeUndefined()
    expect(guard(execution('grep', { path: 'context-tree.jsonl', pattern: 'node' }))).toBeUndefined()
    expect(guard(execution('submit_context_recommendation', {}))).toBeUndefined()

    const denied = 'Deep Context review may access only its frozen Context Tree snapshot'
    expect(guard(execution('read', { file_path: '/workspace/secret.txt' }))).toBe(denied)
    expect(guard(execution('read', { file_path: '../secret.txt' }))).toBe(denied)
    expect(guard(execution('grep', { path: dirname(filePath), pattern: 'node' }))).toBe(denied)
    expect(guard(execution('grep', { path: '.', pattern: 'node' }))).toBe(denied)
    expect(guard(execution('read', {}))).toBe(denied)
  })

  it('runs one restricted child that reads and greps the snapshot before structured submission', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.tools.register(defineContentToolFixture({
      name: 'read',
      description: 'Read one file.',
      parameters: { file_path: { type: 'string', required: true } },
      async execute(args, exec) {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('read requires a session cwd')
        return [{ type: 'text', text: await readFile(resolve(cwd, args.file_path), 'utf8') }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'grep',
      description: 'Search one file.',
      parameters: {
        path: { type: 'string', required: true },
        pattern: { type: 'string', required: true },
      },
      async execute(args, exec) {
        const cwd = exec.agent?.session.header.cwd
        if (cwd === undefined) throw new Error('grep requires a session cwd')
        const value = await readFile(resolve(cwd, args.path), 'utf8')
        return [{ type: 'text', text: value.split('\n').filter(line => line.includes(args.pattern)).join('\n') }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'workspace_secret',
      description: 'A capability the child must never see.',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'secret' }] },
    }))
    const adapter = new MockAdapter([
      (options) => {
        expect(options.tools?.map(tool => tool.name).sort()).toEqual([
          'grep', 'read', 'submit_context_recommendation',
        ])
        return toolCallResponse('deep-read', 'read', { file_path: 'context-tree.jsonl' })
      },
      toolCallResponse('deep-grep', 'grep', { path: 'context-tree.jsonl', pattern: 'sibling:1' }),
      toolCallResponse('deep-submit', 'submit_context_recommendation', {
        exclude: [{ nodeId: 'root:1', reason: 'superseded' }],
        include: [{ nodeId: 'sibling:1', reason: 'relevant sibling finding' }],
        archive: [],
      }),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(root, { provider: 'mock', model: 'mock' })
    let childId: SessionId | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) childId = agent.id
    })
    try {
      const decision = await runDeepRecommendation({
        parent,
        snapshot: snapshot(),
        signal: new AbortController().signal,
      })
      expect(decision).toEqual({
        exclude: [{ nodeId: 'root:1', reason: 'superseded' }],
        include: [{ nodeId: 'sibling:1', reason: 'relevant sibling finding' }],
        archive: [],
      })
      expect(childId).toBeDefined()
      expect(ctx.agents.get(childId!)).toBeUndefined()
      expect(adapter.requests).toHaveLength(3)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('surfaces an exact-path denial to the child without executing the read body', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    let reads = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'read', description: '',
      parameters: { file_path: { type: 'string', required: true } },
      async execute() { reads += 1; return [{ type: 'text', text: 'should not run' }] },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'grep', description: '',
      parameters: { path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: '' }] },
    }))
    const adapter = new MockAdapter([
      toolCallResponse('escape', 'read', { file_path: '../workspace-secret.txt' }),
      (options) => {
        expect(JSON.stringify(options.messages)).toContain(
          'Deep Context review may access only its frozen Context Tree snapshot',
        )
        return toolCallResponse('submit-after-denial', 'submit_context_recommendation', {
          exclude: [], include: [], archive: [],
        })
      },
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(root, { provider: 'mock', model: 'mock' })
    try {
      await expect(runDeepRecommendation({
        parent, snapshot: snapshot(), signal: new AbortController().signal,
      })).resolves.toEqual({ exclude: [], include: [], archive: [] })
      expect(reads).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed when the child finishes without structured submission', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    registerNoopDeepTools(ctx)
    const adapter = new MockAdapter([textResponse('plain prose is not a submission')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(root, { provider: 'mock', model: 'mock' })
    let childId: SessionId | undefined
    let childDirectory = ''
    ctx.on('agent/created', ({ agent }) => {
      if (agent === parent) return
      childId = agent.id
      childDirectory = agent.session.header.cwd ?? ''
    })
    try {
      await expect(runDeepRecommendation({
        parent, snapshot: snapshot(), signal: new AbortController().signal,
      })).rejects.toThrow('without a structured submission')
      expect(ctx.agents.get(childId!)).toBeUndefined()
      await expect(stat(childDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cancels a running child and removes both Agent and temporary directory', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    registerNoopDeepTools(ctx)
    const adapter = new MockAdapter(['hang'])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(root, { provider: 'mock', model: 'mock' })
    const controller = new AbortController()
    let childId: SessionId | undefined
    let childDirectory = ''
    let announce!: () => void
    const created = new Promise<void>((resolveCreated) => { announce = resolveCreated })
    ctx.on('agent/created', ({ agent }) => {
      if (agent === parent) return
      childId = agent.id
      childDirectory = agent.session.header.cwd ?? ''
      announce()
    })
    try {
      const running = runDeepRecommendation({ parent, snapshot: snapshot(), signal: controller.signal })
      await created
      controller.abort('test cancellation')
      await expect(running).rejects.toMatchObject({ name: 'AbortError' })
      expect(ctx.agents.get(childId!)).toBeUndefined()
      await expect(stat(childDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('times out a hung child and removes both Agent and temporary directory', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    registerNoopDeepTools(ctx)
    const adapter = new MockAdapter(['hang'])
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = ctx.agentLoop.create(root, { provider: 'mock', model: 'mock' })
    let childId: SessionId | undefined
    let childDirectory = ''
    ctx.on('agent/created', ({ agent }) => {
      if (agent === parent) return
      childId = agent.id
      childDirectory = agent.session.header.cwd ?? ''
    })
    try {
      await expect(runDeepRecommendation({
        parent, snapshot: snapshot(), signal: new AbortController().signal, timeoutMs: 10,
      })).rejects.toThrow(/timed out/i)
      expect(ctx.agents.get(childId!)).toBeUndefined()
      await expect(stat(childDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes the complete visible graph with full text, topology, and plan state', () => {
    const value = snapshot()
    expect(value).toMatchObject({
      version: 1,
      rootSessionId: root,
      activeSessionId: root,
      graphRevision: 'graph-7',
      planRevision: 7,
      objective: 'prepare the next architecture decision',
    })
    expect(value.nodes).toMatchObject([
      {
        id: 'root:1', text: 'full user input that is not truncated', activePath: true,
        included: false, explicitMode: 'exclude', archived: false,
        incoming: [], outgoing: ['root:2', 'sibling:1'],
      },
      {
        id: 'root:2', included: true, explicitMode: 'natural', archived: true,
        incoming: ['root:1'], outgoing: [],
      },
      {
        id: 'sibling:1', activePath: false, included: true, explicitMode: 'include',
      },
    ])

    const lines = serializeDeepRecommendationSnapshot(value).trimEnd().split('\n')
    expect(lines).toHaveLength(graph.nodes.length + 1)
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ kind: 'context-tree', version: 1, nodeCount: 3 })
    expect(lines.slice(1).map(line => (JSON.parse(line) as { kind: unknown }).kind))
      .toEqual(['node', 'node', 'node'])
  })

  it('owns the private file through success and callback failure', async () => {
    let successDirectory = ''
    const result = await withDeepSnapshot(snapshot(), new AbortController().signal, async ({ directory, filePath }) => {
      successDirectory = directory
      expect(JSON.parse((await readFile(filePath, 'utf8')).split('\n')[0] ?? '')).toMatchObject({ kind: 'context-tree' })
      if (process.platform !== 'win32') {
        expect((await stat(directory)).mode & 0o777).toBe(0o700)
        expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      }
      return 42
    })
    expect(result).toBe(42)
    await expect(stat(successDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

    let failedDirectory = ''
    await expect(withDeepSnapshot(snapshot(), new AbortController().signal, ({ directory }) => {
      failedDirectory = directory
      throw new Error('operation failed')
    })).rejects.toThrow('operation failed')
    await expect(stat(failedDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans the private file when cancellation wins after creation', async () => {
    const controller = new AbortController()
    let directory = ''
    await expect(withDeepSnapshot(snapshot(), controller.signal, async (location) => {
      directory = location.directory
      controller.abort('cancel test')
      await Promise.resolve()
      return 'unreachable'
    })).rejects.toThrow(/cancel/i)
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes only expired Contextify directories from the configured temporary root', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-contextify-cleanup-test-'))
    const oldDirectory = await mkdtemp(join(temporaryRoot, 'dsh-contextify-old-'))
    const freshDirectory = await mkdtemp(join(temporaryRoot, 'dsh-contextify-fresh-'))
    const now = Date.now()
    try {
      await utimes(oldDirectory, new Date(now - 10_000), new Date(now - 10_000))
      await cleanupStaleDeepSnapshots({ temporaryRoot, now, retentionMs: 5_000 })
      await expect(stat(oldDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(freshDirectory)).resolves.toBeDefined()
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })
})

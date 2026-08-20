import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  buildDeepRecommendationSnapshot,
  cleanupStaleDeepSnapshots,
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

describe('Deep Context recommendation snapshot', () => {
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
    expect(lines.slice(1).map(line => JSON.parse(line).kind)).toEqual(['node', 'node', 'node'])
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

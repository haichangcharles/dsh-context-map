/** Full-tree projection and private temporary-file lifecycle for Deep review. */
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContextFamilyGraph, ContextPlanSnapshot } from './types.ts'

const TEMP_DIRECTORY_PREFIX = 'dsh-contextify-'
const SNAPSHOT_FILE_NAME = 'context-tree.jsonl'

/** Crash-retention ceiling for private Contextify snapshot directories. */
export const DEEP_RECOMMENDATION_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

/** One complete visible Context Map node supplied to Deep review. */
export interface DeepRecommendationNode {
  readonly kind: 'node'
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly ownerSessionId: string
  readonly sessionIds: readonly string[]
  readonly activePath: boolean
  readonly included: boolean
  readonly explicitMode: 'natural' | 'include' | 'exclude'
  readonly archived: boolean
  readonly incoming: readonly string[]
  readonly outgoing: readonly string[]
}

/** Frozen complete Context Tree at one graph and Context Plan revision. */
export interface DeepRecommendationSnapshot {
  readonly version: 1
  readonly rootSessionId: string
  readonly activeSessionId: string
  readonly graphRevision: string
  readonly planRevision: number
  readonly objective: string
  readonly nodes: readonly DeepRecommendationNode[]
}

export interface DeepSnapshotLocation {
  readonly directory: string
  readonly filePath: string
}

interface BuildDeepRecommendationSnapshotRequest {
  readonly graph: ContextFamilyGraph
  readonly graphRevision: string
  readonly plan: ContextPlanSnapshot
  readonly objective: string
  readonly contents: Readonly<Record<string, string>>
  readonly effectiveIncludedNodeIds: readonly string[]
}

function cancelled(): Error {
  const error = new Error('Deep Context recommendation was cancelled')
  error.name = 'AbortError'
  return error
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled()
}

/** Build the untruncated full-tree value written for one Deep review. */
export function buildDeepRecommendationSnapshot(
  request: BuildDeepRecommendationSnapshotRequest,
): DeepRecommendationSnapshot {
  const included = new Set(request.effectiveIncludedNodeIds)
  const explicitIncluded = new Set(request.plan.included.map(item => item.nodeId))
  const explicitExcluded = new Set(request.plan.excluded.map(item => item.nodeId))
  const archived = new Set(request.plan.replacements.map(item => item.nodeId))
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of request.graph.edges) {
    incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge.source])
    outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge.target])
  }
  const nodes = request.graph.nodes.map((node): DeepRecommendationNode => Object.freeze({
    kind: 'node',
    id: node.id,
    role: node.role,
    text: request.contents[node.id] ?? node.preview,
    ownerSessionId: node.owner.sessionId,
    sessionIds: Object.freeze([...node.sessionIds]),
    activePath: node.sessionIds.includes(request.graph.activeSessionId),
    included: included.has(node.id),
    explicitMode: explicitIncluded.has(node.id)
      ? 'include'
      : explicitExcluded.has(node.id) ? 'exclude' : 'natural',
    archived: archived.has(node.id),
    incoming: Object.freeze([...(incoming.get(node.id) ?? [])]),
    outgoing: Object.freeze([...(outgoing.get(node.id) ?? [])]),
  }))
  return Object.freeze({
    version: 1,
    rootSessionId: request.graph.rootSessionId,
    activeSessionId: request.graph.activeSessionId,
    graphRevision: request.graphRevision,
    planRevision: request.plan.revision,
    objective: request.objective,
    nodes: Object.freeze(nodes),
  })
}

/** Serialize metadata followed by one JSON node per line for bounded reads and grep. */
export function serializeDeepRecommendationSnapshot(snapshot: DeepRecommendationSnapshot): string {
  const header = {
    kind: 'context-tree',
    version: snapshot.version,
    rootSessionId: snapshot.rootSessionId,
    activeSessionId: snapshot.activeSessionId,
    graphRevision: snapshot.graphRevision,
    planRevision: snapshot.planRevision,
    objective: snapshot.objective,
    nodeCount: snapshot.nodes.length,
  }
  return `${[JSON.stringify(header), ...snapshot.nodes.map(node => JSON.stringify(node))].join('\n')}\n`
}

/**
 * Own one private snapshot directory for exactly one asynchronous operation.
 * The directory is removed after every success, failure, or cancellation path.
 */
export async function withDeepSnapshot<T>(
  snapshot: DeepRecommendationSnapshot,
  signal: AbortSignal,
  operation: (location: DeepSnapshotLocation) => Promise<T> | T,
): Promise<T> {
  assertNotCancelled(signal)
  const directory = await mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX))
  const filePath = join(directory, SNAPSHOT_FILE_NAME)
  try {
    if (process.platform !== 'win32') await chmod(directory, 0o700)
    await writeFile(filePath, serializeDeepRecommendationSnapshot(snapshot), { encoding: 'utf8', mode: 0o600 })
    assertNotCancelled(signal)
    const result = await operation(Object.freeze({ directory, filePath }))
    assertNotCancelled(signal)
    return result
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

interface CleanupStaleDeepSnapshotsOptions {
  readonly temporaryRoot?: string
  readonly now?: number
  readonly retentionMs?: number
}

/** Remove only expired Contextify-owned directories after an unclean process exit. */
export async function cleanupStaleDeepSnapshots(
  options: CleanupStaleDeepSnapshotsOptions = {},
): Promise<void> {
  const temporaryRoot = options.temporaryRoot ?? tmpdir()
  const now = options.now ?? Date.now()
  const retentionMs = options.retentionMs ?? DEEP_RECOMMENDATION_TEMP_RETENTION_MS
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
    throw new RangeError('Deep snapshot retention must be a positive number')
  }
  const entries = await readdir(temporaryRoot, { withFileTypes: true })
  await Promise.all(entries.flatMap((entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_DIRECTORY_PREFIX)) return []
    const directory = join(temporaryRoot, entry.name)
    return [stat(directory)
      .then(info => now - info.mtimeMs > retentionMs
        ? rm(directory, { recursive: true, force: true })
        : undefined)
      .catch((cause: unknown) => {
        const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
        if (code !== 'ENOENT') throw cause
      })]
  }))
}

/** Pure projection of native Session lineage into a canonical message graph. */
import type { Message, ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ContextFamilyGraph,
  ContextFamilyGraphEdge,
  ContextFamilyGraphNode,
  ContextFamilyInspection,
  ContextFamilySession,
  ContextMessageRef,
} from './types.ts'

interface MutableNode {
  readonly id: string
  readonly owner: ContextMessageRef
  readonly role: 'user' | 'assistant'
  readonly preview: string
  readonly time: number
  readonly branchAtSeq: number | null
  readonly sessionIds: Set<SessionId>
  activeEventSeq: number | null
}

function branchBoundaries(events: readonly SessionEvent[]): ReadonlyMap<number, number> {
  const pending: number[] = []
  const boundaries = new Map<number, number>()
  for (const event of events) {
    if (visibleMessage(event) !== null) pending.push(event.seq)
    if (event.type !== 'turn/end') continue
    for (const seq of pending) boundaries.set(seq, event.seq)
    pending.length = 0
  }
  return boundaries
}

interface MutableEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sessionIds: Set<SessionId>
}

function visibleMessage(event: SessionEvent): { role: 'user' | 'assistant'; message: Message } | null {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return null
  if (event.surfaceOp !== 'append') return null
  if (event.type === 'user/message') {
    return event.data.source.kind === 'user' ? { role: 'user', message: event.data } : null
  }
  const visible = event.data.message.content.some(block => block.type === 'text' || block.type === 'image')
  return visible ? { role: 'assistant', message: event.data.message } : null
}

function blockPreview(block: ContentBlock): string[] {
  if (block.type === 'text') return [block.text]
  if (block.type === 'image') return ['[Image]']
  return []
}

function preview(message: Message): string {
  return Array.from(message.content.flatMap(blockPreview).join('\n')).slice(0, 240).join('')
}

function sameCopiedEvent(left: SessionEvent | undefined, right: SessionEvent): boolean {
  if (left === undefined || left.type !== right.type || left.time !== right.time) return false
  const leftEnvelope = left as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: unknown }
  const rightEnvelope = right as SessionEvent & { surfaceOp?: unknown; sourceEventSeqs?: unknown }
  return JSON.stringify({
    data: leftEnvelope.data,
    surfaceOp: leftEnvelope.surfaceOp,
    sourceEventSeqs: leftEnvelope.sourceEventSeqs,
  }) === JSON.stringify({
    data: rightEnvelope.data,
    surfaceOp: rightEnvelope.surfaceOp,
    sourceEventSeqs: rightEnvelope.sourceEventSeqs,
  })
}

function canonicalOwner(
  inspection: ContextFamilyInspection,
  event: SessionEvent,
  byId: ReadonlyMap<SessionId, ContextFamilyInspection>,
): ContextMessageRef {
  let cursor = inspection
  while (cursor.meta.parentSession !== undefined && event.seq < (cursor.meta.seedLength ?? 0)) {
    const parent = byId.get(cursor.meta.parentSession)
    if (parent === undefined || !sameCopiedEvent(parent.events[event.seq], event)) break
    cursor = parent
  }
  return { sessionId: cursor.meta.id, seq: event.seq }
}

function familyRoot(
  active: ContextFamilyInspection,
  byId: ReadonlyMap<SessionId, ContextFamilyInspection>,
): ContextFamilyInspection {
  let cursor = active
  const seen = new Set<SessionId>()
  while (cursor.meta.parentSession !== undefined && !seen.has(cursor.meta.id)) {
    seen.add(cursor.meta.id)
    const parent = byId.get(cursor.meta.parentSession)
    if (parent === undefined) break
    cursor = parent
  }
  return cursor
}

function orderedFamily(
  root: ContextFamilyInspection,
  inspections: readonly ContextFamilyInspection[],
): Array<{ inspection: ContextFamilyInspection; depth: number }> {
  const children = new Map<SessionId, ContextFamilyInspection[]>()
  for (const inspection of inspections) {
    const parent = inspection.meta.parentSession
    if (parent === undefined) continue
    const list = children.get(parent) ?? []
    list.push(inspection)
    children.set(parent, list)
  }
  const ordered: Array<{ inspection: ContextFamilyInspection; depth: number }> = []
  const visited = new Set<SessionId>()
  const walk = (inspection: ContextFamilyInspection, depth: number): void => {
    if (visited.has(inspection.meta.id)) return
    visited.add(inspection.meta.id)
    ordered.push({ inspection, depth })
    for (const child of children.get(inspection.meta.id) ?? []) walk(child, depth + 1)
  }
  walk(root, 0)
  return ordered
}

/**
 * Project one active Session's connected native fork family.
 * @param input - Active identity and immutable Session inspections.
 * @returns A frozen graph with inherited messages de-duplicated by their earliest owner.
 */
export function projectSessionFamily(input: {
  readonly activeSessionId: SessionId
  readonly sessions: readonly ContextFamilyInspection[]
}): ContextFamilyGraph {
  const byId = new Map(input.sessions.map(inspection => [inspection.meta.id, inspection]))
  const active = byId.get(input.activeSessionId)
  if (active === undefined) throw new Error(`active Session "${input.activeSessionId}" is unavailable`)
  const root = familyRoot(active, byId)
  const ordered = orderedFamily(root, input.sessions)
  const nodes = new Map<string, MutableNode>()
  const edges = new Map<string, MutableEdge>()
  const sessions: ContextFamilySession[] = []

  for (const { inspection, depth } of ordered) {
    const path: string[] = []
    const boundaries = branchBoundaries(inspection.events)
    for (const event of inspection.events) {
      const visible = visibleMessage(event)
      if (visible === null) continue
      const owner = canonicalOwner(inspection, event, byId)
      const id = `${owner.sessionId}:${String(owner.seq)}`
      let node = nodes.get(id)
      if (node === undefined) {
        node = {
          id,
          owner,
          role: visible.role,
          preview: preview(visible.message),
          time: event.time,
          branchAtSeq: boundaries.get(event.seq) ?? null,
          sessionIds: new Set(),
          activeEventSeq: null,
        }
        nodes.set(id, node)
      }
      node.sessionIds.add(inspection.meta.id)
      if (inspection.meta.id === input.activeSessionId) node.activeEventSeq = event.seq
      const prior = path.at(-1)
      if (prior !== undefined && prior !== id) {
        const edgeId = `${prior}->${id}`
        let edge = edges.get(edgeId)
        if (edge === undefined) {
          edge = { id: edgeId, source: prior, target: id, sessionIds: new Set() }
          edges.set(edgeId, edge)
        }
        edge.sessionIds.add(inspection.meta.id)
      }
      path.push(id)
    }
    sessions.push(Object.freeze({
      id: inspection.meta.id,
      ...(inspection.meta.parentSession === undefined
        ? {}
        : { parentSessionId: inspection.meta.parentSession }),
      seedLength: inspection.meta.seedLength ?? 0,
      depth,
      tipNodeId: path.at(-1) ?? null,
    }))
  }

  const frozenNodes: ContextFamilyGraphNode[] = [...nodes.values()].map(node => Object.freeze({
    id: node.id,
    owner: Object.freeze({ ...node.owner }),
    role: node.role,
    preview: node.preview,
    time: node.time,
    branchAtSeq: node.branchAtSeq,
    sessionIds: Object.freeze([...node.sessionIds]),
    activeEventSeq: node.activeEventSeq,
  }))
  const frozenEdges: ContextFamilyGraphEdge[] = [...edges.values()].map(edge => Object.freeze({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sessionIds: Object.freeze([...edge.sessionIds]),
  }))
  return Object.freeze({
    rootSessionId: root.meta.id,
    activeSessionId: input.activeSessionId,
    sessions: Object.freeze(sessions),
    nodes: Object.freeze(frozenNodes),
    edges: Object.freeze(frozenEdges),
  })
}

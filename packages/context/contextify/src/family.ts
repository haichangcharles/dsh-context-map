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
  readonly role: ContextFamilyGraphNode['role']
  readonly sourceKind: NonNullable<ContextFamilyGraphNode['sourceKind']>
  readonly webAction?: ContextFamilyGraphNode['webAction']
  readonly preview: string
  readonly time: number
  readonly branchAtSeq: number | null
  readonly sessionIds: Set<SessionId>
  activeEventSeq: number | null
}

interface WebCallRef {
  readonly action: NonNullable<ContextFamilyGraphNode['webAction']>
  readonly seq: number
}

function branchBoundaries(events: readonly SessionEvent[], webCalls: ReadonlyMap<string, WebCallRef>): ReadonlyMap<number, number> {
  const pending: number[] = []
  const boundaries = new Map<number, number>()
  for (const event of events) {
    if (visibleMessage(event, webCalls) !== null) pending.push(event.seq)
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

interface VisibleMessage {
  readonly role: ContextFamilyGraphNode['role']
  readonly sourceKind: NonNullable<ContextFamilyGraphNode['sourceKind']>
  readonly webAction?: ContextFamilyGraphNode['webAction']
  readonly message: Message
}

function visibleMessage(event: SessionEvent, webCalls: ReadonlyMap<string, WebCallRef>): VisibleMessage | null {
  if (event.surfaceOp !== 'append') return null
  if (event.type === 'user/message') {
    if (event.data.source.kind === 'user') {
      return { role: 'user', sourceKind: 'chat', message: event.data }
    }
    if (event.data.source.kind === 'agent-message' || event.data.source.kind === 'subagent-settled') {
      return { role: 'user', sourceKind: 'worker', message: event.data }
    }
    return null
  }
  if (event.type === 'tool/result') {
    const call = webCalls.get(event.data.message.source.callId)
    if (call === undefined) return null
    const blocks = event.data.message.content
    const result = blocks.length === 1 && blocks[0]?.type === 'tool-result'
      && blocks[0].toolCallId === event.data.message.source.callId && !blocks[0].isError
      ? blocks[0].content : null
    const importable = event.sourceEventSeqs?.length === 1
      && event.sourceEventSeqs[0] === call.seq
      && result !== null && result.length > 0
      && result.every(block => block.type === 'text')
    return { role: 'tool', sourceKind: 'web',
      ...(importable ? { webAction: call.action } : {}), message: event.data.message }
  }
  if (event.type !== 'assistant/message') return null
  const visible = event.data.message.content.some(block => block.type === 'text' || block.type === 'image')
  return visible ? { role: 'assistant', sourceKind: 'chat', message: event.data.message } : null
}

interface ProjectedMessage {
  readonly event: SessionEvent
  readonly visible: VisibleMessage
}

/**
 * Select the conversational surface of each native Turn.
 * Human inputs are visible while a Turn is running, but assistant text is
 * committed only once the Turn completes and only from its last visible
 * assistant step. This keeps ReAct narration and intermediate questions out
 * of the Map without rewriting the Session log used by compilation.
 */
function projectedMessages(events: readonly SessionEvent[]): ProjectedMessage[] {
  const projected: ProjectedMessage[] = []
  let finalAssistant: ProjectedMessage | undefined
  const webCalls = new Map<string, WebCallRef>(events.flatMap(event =>
    event.type === 'tool/call' && (event.data.name === 'web_fetch' || event.data.name === 'web_search')
      ? [[event.data.callId, { action: event.data.name, seq: event.seq }] as const] : []))
  for (const event of events) {
    if (event.type === 'turn/start') {
      finalAssistant = undefined
      continue
    }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind === 'completed' && finalAssistant !== undefined) {
        projected.push(finalAssistant)
      }
      finalAssistant = undefined
      continue
    }
    const visible = visibleMessage(event, webCalls)
    if (visible === null) continue
    if (visible.sourceKind !== 'chat' || visible.role === 'user') projected.push({ event, visible })
    else finalAssistant = { event, visible }
  }
  return projected
}

function blockPreview(block: ContentBlock): string[] {
  if (block.type === 'text') return [block.text]
  if (block.type === 'image') return ['[Image]']
  if (block.type === 'tool-result') return block.content.flatMap(blockPreview)
  return []
}

function preview(message: Message): string {
  return Array.from(message.content.flatMap(blockPreview).join('\n')).slice(0, 240).join('')
}

function sameCopiedEvent(left: SessionEvent | undefined, right: SessionEvent): boolean {
  if (left === undefined || left.type !== right.type || left.time !== right.time) return false
  return JSON.stringify({
    data: left.data,
    surfaceOp: left.surfaceOp,
    sourceEventSeqs: left.sourceEventSeqs,
  }) === JSON.stringify({
    data: right.data,
    surfaceOp: right.surfaceOp,
    sourceEventSeqs: right.sourceEventSeqs,
  })
}

function canonicalOwner(
  inspection: ContextFamilyInspection,
  event: SessionEvent,
  byId: ReadonlyMap<SessionId, ContextFamilyInspection>,
  cache: Map<SessionId, Map<number, ContextMessageRef>>,
): ContextMessageRef {
  let cursor = inspection
  const traversed: SessionId[] = []
  let owner: ContextMessageRef | undefined
  while (cursor.meta.parentSession !== undefined && event.seq < cursor.inheritedEventCount) {
    const cached = cache.get(cursor.meta.id)?.get(event.seq)
    if (cached !== undefined) {
      owner = cached
      break
    }
    const parent = byId.get(cursor.meta.parentSession)
    if (parent === undefined || !sameCopiedEvent(parent.events[event.seq], event)) break
    traversed.push(cursor.meta.id)
    cursor = parent
  }
  owner ??= cache.get(cursor.meta.id)?.get(event.seq)
    ?? { sessionId: cursor.meta.id, seq: event.seq }
  // One projection may inspect the same inherited event through many
  // descendants. Reuse the verified owner only within this immutable input.
  for (const id of traversed) {
    let events = cache.get(id)
    if (events === undefined) {
      events = new Map()
      cache.set(id, events)
    }
    events.set(event.seq, owner)
  }
  return owner
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
  parents: ReadonlyMap<SessionId, SessionId>,
): Array<{ inspection: ContextFamilyInspection; depth: number }> {
  const children = new Map<SessionId, ContextFamilyInspection[]>()
  for (const inspection of inspections) {
    const parent = parents.get(inspection.meta.id)
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
 * Collapse a native child forked again at an inherited boundary back beside
 * its siblings. A fork at a branch-local boundary remains a real child.
 */
function canonicalSessionParents(
  inspections: readonly ContextFamilyInspection[],
  byId: ReadonlyMap<SessionId, ContextFamilyInspection>,
  ownerCache: Map<SessionId, Map<number, ContextMessageRef>>,
): ReadonlyMap<SessionId, SessionId> {
  const parents = new Map<SessionId, SessionId>()
  for (const inspection of inspections) {
    const actualParent = inspection.meta.parentSession
    if (actualParent === undefined) continue
    const seedLength = inspection.inheritedEventCount
    const forkEvent = seedLength > 0 ? inspection.events[seedLength - 1] : undefined
    parents.set(
      inspection.meta.id,
      forkEvent === undefined ? actualParent : canonicalOwner(inspection, forkEvent, byId, ownerCache).sessionId,
    )
  }
  return parents
}

/** Fold only owned lifecycle events; inherited copies are not new choices. */
function workStates(
  inspections: readonly ContextFamilyInspection[],
  sessionIds: ReadonlySet<SessionId>,
): ReadonlyMap<SessionId, {
  readonly state: NonNullable<ContextFamilySession['workState']>
  readonly at: number
  readonly targetEventSeq?: number
}> {
  const choices = inspections.flatMap(inspection => inspection.events
    .slice(inspection.inheritedEventCount)
    .flatMap(event => event.type === 'contextify/work-state'
      && event.data.uiOrigin === 'contextify-client'
      && sessionIds.has(event.data.targetSessionId)
      ? [{ target: event.data.targetSessionId, state: event.data.state,
        at: event.time, owner: inspection.meta.id, seq: event.seq,
        ...(event.data.targetEventSeq === undefined ? {} : { targetEventSeq: event.data.targetEventSeq }) }] : []))
    .sort((a, b) => a.at - b.at || a.owner.localeCompare(b.owner) || a.seq - b.seq)
  return new Map(choices.map(choice => [choice.target, choice]))
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
  const ownerCache = new Map<SessionId, Map<number, ContextMessageRef>>()
  const canonicalParents = canonicalSessionParents(input.sessions, byId, ownerCache)
  const ordered = orderedFamily(root, input.sessions, canonicalParents)
  const explicitWorkStates = workStates(input.sessions, new Set(ordered.map(item => item.inspection.meta.id)))
  const nodes = new Map<string, MutableNode>()
  const edges = new Map<string, MutableEdge>()
  const sessions: ContextFamilySession[] = []

  for (const { inspection, depth } of ordered) {
    const path: string[] = []
    const webCalls = new Map<string, WebCallRef>(inspection.events.flatMap(event =>
      event.type === 'tool/call' && (event.data.name === 'web_fetch' || event.data.name === 'web_search')
        ? [[event.data.callId, { action: event.data.name, seq: event.seq }] as const] : []))
    const boundaries = branchBoundaries(inspection.events, webCalls)
    for (const { event, visible } of projectedMessages(inspection.events)) {
      const owner = canonicalOwner(inspection, event, byId, ownerCache)
      const id = `${owner.sessionId}:${String(owner.seq)}`
      let node = nodes.get(id)
      if (node === undefined) {
        node = {
          id,
          owner,
          role: visible.role,
          sourceKind: visible.sourceKind,
          ...(visible.webAction === undefined ? {} : { webAction: visible.webAction }),
          preview: preview(visible.message),
          time: event.time,
          branchAtSeq: visible.sourceKind === 'chat' ? boundaries.get(event.seq) ?? null : null,
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
    const parentSessionId = canonicalParents.get(inspection.meta.id)
    const explicitState = explicitWorkStates.get(inspection.meta.id)
    const laterUserTurn = explicitState === undefined ? false : inspection.events
      .slice(inspection.inheritedEventCount).some(event => event.type === 'user/message'
        && event.data.source.kind === 'user'
        && (explicitState.targetEventSeq === undefined
          ? event.time > explicitState.at : event.seq > explicitState.targetEventSeq))
    const workState = laterUserTurn ? 'open' : explicitState !== undefined
      ? explicitState.state : inspection.meta.id === input.activeSessionId ? 'open' : 'parked'
    sessions.push(Object.freeze({
      id: inspection.meta.id,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      seedLength: inspection.inheritedEventCount,
      depth,
      tipNodeId: path.at(-1) ?? null,
      workState,
      workStateSource: explicitState !== undefined && !laterUserTurn ? 'explicit' : 'derived',
    }))
  }

  const frozenNodes: ContextFamilyGraphNode[] = [...nodes.values()].map(node => Object.freeze({
    id: node.id,
    owner: Object.freeze({ ...node.owner }),
    role: node.role,
    sourceKind: node.sourceKind,
    ...(node.webAction === undefined ? {} : { webAction: node.webAction }),
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

/** Durable, same-Session context graph and compiler for Contextify. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-context-compiler'

export const name = 'contextify'
export const inject = ['agents', 'contextCompiler']

/** Opaque identity of one lightweight path inside a Session. */
export type ContextPathId = Branded<'ContextPathId'>

/**
 * Brand a validated path id.
 * @param value - Non-empty id without surrounding whitespace.
 * @returns The same string with the Contextify path brand.
 */
export function ContextPathId(value: string): ContextPathId {
  if (value.length === 0 || value.trim() !== value) throw new TypeError('context path id must be non-empty and trimmed')
  return value as ContextPathId
}

/** Durable ancestry and lifecycle of one conversation path. */
export interface ContextPath {
  readonly id: ContextPathId
  readonly parentPathId: ContextPathId | null
  readonly anchorSeq: number | null
  readonly label: string
  readonly status: 'active' | 'archived'
}

/** Explicit inclusion decision for one durable message event. */
export interface ContextNodeOverride {
  readonly seq: number
  readonly mode: 'include' | 'exclude'
}

/** Complete last-wins context selection plan. */
export interface ContextPlanSnapshot {
  readonly kind: 'contextify/plan'
  readonly version: 1
  readonly revision: number
  readonly mainlinePathId: ContextPathId
  readonly activePathId: ContextPathId
  readonly paths: readonly ContextPath[]
  readonly overrides: readonly ContextNodeOverride[]
}

/** Immutable assignment of one turn to a path and causal parent. */
export interface ContextRoute {
  readonly kind: 'contextify/route'
  readonly version: 1
  readonly turn: number
  readonly pathId: ContextPathId
  readonly parentSeq: number | null
  readonly planRevision: number
}

/** Replay-derived causal metadata for one durable message event. */
export interface ContextGraphNode {
  readonly seq: number
  readonly parentSeq: number | null
  readonly pathId: ContextPathId
  readonly turn: number | null
  readonly role: 'user' | 'assistant'
  readonly sourceKind: string
  readonly locked: boolean
}

/** Detached graph and the latest validated plan. */
export interface ContextGraph {
  readonly plan: ContextPlanSnapshot
  readonly nodes: readonly ContextGraphNode[]
}

/** Existing durable events and messages selected for one request. */
export interface ContextifyCompilation {
  readonly eventSeqs: readonly number[]
  readonly messages: readonly Message[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation Contextify plan. The last snapshot wins and its
     * revision, paths, and overrides determine subsequent request selection.
     */
    'contextify/plan': ContextPlanSnapshot
    /**
     * Immutable assignment of one turn to a path and causal parent. One route
     * precedes that turn's message events and remains stable across replay.
     */
    'contextify/route': ContextRoute
  }
}

const ROOT = ContextPathId('root')

/**
 * Create the revision-one root-only plan.
 * @returns A deeply frozen initial plan.
 */
export function createInitialContextPlan(): ContextPlanSnapshot {
  return Object.freeze({
    kind: 'contextify/plan',
    version: 1,
    revision: 1,
    mainlinePathId: ROOT,
    activePathId: ROOT,
    paths: Object.freeze([Object.freeze({
      id: ROOT,
      parentPathId: null,
      anchorSeq: null,
      label: 'Main',
      status: 'active' as const,
    })]),
    overrides: Object.freeze([]),
  })
}

function assertPlan(plan: ContextPlanSnapshot, previousRevision: number): void {
  if (!Number.isSafeInteger(plan.revision) || plan.revision <= previousRevision) {
    throw new Error('Contextify plan revisions must increase monotonically')
  }
  const paths = new Map<ContextPathId, ContextPath>()
  for (const path of plan.paths) {
    if (paths.has(path.id)) throw new Error(`duplicate Contextify path "${path.id}"`)
    paths.set(path.id, path)
  }
  const root = paths.get(ROOT)
  if (root === undefined || root.parentPathId !== null || root.anchorSeq !== null) {
    throw new Error('Contextify root path is missing or malformed')
  }
  for (const id of [plan.mainlinePathId, plan.activePathId]) {
    if (paths.get(id)?.status !== 'active') throw new Error(`Contextify active path "${id}" does not exist`)
  }
  for (const path of paths.values()) {
    const seen = new Set<ContextPathId>([path.id])
    let parentId = path.parentPathId
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error('Contextify path ancestry contains a cycle')
      seen.add(parentId)
      const parent = paths.get(parentId)
      if (parent === undefined) throw new Error(`Contextify parent path "${parentId}" does not exist`)
      parentId = parent.parentPathId
    }
  }
  const overrideSeqs = new Set<number>()
  for (const override of plan.overrides) {
    if (!Number.isSafeInteger(override.seq) || override.seq < 0 || overrideSeqs.has(override.seq)) {
      throw new Error('Contextify overrides must have unique event sequences')
    }
    overrideSeqs.add(override.seq)
  }
}

/**
 * Fold durable routes and message events into a causal, same-Session graph.
 * @param session - Session whose complete event log is replayed.
 * @returns A frozen graph with the latest validated plan.
 */
export function foldContextGraph(session: Session): ContextGraph {
  let plan = createInitialContextPlan()
  let planRevision = 0
  let openTurn: number | null = null
  let activeRoute: ContextRoute | null = null
  const routedTurns = new Map<number, ContextRoute>()
  const tips = new Map<ContextPathId, number | null>([[ROOT, null]])
  const nodes: ContextGraphNode[] = []
  const nodeSeqs = new Set<number>()

  for (const event of session.events) {
    if (event.type === 'contextify/plan') {
      assertPlan(event.data, planRevision)
      plan = event.data
      planRevision = plan.revision
      continue
    }
    if (event.type === 'turn/start') {
      openTurn = event.data.turn
      activeRoute = routedTurns.get(openTurn) ?? null
      continue
    }
    if (event.type === 'turn/end') {
      if (openTurn === event.data.turn) {
        openTurn = null
        activeRoute = null
      }
      continue
    }
    if (event.type === 'contextify/route') {
      const route = event.data
      if (routedTurns.has(route.turn)) throw new Error(`duplicate Contextify route for turn ${String(route.turn)}`)
      const path = plan.paths.find(candidate => candidate.id === route.pathId)
      if (path === undefined || path.status !== 'active') throw new Error(`Contextify route path "${route.pathId}" does not exist`)
      if (route.planRevision !== plan.revision) throw new Error('Contextify route references a stale plan revision')
      if (route.parentSeq !== null && !nodeSeqs.has(route.parentSeq)) throw new Error('Contextify route parent is not a graph node')
      routedTurns.set(route.turn, route)
      if (openTurn === route.turn) activeRoute = route
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    if (event.surfaceOp !== 'append') continue

    const eventTurn = event.type === 'user/message' ? openTurn : event.data.turn
    const route = eventTurn === null ? null : routedTurns.get(eventTurn) ?? activeRoute
    const pathId = route?.pathId ?? ROOT
    const priorTip = tips.get(pathId)
    const parentSeq = priorTip === undefined ? route?.parentSeq ?? null : priorTip
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    nodes.push(Object.freeze({
      seq: event.seq,
      parentSeq,
      pathId,
      turn: eventTurn,
      role: event.type === 'assistant/message' ? 'assistant' : 'user',
      sourceKind: message.source.kind,
      locked: !['user', 'model', 'tool'].includes(message.source.kind),
    }))
    nodeSeqs.add(event.seq)
    tips.set(pathId, event.seq)
  }
  return Object.freeze({ plan, nodes: Object.freeze(nodes) })
}

/**
 * Select a causal path plus explicit overrides, keeping the current turn fixed.
 * @param request - Session and current Agent Loop coordinates.
 * @returns Frozen ordered event sequences and their derived messages.
 */
export function compileContextify(request: { session: Session; turn: number; step: number }): ContextifyCompilation {
  const graph = foldContextGraph(request.session)
  const bySeq = new Map(graph.nodes.map(node => [node.seq, node]))
  const tips = graph.nodes.filter(node => node.pathId === graph.plan.activePathId)
  let cursor: number | null = tips.at(-1)?.seq
    ?? graph.plan.paths.find(path => path.id === graph.plan.activePathId)?.anchorSeq
    ?? null
  const selected = new Set<number>()
  while (cursor !== null) {
    const node = bySeq.get(cursor)
    if (node === undefined) throw new Error(`Contextify natural path references missing node ${String(cursor)}`)
    selected.add(cursor)
    cursor = node.parentSeq
  }
  for (const override of graph.plan.overrides) {
    if (!bySeq.has(override.seq)) throw new Error(`Contextify override references missing node ${String(override.seq)}`)
    if (override.mode === 'include') selected.add(override.seq)
    else selected.delete(override.seq)
  }
  for (const node of graph.nodes) {
    if (node.turn === request.turn) selected.add(node.seq)
  }
  const eventSeqs = graph.nodes.map(node => node.seq).filter(seq => selected.has(seq))
  const messages = eventSeqs.map((seq) => {
    const event = request.session.events[seq]
    if (event === undefined) throw new Error(`Contextify selected missing event ${String(seq)}`)
    const message = request.session.deriveEventMessage(event)
    if (message === null) throw new Error(`Contextify selected non-message event ${String(seq)}`)
    return message
  })
  return Object.freeze({ eventSeqs: Object.freeze(eventSeqs), messages: Object.freeze(messages) })
}

/** Install Contextify as a durable Harness context compiler provider. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.contextCompiler.register({
    id: name,
    version: 1,
    select: request => ({ eventSeqs: compileContextify(request).eventSeqs }),
  }))
  ctx.on('agent/session-start', ({ agent }) => {
    if (!agent.session.events.some(event => event.type === 'contextify/plan')) {
      agent.session.append('contextify/plan', createInitialContextPlan())
    }
    ctx.contextCompiler.select(agent.session, name)
  })
}

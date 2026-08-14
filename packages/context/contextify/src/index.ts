/** Durable, same-Session context graph and compiler for Contextify. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-context-compiler'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  ContextPathId,
  type ContextGraph,
  type ContextGraphNode,
  type ContextGraphPage,
  type ContextGraphRecord,
  type ContextPath,
  type ContextPlanRef,
  type ContextPlanSnapshot,
  type ContextRoute,
  type ContextifyCompilation,
  type ContextifyView,
} from './types.ts'

export * from './types.ts'

export const name = 'contextify'

/** Domain error preserved by Harness remote adapters. */
export class ContextifyError extends HarnessError {}

declare module '@deepseek-ai/cordis' {
  interface Context { contextify: ContextifyService }
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
  const toolGroups: Set<number>[] = []
  const groupBySeq = new Map<number, Set<number>>()
  const resultByCall = new Map<string, number>()
  for (const node of graph.nodes) {
    const event = request.session.events[node.seq]
    if (event?.type === 'tool/result') resultByCall.set(event.data.message.source.callId, node.seq)
  }
  for (const node of graph.nodes) {
    const event = request.session.events[node.seq]
    if (event?.type !== 'assistant/message') continue
    const calls = event.data.message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])
    if (calls.length === 0) continue
    const group = new Set<number>([node.seq])
    for (const call of calls) {
      const resultSeq = resultByCall.get(call)
      if (resultSeq !== undefined) group.add(resultSeq)
    }
    toolGroups.push(group)
    for (const seq of group) groupBySeq.set(seq, group)
  }
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
  const excludedGroups = new Set<Set<number>>()
  const includedGroups = new Set<Set<number>>()
  for (const override of graph.plan.overrides) {
    if (!bySeq.has(override.seq)) throw new Error(`Contextify override references missing node ${String(override.seq)}`)
    const group = groupBySeq.get(override.seq)
    if (group !== undefined) {
      if (override.mode === 'include') includedGroups.add(group)
      else excludedGroups.add(group)
    } else if (override.mode === 'include') selected.add(override.seq)
    else selected.delete(override.seq)
  }
  for (const group of excludedGroups) for (const seq of group) selected.delete(seq)
  for (const group of includedGroups) for (const seq of group) selected.add(seq)
  for (const node of graph.nodes) {
    if (node.turn === request.turn) selected.add(node.seq)
  }
  for (const group of toolGroups) {
    if ([...group].some(seq => selected.has(seq))) {
      for (const seq of group) selected.add(seq)
    }
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

/** Durable Contextify state, mutations, routing, graph reads, and compiler registration. */
export class ContextifyService extends TypertRemoteService {
  static inject = ['agents', 'contextCompiler']

  constructor(ctx: Context) {
    super(ctx, 'contextify')
    ctx.effect(() => ctx.contextCompiler.register({
      id: name, version: 1,
      select: request => ({ eventSeqs: compileContextify(request).eventSeqs }),
    }))
    ctx.on('agent/session-start', ({ agent }) => {
      if (!agent.session.events.some(event => event.type === 'contextify/plan')) {
        agent.session.append('contextify/plan', createInitialContextPlan())
      }
      ctx.contextCompiler.select(agent.session, name)
    })
    ctx.on('agent/pre-step', async ({ agent, turn }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      if (agent.session.events.some(event => event.type === 'contextify/route' && event.data.turn === turn)) return decision
      const graph = foldContextGraph(agent.session)
      const active = graph.plan.activePathId
      const parentSeq = graph.nodes.filter(node => node.pathId === active).at(-1)?.seq
        ?? graph.plan.paths.find(path => path.id === active)?.anchorSeq ?? null
      agent.session.append('contextify/route', {
        kind: 'contextify/route', version: 1, turn, pathId: active,
        parentSeq, planRevision: graph.plan.revision,
      })
      return decision
    })
  }

  /**
   * Read the current detached view for one live Agent.
   * @param agent - Live Agent whose Session owns the Contextify plan.
   * @returns A transport-safe snapshot of the current plan and selection counts.
   */
  @Remote('get')
  get(agent: Agent): ContextifyView {
    this.assertLive(agent)
    return this.view(agent.session)
  }

  /**
   * Create and select a child path anchored at an existing node.
   * @param agent - Live Agent whose Session will receive the durable plan event.
   * @param ref - Expected plan revision used for compare-and-swap safety.
   * @param anchorSeq - Message event sequence from which the new path diverges.
   * @param label - Optional human-readable path label.
   * @returns The view after committing and selecting the child path.
   */
  @Remote('createBranch')
  createBranch(agent: Agent, ref: ContextPlanRef, anchorSeq: number, label?: string): ContextifyView {
    const plan = this.prepare(agent, ref)
    const graph = foldContextGraph(agent.session)
    const anchor = graph.nodes.find(node => node.seq === anchorSeq)
    if (anchor === undefined) throw new ContextifyError('branch anchor is not a message node', 'CONTEXTIFY_INVALID_ANCHOR')
    const resolvedLabel = (label ?? 'New branch').trim()
    if (resolvedLabel.length === 0 || resolvedLabel.length > 80) {
      throw new ContextifyError('branch label must contain 1-80 characters', 'CONTEXTIFY_INVALID_LABEL')
    }
    const id = ContextPathId(`path-${randomUUID()}`)
    return this.commit(agent.session, {
      ...plan, revision: plan.revision + 1, activePathId: id,
      paths: [...plan.paths, {
        id, parentPathId: anchor.pathId, anchorSeq, label: resolvedLabel, status: 'active',
      }],
    })
  }

  /**
   * Select one active path without creating another Session.
   * @param agent - Live Agent whose Contextify plan will change.
   * @param ref - Expected plan revision used for compare-and-swap safety.
   * @param pathId - Existing active path to select.
   * @returns The view after selecting the requested path.
   */
  @Remote('selectPath')
  selectPath(agent: Agent, ref: ContextPlanRef, pathId: ContextPathId): ContextifyView {
    const plan = this.prepare(agent, ref)
    if (plan.paths.find(path => path.id === pathId)?.status !== 'active') {
      throw new ContextifyError(`path "${pathId}" is unavailable`, 'CONTEXTIFY_PATH_NOT_FOUND')
    }
    return this.commit(agent.session, { ...plan, revision: plan.revision + 1, activePathId: pathId })
  }

  /**
   * Select the durable mainline path.
   * @param agent - Live Agent whose Contextify plan will change.
   * @param ref - Expected plan revision used for compare-and-swap safety.
   * @returns The current view, after switching when necessary.
   */
  @Remote('returnToMainline')
  returnToMainline(agent: Agent, ref: ContextPlanRef): ContextifyView {
    const plan = this.prepare(agent, ref)
    if (plan.activePathId === plan.mainlinePathId) return this.view(agent.session)
    return this.commit(agent.session, { ...plan, revision: plan.revision + 1, activePathId: plan.mainlinePathId })
  }

  /**
   * Set or clear one explicit message selection override.
   * @param agent - Live Agent whose Contextify plan will change.
   * @param ref - Expected plan revision used for compare-and-swap safety.
   * @param seq - Message event sequence whose selection mode will change.
   * @param mode - Natural path behavior or an explicit include/exclude override.
   * @returns The view after committing the new override set.
   */
  @Remote('setNodeMode')
  setNodeMode(agent: Agent, ref: ContextPlanRef, seq: number, mode: 'natural' | 'include' | 'exclude'): ContextifyView {
    const plan = this.prepare(agent, ref)
    const node = foldContextGraph(agent.session).nodes.find(candidate => candidate.seq === seq)
    if (node === undefined) throw new ContextifyError('node does not exist', 'CONTEXTIFY_INVALID_NODE')
    if (node.locked) throw new ContextifyError('node selection is locked', 'CONTEXTIFY_LOCKED_NODE')
    const overrides = plan.overrides.filter(override => override.seq !== seq)
    if (mode !== 'natural') overrides.push({ seq, mode })
    return this.commit(agent.session, { ...plan, revision: plan.revision + 1, overrides })
  }

  /**
   * Return a bounded detached graph page.
   * @param agent - Live Agent whose Session graph will be read.
   * @param afterSeq - Exclusive event-sequence cursor; omitted to read from the start.
   * @param limit - Maximum records to return, from 1 through 500.
   * @returns A transport-safe page of graph nodes and previews.
   */
  @Remote('graphPage')
  graphPage(agent: Agent, afterSeq?: number, limit?: number): ContextGraphPage {
    this.assertLive(agent)
    const cursor = afterSeq ?? -1
    const pageLimit = limit ?? 250
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 500) throw new RangeError('graph page limit must be 1-500')
    const graph = foldContextGraph(agent.session)
    const candidates = graph.nodes.filter(node => node.seq > cursor)
    const records = candidates.slice(0, pageLimit).map((record): ContextGraphRecord => {
      const event = agent.session.events[record.seq]
      const message = event === undefined ? null : agent.session.deriveEventMessage(event)
      const raw = message?.content.flatMap((block) => {
        if (block.type === 'text') return [block.text]
        if (block.type === 'tool-call') return [`${block.name}(${block.arguments})`]
        if (block.type === 'tool-result') return block.content.flatMap(child => child.type === 'text' ? [child.text] : [])
        return []
      }).join('\n') ?? ''
      return { ...record, preview: Array.from(raw).slice(0, 240).join('') }
    })
    const last = records.at(-1)
    return {
      asOfSeq: agent.session.seq - 1,
      records,
      ...candidates.length > records.length && last !== undefined ? { nextAfterSeq: last.seq } : {},
    }
  }

  private currentPlan(session: Session): ContextPlanSnapshot {
    return session.events.findLast(event => event.type === 'contextify/plan')?.data ?? createInitialContextPlan()
  }

  private prepare(agent: Agent, ref: ContextPlanRef): ContextPlanSnapshot {
    this.assertLive(agent)
    if (agent.status !== 'idle') throw new ContextifyError('context can change after the current reply finishes', 'CONTEXTIFY_AGENT_BUSY')
    const plan = this.currentPlan(agent.session)
    if (plan.revision !== ref.revision) {
      throw new ContextifyError(`stale plan revision ${String(ref.revision)}; current is ${String(plan.revision)}`, 'CONTEXTIFY_STALE_REVISION')
    }
    return plan
  }

  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new ContextifyError(`agent "${agent.id}" is not live`, 'CONTEXTIFY_AGENT_NOT_LIVE')
    }
  }

  private commit(session: Session, plan: ContextPlanSnapshot): ContextifyView {
    session.append('contextify/plan', plan)
    return this.view(session)
  }

  private view(session: Session): ContextifyView {
    const graph = foldContextGraph(session)
    const compilation = compileContextify({ session, turn: -1, step: -1 })
    return {
      plan: structuredClone(graph.plan),
      graphAsOfSeq: session.seq - 1,
      activeTipSeq: graph.nodes.filter(node => node.pathId === graph.plan.activePathId).at(-1)?.seq
        ?? graph.plan.paths.find(path => path.id === graph.plan.activePathId)?.anchorSeq ?? null,
      selectedCount: compilation.eventSeqs.length,
      totalNodeCount: graph.nodes.length,
    }
  }
}

export default ContextifyService

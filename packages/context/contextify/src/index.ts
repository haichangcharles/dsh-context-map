/** Durable context selection across one native Session fork family. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, type Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-context-compiler'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { projectSessionFamily } from './family.ts'
import {
  compileContextify,
  createInitialContextPlan,
  currentContextPlan,
  nextPlan,
  redoPlan,
  resetPlan,
  undoPlan,
} from './plan.ts'
import type {
  ContextFamilyGraph,
  ContextFamilyGraphNode,
  ContextFamilyGraphPage,
  ContextFamilyInspection,
  ContextMessageRef,
  ContextNodeMutation,
  ContextPlanRef,
  ContextPlanSnapshot,
  ContextifyView,
} from './types.ts'

export * from './types.ts'
export {
  compileContextify,
  createInitialContextPlan,
  currentContextPlan,
  nextPlan,
  projectSessionFamily,
  redoPlan,
  resetPlan,
  undoPlan,
}

export const name = 'contextify'

/** Domain error preserved by Harness remote adapters. */
export class ContextifyError extends HarnessError {}

declare module '@deepseek-ai/cordis' {
  interface Context { contextify: ContextifyService }
}

interface LoadedFamily {
  readonly graph: ContextFamilyGraph
  readonly inspections: ReadonlyMap<SessionId, ContextFamilyInspection>
  readonly knownSessionIds: ReadonlySet<SessionId>
}

function exactMessage(inspection: ContextFamilyInspection, seq: number): Message | null {
  const event = inspection.events[seq]
  if (event?.type === 'user/message' && event.surfaceOp === 'append') return event.data
  if (event?.type === 'assistant/message' && event.surfaceOp === 'append') return event.data.message
  return null
}

function importedMessage(message: Message): Message {
  if (message.content.some(block => block.type === 'tool-call' || block.type === 'tool-result')) {
    throw new ContextifyError(
      'tool exchanges cannot be imported without their native protocol context',
      'CONTEXTIFY_UNSUPPORTED_MESSAGE',
    )
  }
  const content = message.content.filter(block => block.type !== 'reasoning')
  if (content.length === 0) {
    throw new ContextifyError(
      'a reasoning-only message has no Context Map content to import',
      'CONTEXTIFY_UNSUPPORTED_MESSAGE',
    )
  }
  return structuredClone({ ...message, content })
}

function contentHash(message: Message): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex')
}

function resolveNode(graph: ContextFamilyGraph, ref: ContextMessageRef): ContextFamilyGraphNode | undefined {
  return graph.nodes.find(node => node.owner.seq === ref.seq && node.sessionIds.includes(ref.sessionId))
}

/** Durable Context Plan mutations and native Session-family graph reads. */
export class ContextifyService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'contextCompiler']

  constructor(ctx: Context) {
    super(ctx, 'contextify')
    ctx.effect(() => ctx.contextCompiler.register({
      id: name,
      version: 2,
      select: request => ({ eventSeqs: compileContextify(request).eventSeqs }),
    }))
    ctx.on('agent/session-start', ({ agent }) => {
      const latest = agent.session.events.findLast(event => event.type === 'contextify/plan')
      const inherited = agent.session.header.parentSession !== undefined
        && latest !== undefined
        && latest.seq < (agent.session.header.seedLength ?? 0)
      if (latest === undefined || inherited) {
        agent.session.append('contextify/plan', createInitialContextPlan(
          latest === undefined ? 1 : latest.data.revision + 1,
        ))
      }
      ctx.contextCompiler.select(agent.session, name)
    })
  }

  /**
   * Read the active Session's current Context Plan.
   * @param agent - Live Agent whose Session owns the plan.
   * @returns A detached plan and compilation summary.
   */
  @Remote('get')
  get(agent: Agent): ContextifyView {
    this.assertLive(agent)
    return this.view(agent.session)
  }

  /**
   * Read one bounded page of the active Session's native fork family.
   * @param agent - Live Agent selecting the family root and active path.
   * @param after - Zero-based node offset; omitted starts at the first node.
   * @param limit - Maximum records from 1 through 500.
   * @returns Family metadata, all edges, and the requested canonical node page.
   */
  @Remote('familyPage')
  async familyPage(agent: Agent, after?: number, limit?: number): Promise<ContextFamilyGraphPage> {
    this.assertLive(agent)
    const offset = after ?? 0
    const pageLimit = limit ?? 250
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('family page offset must be non-negative')
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 500) {
      throw new RangeError('family page limit must be 1-500')
    }
    const { graph } = await this.loadFamily(agent.session)
    const records = graph.nodes.slice(offset, offset + pageLimit)
    const next = offset + records.length
    return {
      asOfSeq: agent.session.seq - 1,
      rootSessionId: graph.rootSessionId,
      activeSessionId: graph.activeSessionId,
      sessions: graph.sessions,
      edges: graph.edges,
      records,
      totalNodeCount: graph.nodes.length,
      ...(next < graph.nodes.length ? { nextAfter: next } : {}),
    }
  }

  /**
   * Set or clear one message's explicit context mode.
   * @param agent - Live Agent whose Session receives durable events.
   * @param ref - Expected current plan revision.
   * @param node - Message location in one Session in the active family.
   * @param mode - Natural behavior or the meaningful on-path/off-path override.
   * @returns The view after the mutation commits.
   */
  @Remote('setNodeMode')
  async setNodeMode(
    agent: Agent,
    ref: ContextPlanRef,
    node: ContextMessageRef,
    mode: 'natural' | 'include' | 'exclude',
  ): Promise<ContextifyView> {
    return this.setNodeModes(agent, ref, [{ node, mode }])
  }

  /**
   * Apply several node-mode changes as one Context Plan revision.
   * @param agent - Live Agent whose Session receives durable events.
   * @param ref - Expected current plan revision.
   * @param mutations - Ordered message-mode replacements.
   * @returns The view after one complete plan commits.
   */
  @Remote('setNodeModes')
  async setNodeModes(
    agent: Agent,
    ref: ContextPlanRef,
    mutations: readonly ContextNodeMutation[],
  ): Promise<ContextifyView> {
    const current = this.prepare(agent, ref)
    const family = await this.loadFamily(agent.session)
    let excluded = [...current.excluded]
    let included = [...current.included]
    const pendingSnapshots: Array<{ nodeId: string; ref: ContextMessageRef; message: Message; position: number }> = []

    for (const mutation of mutations) {
      const node = resolveNode(family.graph, mutation.node)
      if (node === undefined) {
        const code = family.knownSessionIds.has(mutation.node.sessionId)
          ? 'CONTEXTIFY_CROSS_FAMILY'
          : 'CONTEXTIFY_INVALID_NODE'
        throw new ContextifyError('message is not part of the active Context Map', code)
      }
      excluded = excluded.filter(item => item.nodeId !== node.id)
      included = included.filter(item => item.nodeId !== node.id)
      const natural = node.sessionIds.includes(agent.session.id)
      if (mutation.mode === 'natural' || (natural && mutation.mode === 'include')
        || (!natural && mutation.mode === 'exclude')) continue
      if (natural) {
        if (node.activeEventSeq === null) throw new Error('active Context Map node is missing its local event')
        excluded.push({ nodeId: node.id, eventSeq: node.activeEventSeq })
        continue
      }
      const source = family.inspections.get(mutation.node.sessionId)
      const exact = source === undefined ? null : exactMessage(source, mutation.node.seq)
      if (exact === null) {
        throw new ContextifyError('message source is unavailable', 'CONTEXTIFY_INVALID_NODE')
      }
      const message = importedMessage(exact)
      const position = family.graph.nodes.filter(candidate =>
        candidate.sessionIds.includes(agent.session.id) && candidate.time <= node.time).length
      pendingSnapshots.push({ nodeId: node.id, ref: mutation.node, message, position })
    }

    const firstSnapshotSeq = agent.session.seq
    const appendedIncludes = pendingSnapshots.map((snapshot, index) => ({
      nodeId: snapshot.nodeId,
      snapshotSeq: firstSnapshotSeq + index,
      position: snapshot.position,
    }))
    const plan = nextPlan(current, { excluded, included: [...included, ...appendedIncludes] })
    for (const snapshot of pendingSnapshots) {
      agent.session.append('context/compiler-snapshot', {
        id: snapshot.nodeId,
        message: snapshot.message,
        provenance: {
          provider: name,
          sourceId: snapshot.ref.sessionId,
          sourceSeq: snapshot.ref.seq,
          contentHash: contentHash(snapshot.message),
        },
      })
    }
    return this.commit(agent.session, plan)
  }

  /**
   * Reset every explicit choice to Natural behavior.
   * @param agent - Live Agent whose plan changes.
   * @param ref - Expected current plan revision.
   * @returns The committed Natural view.
   */
  @Remote('reset')
  reset(agent: Agent, ref: ContextPlanRef): ContextifyView {
    return this.commit(agent.session, resetPlan(this.prepare(agent, ref)))
  }

  /**
   * Restore the prior Context Plan state as a new durable revision.
   * @param agent - Live Agent whose plan changes.
   * @param ref - Expected current plan revision.
   * @returns The committed prior-state view.
   */
  @Remote('undo')
  undo(agent: Agent, ref: ContextPlanRef): ContextifyView {
    const current = this.prepare(agent, ref)
    const plan = undoPlan(agent.session, current)
    if (plan === null) throw new ContextifyError('Context Plan has no earlier state', 'CONTEXTIFY_HISTORY_EMPTY')
    return this.commit(agent.session, plan)
  }

  /**
   * Restore the next Context Plan state as a new durable revision.
   * @param agent - Live Agent whose plan changes.
   * @param ref - Expected current plan revision.
   * @returns The committed next-state view.
   */
  @Remote('redo')
  redo(agent: Agent, ref: ContextPlanRef): ContextifyView {
    const current = this.prepare(agent, ref)
    const plan = redoPlan(agent.session, current)
    if (plan === null) throw new ContextifyError('Context Plan has no later state', 'CONTEXTIFY_HISTORY_EMPTY')
    return this.commit(agent.session, plan)
  }

  private prepare(agent: Agent, ref: ContextPlanRef): ContextPlanSnapshot {
    this.assertLive(agent)
    if (agent.status !== 'idle') {
      throw new ContextifyError(
        'context can change after the current reply finishes',
        'CONTEXTIFY_AGENT_BUSY',
      )
    }
    const plan = currentContextPlan(agent.session)
    if (plan.revision !== ref.revision) {
      throw new ContextifyError(
        `stale plan revision ${String(ref.revision)}; current is ${String(plan.revision)}`,
        'CONTEXTIFY_STALE_REVISION',
      )
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
    const plan = currentContextPlan(session)
    const compilation = compileContextify({ session, turn: -1, step: -1 })
    const totalNodeCount = session.events.filter(event =>
      event.type === 'user/message'
      || (event.type === 'assistant/message'
        && event.data.message.content.some(block => block.type === 'text' || block.type === 'image'))).length
    return {
      plan: structuredClone(plan),
      graphAsOfSeq: session.seq - 1,
      selectedCount: compilation.messages.filter(message =>
        message.content.some(block => block.type === 'text' || block.type === 'image')).length,
      totalNodeCount,
      canUndo: plan.history.past.length > 0,
      canRedo: plan.history.future.length > 0,
    }
  }

  private async loadFamily(active: Session): Promise<LoadedFamily> {
    const headers = new Map<SessionId, ContextFamilyInspection['meta']>()
    for (const header of await this.ctx.sessionPersistence.list()) headers.set(header.id, header)
    for (const session of this.ctx.sessions.list()) headers.set(session.id, session.header)
    const knownSessionIds = new Set(headers.keys())

    let rootId = active.id
    const seen = new Set<SessionId>()
    while (!seen.has(rootId)) {
      seen.add(rootId)
      const parent = headers.get(rootId)?.parentSession
      if (parent === undefined || !headers.has(parent)) break
      rootId = parent
    }
    const familyIds = new Set<SessionId>([rootId])
    let changed = true
    while (changed) {
      changed = false
      for (const header of headers.values()) {
        if (header.parentSession === undefined || !familyIds.has(header.parentSession)
          || familyIds.has(header.id)) continue
        familyIds.add(header.id)
        changed = true
      }
    }

    const inspections = new Map<SessionId, ContextFamilyInspection>()
    for (const id of familyIds) {
      const live = this.ctx.sessions.get(id)
      const inspection = live === undefined
        ? await this.ctx.sessionPersistence.inspect(id)
        : { meta: live.header, events: live.events }
      inspections.set(id, inspection)
    }
    const graph = projectSessionFamily({
      activeSessionId: active.id,
      sessions: [...inspections.values()],
    })
    return { graph, inspections, knownSessionIds }
  }
}

export default ContextifyService

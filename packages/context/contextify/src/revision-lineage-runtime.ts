/** Opt-in runtime admission for revision-consistent Contextify requests. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { SessionId, type Session, type UserMessage } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from './index.ts'
import {
  childMessageAdmissible, recordRequestReadSet, revisionLineageSelection,
  sourceBoundDelegationCandidates, startSourceBoundContinuable,
} from './revision-lineage.ts'

/** Compiler selected by the opt-in runtime before the first model step. */
export const REVISION_LINEAGE_COMPILER_ID = 'contextify-revision-lineage'

declare module '@deepseek-ai/cordis' {
  interface Context { contextifyRevisionLineage: ContextifyRevisionLineageRuntime }
}

function hasUnrecordedAssistantHistory(session: Session): boolean {
  const readSets = new Set(session.snapshotEvents().flatMap(event =>
    event.type === 'contextify/request-read-set'
      ? [`${String(event.data.turn)}:${String(event.data.step)}`] : []))
  return session.snapshotEvents().some(event => event.type === 'assistant/message'
    && !readSets.has(`${String(event.data.turn)}:${String(event.data.step)}`))
}

/**
 * Mount after Contextify to enforce recorded dependencies at parent pre-step.
 * A Contextify Session is upgraded before its first request only if its
 * previous assistant messages already have read sets. Legacy Sessions keep
 * ordinary Contextify selection rather than claiming retrospective lineage.
 */
export class ContextifyRevisionLineageRuntime extends Service {
  static inject = ['contextify', 'contextCompiler']

  private readonly quarantined = new Map<SessionId, UserMessage[]>()

  constructor(ctx: Context) {
    super(ctx, 'contextifyRevisionLineage')
    ctx.effect(() => ctx.contextCompiler.register({
      id: REVISION_LINEAGE_COMPILER_ID, version: 1,
      select: revisionLineageSelection,
    }))
    ctx.inject(['tools', 'subagents'], (toolCtx) => {
      const protectedParent = (agent: { session: Session } | undefined): agent is { session: Session } =>
        agent !== undefined && agent.session.header.origin !== 'subagent'
          && ctx.contextCompiler.descriptor(agent.session).id === REVISION_LINEAGE_COMPILER_ID
      toolCtx.effect(() => toolCtx.tools.guard(exec => protectedParent(exec.agent)
        && (exec.name.startsWith('subagent') || exec.name === 'send_message')
        ? 'This Context Plan protects worker sources. Use list_context_sources and delegate_context_sources; free-text delegation or follow-up would lose the source binding.'
        : undefined))
      toolCtx.effect(() => toolCtx.tools.register(defineTool({
        name: 'list_context_sources',
        description: 'List currently selected, text-only human or Web sources for source-bound analysis. '
          + 'Results show Session event sequences and short previews. Use before_seq to page backward '
          + 'through a long conversation; only listed current sources can be delegated.',
        parameters: {
          before_seq: { type: 'integer',
            description: 'Optional upper exclusive Session sequence for older sources.' },
        },
        output: { schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }] },
        execute: (args, exec) => {
          if (!protectedParent(exec.agent)) {
            throw new Error('source-bound Context tools require a protected parent Session')
          }
          return Promise.resolve(JSON.stringify(
            sourceBoundDelegationCandidates(exec.agent.session, args.before_seq)))
        },
      })))
      toolCtx.effect(() => toolCtx.tools.register(defineTool({
        name: 'delegate_context_sources',
        description: 'Start a background worker using only selected human or Web source events '
          + 'from the current protected Context Plan. First call list_context_sources. '
          + 'The server rechecks every source and records the exact dependency slice; '
          + 'the worker has no global tools and reports back when it settles.',
        parameters: {
          source_event_seqs: { type: 'array', required: true, items: { type: 'integer' },
            description: 'One to eight distinct event sequences returned by list_context_sources.' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false,
            properties: { subagentId: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: `started source-bound worker ${value.subagentId}` }],
        },
        execute: async (args, exec) => {
          if (!protectedParent(exec.agent)) {
            throw new Error('source-bound Context tools require a protected parent Session')
          }
          if (args.source_event_seqs.length < 1 || args.source_event_seqs.length > 8) {
            throw new Error('delegate_context_sources requires one to eight source event sequences')
          }
          const childId = SessionId(randomUUID())
          const started = await startSourceBoundContinuable(toolCtx, exec.agent, childId,
            args.source_event_seqs, exec.signal)
          return { subagentId: String(started.childId) }
        },
      })))
    })
    ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
      const decision = await next()
      if (decision.kind !== 'enter' || agent.session.header.origin === 'subagent') return decision
      const descriptor = ctx.contextCompiler.descriptor(agent.session)
      if (descriptor.id === 'contextify') {
        if (hasUnrecordedAssistantHistory(agent.session)) {
          return decision
        }
        ctx.contextCompiler.select(agent.session, REVISION_LINEAGE_COMPILER_ID)
      } else if (descriptor.id !== REVISION_LINEAGE_COMPILER_ID) {
        return decision
      }
      const retained = decision.messages.filter((message) => {
        if (message.source.kind !== 'agent-message' && message.source.kind !== 'subagent-settled') {
          return true
        }
        if (childMessageAdmissible(agent.session, message.source.senderSessionId)) return true
        const queue = this.quarantined.get(agent.session.id) ?? []
        queue.push(message)
        if (queue.length > 64) queue.shift()
        this.quarantined.set(agent.session.id, queue)
        return false
      })
      recordRequestReadSet(agent.session, turn, step, retained)
      return { ...decision, messages: retained }
    })
    ctx.on('session/disposed', (session) => { this.quarantined.delete(session.id) })
  }

  /** Rejected late reports retained in memory for inspection, not auto-replay.
   * @param sessionId - Native Session that received the reports.
   * @returns A copy of its current quarantined reports.
   */
  quarantinedFor(sessionId: SessionId): readonly UserMessage[] {
    return [...(this.quarantined.get(sessionId) ?? [])]
  }
}

export default ContextifyRevisionLineageRuntime

/** Durable source dependencies for opt-in revision-consistent agent requests. */
import assert from 'tiny-invariant'
import { createHash } from 'node:crypto'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContinuableStart } from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { compileContextify, currentContextPlan } from './plan.ts'

/** One reserved child's parent-selected sources, recorded before it starts. */
export interface DelegationSliceRecord {
  readonly childId: SessionId
  readonly planRevision: number
  readonly sourceEventSeqs: readonly number[]
}

/** Model inputs recorded before the request whose turn and step identify its answer. */
export interface RequestReadSetRecord {
  readonly turn: number
  readonly step: number
  readonly planRevision: number
  readonly historyEventSeqs: readonly number[]
  readonly acceptedMessageIds: readonly string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A child may depend on exactly these immutable parent Session events. */
    'contextify/delegation-slice': DelegationSliceRecord
    /** The admitted step's selected history and new messages, logged before its model request. */
    'contextify/request-read-set': RequestReadSetRecord
  }
}

interface LineageState {
  readonly selected: Set<number>
  readonly deniedSources: Set<number>
  readonly sourceClosureCache: Map<number, boolean>
  readonly slices: Map<SessionId, DelegationSliceRecord>
  readonly readSets: Map<string, RequestReadSetRecord>
  readonly messageSeqs: Map<string, number>
}

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

function lineageState(session: Session, selectedEventSeqs: readonly number[]): LineageState {
  const selected = new Set(selectedEventSeqs)
  const plan = currentContextPlan(session)
  const deniedSources = new Set([
    ...plan.excluded.map(item => item.eventSeq),
    ...plan.replacements.flatMap(item => item.originalEventSeq === null ? [] : [item.originalEventSeq]),
  ])
  const slices = new Map<SessionId, DelegationSliceRecord>()
  const readSets = new Map<string, RequestReadSetRecord>()
  const messageSeqs = new Map<string, number>()
  for (const event of session.snapshotEvents()) {
    switch (event.type) {
      case 'contextify/delegation-slice':
        slices.set(event.data.childId, event.data)
        break
      case 'contextify/request-read-set':
        readSets.set(stepKey(event.data.turn, event.data.step), event.data)
        break
      case 'user/message':
        messageSeqs.set(event.data.id, event.seq)
        break
      default:
        break
    }
  }
  return { selected, deniedSources, sourceClosureCache: new Map(), slices, readSets, messageSeqs }
}

function sourceClosureAllowed(session: Session, state: LineageState, seq: number,
  visiting: Set<number>): boolean {
  if (state.deniedSources.has(seq)) return false
  const cached = state.sourceClosureCache.get(seq)
  if (cached !== undefined) return cached
  // Session validates every provenance edge as an earlier dense-log reference.
  assert(!visiting.has(seq), 'Native source provenance cannot be cyclic')
  const event = session.eventAt(SessionSeq(seq))
  assert(event, `Native source provenance event ${String(seq)} is unavailable`)
  visiting.add(seq)
  const allowed = (event.sourceEventSeqs ?? []).every(sourceSeq =>
    sourceClosureAllowed(session, state, sourceSeq, visiting))
  visiting.delete(seq)
  state.sourceClosureCache.set(seq, allowed)
  return allowed
}

function validEvent(session: Session, state: LineageState, seq: number,
  cache: Map<number, boolean>, visiting: Set<number>): boolean {
  if (!state.selected.has(seq)) return false
  const cached = cache.get(seq)
  if (cached !== undefined) return cached
  if (visiting.has(seq)) return false
  visiting.add(seq)
  const event = session.eventAt(SessionSeq(seq))
  let valid = event !== undefined && sourceClosureAllowed(session, state, seq, new Set())
  if (event?.type === 'user/message'
    && (event.data.source.kind === 'agent-message' || event.data.source.kind === 'subagent-settled')) {
    const slice = state.slices.get(event.data.source.senderSessionId)
    valid = valid && slice !== undefined && slice.sourceEventSeqs.every(sourceSeq =>
      validEvent(session, state, sourceSeq, cache, visiting))
  } else if (event?.type === 'assistant/message') {
    const readSet = state.readSets.get(stepKey(event.data.turn, event.data.step))
    valid = valid && readSet !== undefined
      && readSet.historyEventSeqs.every(sourceSeq => validEvent(session, state, sourceSeq, cache, visiting))
      && readSet.acceptedMessageIds.every((id) => {
        const messageSeq = state.messageSeqs.get(id)
        return messageSeq !== undefined && validEvent(session, state, messageSeq, cache, visiting)
      })
  }
  visiting.delete(seq)
  cache.set(seq, valid)
  return valid
}

/**
 * Reserve a child dependency set in the parent's Session before materializing it.
 * @param session - Parent Session containing the selected immutable source events.
 * @param childId - Caller-reserved child identity passed to `startContinuable`.
 * @param sourceEventSeqs - Exact parent source events delivered to the child.
 * @returns The durable slice record appended to the parent Session.
 */
export function recordDelegationSlice(
  session: Session, childId: SessionId, sourceEventSeqs: readonly number[],
): DelegationSliceRecord {
  const current = new Set(revisionLineageSelection({ session, turn: -1, step: -1 }).eventSeqs)
  if (sourceEventSeqs.length === 0 || new Set(sourceEventSeqs).size !== sourceEventSeqs.length
    || sourceEventSeqs.some(seq => !current.has(seq))) {
    throw new Error('delegation slice must contain distinct currently selected source events')
  }
  if (session.snapshotEvents().some(event => event.type === 'contextify/delegation-slice'
    && event.data.childId === childId)) {
    throw new Error(`delegation slice for child "${childId}" already exists`)
  }
  const record = { childId, planRevision: currentContextPlan(session).revision,
    sourceEventSeqs: [...sourceEventSeqs] }
  session.append('contextify/delegation-slice', record)
  return record
}

type SourceBoundInput =
  | { readonly seq: number
    readonly kind: 'human' | 'web'
    readonly text: string }
  | { readonly seq: number
    readonly kind: 'web-recall'
    readonly sourceId: string
    readonly sourceSeq: number
    readonly text: string }

function textOnlySource(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'tool-result') return textOnlySource(block.content)
    throw new Error('source-bound delegation requires text-only source evidence')
  }).join('\n')
}

function renderSourceBoundInput(session: Session, seq: number,
  webCalls: ReadonlySet<string>): SourceBoundInput {
  const event = session.eventAt(SessionSeq(seq))
  const sourceSeq = event?.type === 'tool/result' && event.sourceEventSeqs?.length === 1
    ? event.sourceEventSeqs[0] : undefined
  const sourceCall = sourceSeq === undefined ? undefined : session.eventAt(SessionSeq(sourceSeq))
  if (event?.type === 'user/message' && event.data.source.kind === 'user'
    && event.data.content.length > 0) {
    return { seq, kind: 'human', text: textOnlySource(event.data.content) }
  }
  if (event?.type === 'tool/result' && webCalls.has(event.data.message.source.callId)
    && sourceCall?.type === 'tool/call'
    && (sourceCall.data.name === 'web_fetch' || sourceCall.data.name === 'web_search')
    && sourceCall.data.callId === event.data.message.source.callId) {
    return { seq, kind: 'web', text: textOnlySource(event.data.message.content) }
  }
  if (event?.type === 'context/compiler-snapshot') {
    const { message, provenance } = event.data
    const hash = createHash('sha256').update(JSON.stringify(message)).digest('hex')
    if (provenance?.provider === 'contextify'
      && provenance.sourceId !== session.id
      && Number.isSafeInteger(provenance.sourceSeq) && provenance.sourceSeq >= 0
      && provenance.contentHash === hash
      && message.role === 'user' && message.source.kind === 'plugin'
      && message.source.plugin === 'contextify' && message.source.form === 'recall'
      && message.content.length === 1 && message.content[0]?.type === 'text'
      && message.content[0].text.startsWith('Imported Web evidence.')) {
      return { seq, kind: 'web-recall', sourceId: provenance.sourceId,
        sourceSeq: provenance.sourceSeq, text: textOnlySource(message.content) }
    }
  }
  throw new Error('source-bound delegation requires text-only human or source-bound Web evidence events')
}

/** Selected sources that the text-only source-bound child can actually receive.
 * @param session - Native Session containing the selected source events.
 * @param beforeSeq - Optional exclusive cursor for earlier source pages.
 * @returns One bounded page of source previews and the next cursor.
 */
export function sourceBoundDelegationCandidates(session: Session, beforeSeq?: number): {
  readonly sources: readonly { readonly seq: number
    readonly kind: SourceBoundInput['kind']
    readonly preview: string }[]
  readonly nextBeforeSeq: number | null
} {
  if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || beforeSeq < 0)) {
    throw new Error('beforeSeq must be a non-negative safe Session sequence')
  }
  const webCalls = new Set(session.snapshotEvents().flatMap(event =>
    event.type === 'tool/call' && (event.data.name === 'web_fetch' || event.data.name === 'web_search')
      ? [event.data.callId] : []))
  const selected = revisionLineageSelection({ session, turn: -1, step: -1 }).eventSeqs
  const sources: { seq: number; kind: SourceBoundInput['kind']; preview: string }[] = []
  for (const seq of [...selected].reverse()) {
    if (beforeSeq !== undefined && seq >= beforeSeq) continue
    try {
      const item = renderSourceBoundInput(session, seq, webCalls)
      if (item.text.trim().length === 0) continue
      sources.push({ seq, kind: item.kind,
        preview: Array.from(item.text).slice(0, 180).join('') })
    } catch { continue }
    if (sources.length > 16) break
  }
  const hasMore = sources.length > 16
  const page = sources.slice(0, 16)
  if (hasMore) {
    // A dense push-built list with more than16 entries always yields a full16-item page.
    const oldest = page[page.length - 1]
    assert(oldest, 'Source pagination requires a full page when more sources remain')
    return { sources: page, nextBeforeSeq: oldest.seq }
  }
  return { sources: page, nextBeforeSeq: null }
}

/**
 * Start a text-only child with a prompt assembled from selected human messages
 * or native Web tool observations or a selected, imported Web recall snapshot.
 * This binds the delegated prompt and grants no global tools, but other mounted
 * plugins can still inject model-visible input (for example workspace instructions).
 * A complete source claim requires observing those inputs and any scoped tool reads.
 * @param ctx - Harness context owning the continuable subagent service.
 * @param parent - Parent Agent containing the source events.
 * @param childId - Unused durable child identity reserved by the caller.
 * @param sourceEventSeqs - Selected human goal and Web evidence events to render.
 * @param signal - Cancellation until the child accepts its prompt.
 * @returns The started child and accepted initial prompt identity.
 */
export async function startSourceBoundContinuable(
  ctx: Context, parent: Agent, childId: SessionId,
  sourceEventSeqs: readonly number[], signal: AbortSignal,
): Promise<ContinuableStart> {
  const webCalls = new Set(parent.session.snapshotEvents().flatMap(event =>
    event.type === 'tool/call' && (event.data.name === 'web_fetch' || event.data.name === 'web_search')
      ? [event.data.callId] : []))
  const sourceTexts = sourceEventSeqs.map(seq => renderSourceBoundInput(parent.session, seq, webCalls))
  recordDelegationSlice(parent.session, childId, sourceEventSeqs)
  return ctx.subagents.startContinuable({
    provider: 'spawn', childId, label: 'Source-bound analysis', signal,
    request: {
      parent,
      prompt: [{ type: 'text', text: `Analyze these recorded sources using only their content.\n${JSON.stringify(sourceTexts)}` }],
      toolFilter: { allow: [] },
    },
  })
}

/**
 * Check whether a child's recorded inputs remain selected by the current Plan.
 * @param session - Parent Session that owns the child's slice.
 * @param childId - Child whose result is proposed for admission.
 * @returns Whether every recorded dependency remains recursively valid.
 */
export function childMessageAdmissible(session: Session, childId: SessionId): boolean {
  const state = lineageState(session, compileContextify({ session, turn: -1, step: -1 }).eventSeqs)
  const slice = state.slices.get(childId)
  if (slice === undefined) return false
  const cache = new Map<number, boolean>()
  return slice.sourceEventSeqs.every(seq => validEvent(session, state, seq, cache, new Set()))
}

/**
 * Deny every tool for a delegated child once any recorded parent source is
 * no longer selected. This is an opt-in Context Plan dependency check, not a
 * complete input or intent policy: callers must still account for ambient
 * prompts, unrecorded reads, and effects already started before an edit.
 * @param ctx - Cordis context providing the tool guard.
 * @param parent - Parent Agent that owns the Context Plan.
 * @param childIds - Delegated children subject to source checks.
 * @returns The Cordis effect disposer.
 */
export function guardDelegatedToolCalls(
  ctx: Context, parent: Agent,
  childIds: ReadonlySet<SessionId>,
): () => void {
  const protectedChildren = new Set(childIds)
  return ctx.tools.guard((exec) => {
    const childId = exec.agent?.id
    if (childId === undefined || !protectedChildren.has(childId)) return undefined
    if (ctx.agents.get(parent.id) !== parent
      || !childMessageAdmissible(parent.session, childId)) {
      return 'delegated source is no longer valid under the current Context Plan'
    }
    return undefined
  })
}

/**
 * Log selected history and accepted input before the model request can produce an answer.
 * @param session - Parent Session about to enter a step.
 * @param turn - Upcoming turn number.
 * @param step - Upcoming step number.
 * @param accepted - Exact messages admitted by the pre-step waterfall.
 * @returns The durable read-set record appended before `step/start`.
 */
export function recordRequestReadSet(
  session: Session, turn: number, step: number, accepted: readonly UserMessage[],
): RequestReadSetRecord {
  if (session.snapshotEvents().some(event => event.type === 'contextify/request-read-set'
    && event.data.turn === turn && event.data.step === step)) {
    throw new Error(`request read set for ${stepKey(turn, step)} already exists`)
  }
  for (const message of accepted) {
    if ((message.source.kind === 'agent-message' || message.source.kind === 'subagent-settled')
      && !childMessageAdmissible(session, message.source.senderSessionId)) {
      throw new Error(`uncertified or stale child message from "${message.source.senderSessionId}"`)
    }
  }
  const historyEventSeqs = revisionLineageSelection({ session, turn, step }).eventSeqs
  const record = { turn, step, planRevision: currentContextPlan(session).revision,
    historyEventSeqs: [...historyEventSeqs], acceptedMessageIds: accepted.map(message => message.id) }
  session.append('contextify/request-read-set', record)
  return record
}

/**
 * Select only Contextify messages whose recursively recorded inputs remain current.
 * @param request - Session and Agent Loop coordinates for one request.
 * @returns Ordered event sequences valid under the current Context Plan.
 */
export function revisionLineageSelection(request: {
  readonly session: Session
  readonly turn: number
  readonly step: number
}): { readonly eventSeqs: readonly number[] } {
  const base = compileContextify(request)
  const state = lineageState(request.session, base.eventSeqs)
  const cache = new Map<number, boolean>()
  return { eventSeqs: base.eventSeqs.filter(seq =>
    validEvent(request.session, state, seq, cache, new Set())) }
}

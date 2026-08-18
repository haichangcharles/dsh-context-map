/** Pure revision history and model-message selection for native Contextify plans. */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-context-compiler'
import type {
  ContextIncludedNode,
  ContextPlanSnapshot,
  ContextPlanState,
  ContextReplacementNode,
  ContextifyCompilation,
} from './types.ts'

function freezePlan(plan: ContextPlanSnapshot): ContextPlanSnapshot {
  return Object.freeze({
    ...plan,
    history: Object.freeze({
      past: Object.freeze([...plan.history.past]),
      future: Object.freeze([...plan.history.future]),
    }),
    excluded: Object.freeze(plan.excluded.map(item => Object.freeze({ ...item }))),
    included: Object.freeze(plan.included.map(item => Object.freeze({ ...item }))),
    replacements: Object.freeze(plan.replacements.map(item => Object.freeze({ ...item }))),
  })
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`)
}

function assertPlanState(state: ContextPlanState): void {
  const nodeIds = new Set<string>()
  const eventSeqs = new Set<number>()
  for (const excluded of state.excluded) {
    if (excluded.nodeId.length === 0 || nodeIds.has(excluded.nodeId)) {
      throw new Error('Contextify excluded node ids must be non-empty and unique')
    }
    if (!Number.isSafeInteger(excluded.eventSeq) || excluded.eventSeq < 0 || eventSeqs.has(excluded.eventSeq)) {
      throw new Error('Contextify excluded event sequences must be non-negative and unique')
    }
    nodeIds.add(excluded.nodeId)
    eventSeqs.add(excluded.eventSeq)
  }
  for (const included of state.included) {
    if (included.nodeId.length === 0 || nodeIds.has(included.nodeId)) {
      throw new Error('Contextify selected node ids must be non-empty and unique')
    }
    if (!Number.isSafeInteger(included.snapshotSeq) || included.snapshotSeq < 0
      || !Number.isSafeInteger(included.position) || included.position < 0) {
      throw new Error('Contextify included snapshot sequences and positions must be non-negative safe integers')
    }
    nodeIds.add(included.nodeId)
  }
  const replacementNodeIds = new Set<string>()
  const replacementSnapshotSeqs = new Set<number>()
  for (const replacement of state.replacements) {
    if (replacement.nodeId.length === 0 || replacementNodeIds.has(replacement.nodeId)) {
      throw new Error('Contextify replacement node ids must be non-empty and unique')
    }
    if (!Number.isSafeInteger(replacement.snapshotSeq) || replacement.snapshotSeq < 0
      || replacementSnapshotSeqs.has(replacement.snapshotSeq)) {
      throw new Error('Contextify replacement snapshot sequences must be non-negative and unique')
    }
    if (replacement.originalEventSeq !== null
      && (!Number.isSafeInteger(replacement.originalEventSeq) || replacement.originalEventSeq < 0)) {
      throw new Error('Contextify replacement original event sequence must be null or non-negative')
    }
    if ((replacement.role !== 'user' && replacement.role !== 'assistant')
      || replacement.kind !== 'placeholder' || replacement.reason.trim().length === 0) {
      throw new Error('Contextify replacement metadata is invalid')
    }
    replacementNodeIds.add(replacement.nodeId)
    replacementSnapshotSeqs.add(replacement.snapshotSeq)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isExcludedNode(value: unknown): boolean {
  return isRecord(value)
    && typeof value.nodeId === 'string'
    && Number.isSafeInteger(value.eventSeq)
    && (value.eventSeq as number) >= 0
}

function isIncludedNode(value: unknown): boolean {
  return isRecord(value)
    && typeof value.nodeId === 'string'
    && Number.isSafeInteger(value.snapshotSeq)
    && (value.snapshotSeq as number) >= 0
    && Number.isSafeInteger(value.position)
    && (value.position as number) >= 0
}

function isReplacementNode(value: unknown): value is ContextReplacementNode {
  return isRecord(value)
    && typeof value.nodeId === 'string'
    && Number.isSafeInteger(value.snapshotSeq)
    && (value.snapshotSeq as number) >= 0
    && (value.originalEventSeq === null
      || (Number.isSafeInteger(value.originalEventSeq) && (value.originalEventSeq as number) >= 0))
    && (value.role === 'user' || value.role === 'assistant')
    && value.kind === 'placeholder'
    && typeof value.reason === 'string'
}

interface ContextPlanSnapshotV2 {
  readonly kind: 'contextify/plan'
  readonly version: 2
  readonly revision: number
  readonly stateRevision: number
  readonly history: { readonly past: readonly number[]; readonly future: readonly number[] }
  readonly excluded: ContextPlanSnapshot['excluded']
  readonly included: ContextPlanSnapshot['included']
}

function hasCommonPlanShape(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 1
    && Number.isSafeInteger(value.stateRevision) && (value.stateRevision as number) >= 1
    && isRecord(value.history) && Array.isArray(value.history.past)
    && Array.isArray(value.history.future) && Array.isArray(value.excluded)
    && Array.isArray(value.included)
    && value.history.past.every(revision => Number.isSafeInteger(revision) && revision >= 1)
    && value.history.future.every(revision => Number.isSafeInteger(revision) && revision >= 1)
    && value.excluded.every(isExcludedNode)
    && value.included.every(isIncludedNode)
}

/**
 * Test whether durable data is a complete version-three Context Plan.
 * @param value - Unknown event payload loaded from current or legacy persistence.
 * @returns Whether every field needed by compilation and history is present.
 */
export function isContextPlanSnapshot(value: unknown): value is ContextPlanSnapshot {
  return isRecord(value) && value.kind === 'contextify/plan' && value.version === 3
    && hasCommonPlanShape(value) && Array.isArray(value.replacements)
    && value.replacements.every(isReplacementNode)
}

/** Normalize supported durable plans without appending a migration event. */
export function normalizeContextPlanSnapshot(value: unknown): ContextPlanSnapshot | null {
  if (isContextPlanSnapshot(value)) return freezePlan(value)
  if (!isRecord(value) || value.kind !== 'contextify/plan' || value.version !== 2
    || !hasCommonPlanShape(value)) return null
  const legacy = value as unknown as ContextPlanSnapshotV2
  return freezePlan({ ...legacy, version: 3, replacements: [] })
}

/**
 * Create a Natural plan with no explicit message choices.
 * @param revision - First durable revision for a fresh or reset child Session.
 * @returns A deeply frozen version-three Context Plan.
 */
export function createInitialContextPlan(revision = 1): ContextPlanSnapshot {
  assertRevision(revision, 'Contextify plan revision')
  return freezePlan({
    kind: 'contextify/plan',
    version: 3,
    revision,
    stateRevision: revision,
    history: { past: [], future: [] },
    excluded: [],
    included: [],
    replacements: [],
  })
}

/**
 * Create a new selection state after an ordinary user mutation.
 * @param current - Current complete plan.
 * @param state - Replacement Include and Exclude selections.
 * @returns A frozen revision with Redo history cleared.
 */
export function nextPlan(current: ContextPlanSnapshot, state: ContextPlanState): ContextPlanSnapshot {
  assertPlanState(state)
  const revision = current.revision + 1
  assertRevision(revision, 'Contextify plan revision')
  return freezePlan({
    kind: 'contextify/plan',
    version: 3,
    revision,
    stateRevision: revision,
    history: { past: [...current.history.past, current.stateRevision], future: [] },
    excluded: state.excluded,
    included: state.included,
    replacements: state.replacements,
  })
}

/**
 * Create a Natural state as the next mutation revision.
 * @param current - Current complete plan.
 * @returns A frozen empty-selection revision.
 */
export function resetPlan(current: ContextPlanSnapshot): ContextPlanSnapshot {
  return nextPlan(current, { excluded: [], included: [], replacements: [] })
}

function planAtStateRevision(session: Session, stateRevision: number): ContextPlanSnapshot {
  const event = session.events.find(candidate =>
    candidate.type === 'contextify/plan' && candidate.data.revision === stateRevision)
  if (event?.type !== 'contextify/plan') {
    throw new Error(`Contextify history revision ${String(stateRevision)} is unavailable`)
  }
  const plan = normalizeContextPlanSnapshot(event.data)
  if (plan === null) throw new Error(`Contextify history revision ${String(stateRevision)} is invalid`)
  return plan
}

/**
 * Move to the previous selection state without rewriting an earlier event.
 * @param session - Session containing referenced plan revisions.
 * @param current - Current complete plan.
 * @returns A new revision, or null when no prior state exists.
 */
export function undoPlan(session: Session, current: ContextPlanSnapshot): ContextPlanSnapshot | null {
  const targetRevision = current.history.past.at(-1)
  if (targetRevision === undefined) return null
  const target = planAtStateRevision(session, targetRevision)
  return freezePlan({
    ...target,
    revision: current.revision + 1,
    stateRevision: target.stateRevision,
    history: {
      past: current.history.past.slice(0, -1),
      future: [current.stateRevision, ...current.history.future],
    },
  })
}

/**
 * Move to the next selection state without rewriting an earlier event.
 * @param session - Session containing referenced plan revisions.
 * @param current - Current complete plan.
 * @returns A new revision, or null when no future state exists.
 */
export function redoPlan(session: Session, current: ContextPlanSnapshot): ContextPlanSnapshot | null {
  const targetRevision = current.history.future[0]
  if (targetRevision === undefined) return null
  const target = planAtStateRevision(session, targetRevision)
  return freezePlan({
    ...target,
    revision: current.revision + 1,
    stateRevision: target.stateRevision,
    history: {
      past: [...current.history.past, current.stateRevision],
      future: current.history.future.slice(1),
    },
  })
}

/**
 * Fold the latest durable plan from one Session.
 * @param session - Session whose Context Plan is requested.
 * @returns The latest plan or a detached Natural default before initialization.
 */
export function currentContextPlan(session: Session): ContextPlanSnapshot {
  const latest = session.events.findLast(event => event.type === 'contextify/plan')?.data
  return normalizeContextPlanSnapshot(latest) ?? createInitialContextPlan()
}

function eventTurns(events: readonly SessionEvent[]): ReadonlyMap<number, number> {
  const turns = new Map<number, number>()
  let openTurn: number | undefined
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = event.data.turn
    if (event.type === 'user/message' && openTurn !== undefined) turns.set(event.seq, openTurn)
    if (event.type === 'assistant/message' || event.type === 'tool/result') {
      turns.set(event.seq, event.data.turn)
    }
    if (event.type === 'turn/end' && event.data.turn === openTurn) openTurn = undefined
  }
  return turns
}

function toolGroups(session: Session): ReadonlyMap<number, ReadonlySet<number>> {
  const resultByCall = new Map<string, number>()
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (event?.type === 'tool/result') resultByCall.set(event.data.message.source.callId, seq)
  }
  const bySeq = new Map<number, ReadonlySet<number>>()
  for (const seq of session.surface.nodes) {
    const event = session.events[seq]
    if (event?.type !== 'assistant/message') continue
    const calls = event.data.message.content.flatMap(block => block.type === 'tool-call' ? [block.id] : [])
    if (calls.length === 0) continue
    const group = new Set<number>([seq])
    for (const call of calls) {
      const result = resultByCall.get(call)
      if (result !== undefined) group.add(result)
    }
    for (const member of group) bySeq.set(member, group)
  }
  return bySeq
}

function insertSnapshots(
  eventSeqs: number[],
  included: readonly ContextIncludedNode[],
  replacements: ReadonlyMap<string, ContextReplacementNode>,
  session: Session,
): void {
  const ordered = [...included].sort((left, right) =>
    left.position - right.position || left.snapshotSeq - right.snapshotSeq)
  let samePositionOffset = 0
  let previousPosition = -1
  for (const item of ordered) {
    const selectedSeq = replacements.get(item.nodeId)?.snapshotSeq ?? item.snapshotSeq
    const event = session.events[selectedSeq]
    if (event?.type !== 'context/compiler-snapshot') {
      throw new Error(`Contextify included snapshot event ${String(selectedSeq)} is unavailable`)
    }
    if (eventSeqs.includes(selectedSeq)) throw new Error('Contextify included snapshot is duplicated')
    samePositionOffset = item.position === previousPosition ? samePositionOffset + 1 : 0
    previousPosition = item.position
    eventSeqs.splice(Math.min(item.position + samePositionOffset, eventSeqs.length), 0, selectedSeq)
  }
}

function selectedMessage(session: Session, seq: number): Message {
  const event = session.events[seq]
  if (event === undefined) throw new Error(`Contextify selected missing event ${String(seq)}`)
  if (event.type === 'context/compiler-snapshot') return event.data.message
  const message = session.deriveEventMessage(event)
  if (message === null) throw new Error(`Contextify selected non-message event ${String(seq)}`)
  return message
}

function validateReplacementEvents(session: Session, replacements: readonly ContextReplacementNode[]): void {
  for (const replacement of replacements) {
    const snapshot = session.events[replacement.snapshotSeq]
    if (snapshot?.type !== 'context/compiler-snapshot' || snapshot.data.message.role !== replacement.role) {
      throw new Error(`Contextify replacement snapshot ${String(replacement.snapshotSeq)} is unavailable or has the wrong role`)
    }
    if (replacement.originalEventSeq === null) continue
    const original = session.events[replacement.originalEventSeq]
    const message = original === undefined ? null : session.deriveEventMessage(original)
    if (message === null || message.role !== replacement.role) {
      throw new Error(`Contextify replacement original event ${String(replacement.originalEventSeq)} is unavailable or has the wrong role`)
    }
  }
}

/**
 * Compile the active Session's Natural surface plus explicit native-family choices.
 * @param request - Session and current Agent Loop coordinates.
 * @returns Frozen ordered local event sequences and exact model messages.
 */
export function compileContextify(request: {
  readonly session: Session
  readonly turn: number
  readonly step: number
}): ContextifyCompilation {
  const plan = currentContextPlan(request.session)
  validateReplacementEvents(request.session, plan.replacements)
  const selected = new Set(request.session.surface.nodes)
  const groups = toolGroups(request.session)
  const excludedGroups = new Set<ReadonlySet<number>>()
  for (const excluded of plan.excluded) {
    const group = groups.get(excluded.eventSeq)
    if (group === undefined) selected.delete(excluded.eventSeq)
    else excludedGroups.add(group)
  }
  for (const group of excludedGroups) for (const seq of group) selected.delete(seq)

  const turns = eventTurns(request.session.events)
  for (const seq of request.session.surface.nodes) {
    if (turns.get(seq) !== request.turn) continue
    const group = groups.get(seq)
    if (group === undefined) selected.add(seq)
    else for (const member of group) selected.add(member)
  }

  const replacements = new Map(plan.replacements.map(item => [item.nodeId, item]))
  const activeReplacementBySeq = new Map(plan.replacements.flatMap(item =>
    item.originalEventSeq === null ? [] : [[item.originalEventSeq, item.snapshotSeq] as const]))
  const eventSeqs = request.session.surface.nodes
    .filter(seq => selected.has(seq))
    .map(seq => activeReplacementBySeq.get(seq) ?? seq)
  if (new Set(eventSeqs).size !== eventSeqs.length) throw new Error('Contextify replacement snapshot is duplicated')
  insertSnapshots(eventSeqs, plan.included, replacements, request.session)
  const messages = eventSeqs.map(seq => selectedMessage(request.session, seq))
  return Object.freeze({
    eventSeqs: Object.freeze(eventSeqs),
    messages: Object.freeze(messages),
  })
}

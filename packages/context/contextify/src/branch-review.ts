/** Pure completed-Turn extraction and untrusted Branch decision validation. */
import { createHash } from 'node:crypto'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextBranchCandidate } from './types.ts'

const MAX_REASON_CHARS = 500

function eventText(event: SessionEvent): string {
  const message = event.type === 'user/message'
    ? event.data
    : event.type === 'assistant/message' ? event.data.message : undefined
  if (message === undefined) return ''
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'image' ? ['[Image]'] : [])
    .join('\n').slice(0, 2_000)
}

/**
 * Select the first human input and final visible assistant output of one completed Turn.
 * @param events - Source Session event log.
 * @param turnEndSeq - Sequence of the completed `turn/end` boundary.
 * @param sourceSessionId - Native Session that owns the Turn.
 * @returns A relocation candidate, or null when the Turn is incomplete or lacks either endpoint.
 */
export function completedTurnCandidate(
  events: readonly SessionEvent[],
  turnEndSeq: number,
  sourceSessionId: SessionId,
): ContextBranchCandidate | null {
  const end = events[turnEndSeq]
  if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return null
  let startSeq = -1
  for (let seq = turnEndSeq - 1; seq >= 0; seq -= 1) {
    const event = events[seq]
    if (event?.type === 'turn/start' && event.data.turn === end.data.turn) { startSeq = seq; break }
  }
  if (startSeq < 0) return null
  const within = events.slice(startSeq + 1, turnEndSeq)
  const input = within.find(event => event.type === 'user/message'
    && event.surfaceOp === 'append' && event.data.source.kind === 'user')
  const outputs = within.filter(event => event.type === 'assistant/message'
    && event.surfaceOp === 'append' && event.data.message.content.some(block => block.type === 'text' || block.type === 'image'))
  const output = outputs.at(-1)
  if (input?.type !== 'user/message' || output?.type !== 'assistant/message') return null
  return Object.freeze({
    sourceSessionId,
    turn: end.data.turn,
    boundaryBefore: startSeq - 1,
    boundaryAfter: turnEndSeq,
    input: Object.freeze({ sessionId: sourceSessionId, seq: input.seq }),
    output: Object.freeze({ sessionId: sourceSessionId, seq: output.seq }),
    inputPreview: eventText(input),
    outputPreview: eventText(output),
  })
}

/** Validated output of the bounded Branch review Agent. */
export interface ContextBranchDecision {
  readonly action: 'keep' | 'suggest_branch'
  readonly confidence: number
  readonly reason: string
}

/**
 * Validate and strip one bounded, tool-free Agent decision.
 * @param value - Untrusted structured Agent output.
 * @returns The bounded Branch decision.
 */
export function validateBranchDecision(value: unknown): ContextBranchDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('branch decision must be an object')
  const record = value as Record<string, unknown>
  if (record.action !== 'keep' && record.action !== 'suggest_branch') throw new Error('branch decision action is invalid')
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)
    || record.confidence < 0 || record.confidence > 1) throw new Error('branch decision confidence is invalid')
  if (typeof record.reason !== 'string' || record.reason.trim().length < 1
    || record.reason.trim().length > MAX_REASON_CHARS) throw new Error('branch decision reason is invalid')
  return Object.freeze({ action: record.action, confidence: record.confidence, reason: record.reason.trim() })
}

/**
 * Parse one text-only auxiliary response while tolerating a surrounding Markdown fence.
 * @param text - Untrusted model output containing one JSON object.
 * @returns The validated Branch decision.
 */
export function parseBranchDecisionText(text: string): ContextBranchDecision {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('branch decision did not contain a JSON object')
  return validateBranchDecision(JSON.parse(text.slice(start, end + 1)) as unknown)
}

/**
 * Stable retry key for one source Turn relocation.
 * @param sessionId - Source native Session.
 * @param turnEndSeq - Completed Turn boundary in that Session.
 * @returns A deterministic SHA-256 key.
 */
export function branchRelocationKey(sessionId: SessionId, turnEndSeq: number): string {
  return createHash('sha256').update(`${sessionId}:${String(turnEndSeq)}`).digest('hex')
}

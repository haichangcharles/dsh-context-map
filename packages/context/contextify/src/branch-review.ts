/** Pure completed-Turn extraction and untrusted Branch decision validation. */
import { createHash } from 'node:crypto'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextBranchCandidate, ContextFamilyGraph, ContextFamilyGraphNode } from './types.ts'

const MAX_REASON_CHARS = 500
/** Completed local Turns retained by the lightweight classifier packet. */
export const BRANCH_RECENT_TURNS = 3
/** Sibling branch intents retained by the lightweight classifier packet. */
export const BRANCH_SIBLING_INTENTS = 4
/** Maximum Unicode characters retained from any one message. */
export const BRANCH_MAX_TEXT_CHARS = 800
/** Hard output ceiling for the direct Branch classifier call. */
export const BRANCH_REVIEW_MAX_TOKENS = 200

/** Small topology-aware value sent to the tool-free Branch classifier. */
export interface ContextBranchReviewInput {
  readonly candidateInput: string
  readonly currentObjective: string
  readonly ancestorObjectives: readonly string[]
  readonly recentTurns: readonly { readonly input: string; readonly output: string }[]
  readonly branchDepth: number
  readonly activeBranchCount: number
  readonly siblingIntents: readonly string[]
}

function bounded(value: string): string {
  return Array.from(value.trim()).slice(0, BRANCH_MAX_TEXT_CHARS).join('')
}

function latestUser(
  nodes: readonly ContextFamilyGraphNode[],
  ownerSessionId: SessionId,
  beforeIndex: number,
): ContextFamilyGraphNode | undefined {
  return nodes.slice(0, beforeIndex).findLast(node => node.role === 'user'
    && node.owner.sessionId === ownerSessionId)
}

/** Raise the display threshold as a family becomes deeper and more branched. */
export function branchSuggestionThreshold(depth: number, activeBranches: number): number {
  return Math.min(0.95, 0.80 + Math.min(depth, 3) * 0.03 + Math.min(activeBranches, 6) * 0.01)
}

/**
 * Build a bounded classifier packet from topology and visible input/output nodes.
 * It intentionally excludes tool calls, reasoning, and the complete graph.
 */
export function buildBranchReviewInput(input: {
  readonly graph: ContextFamilyGraph
  readonly candidateNodeId: string
  readonly contents?: Readonly<Record<string, string>>
}): ContextBranchReviewInput {
  const candidate = input.graph.nodes.find(node => node.id === input.candidateNodeId)
  if (candidate === undefined || candidate.role !== 'user') throw new Error('Branch candidate input is unavailable')
  const candidateIndex = input.graph.nodes.indexOf(candidate)
  const active = input.graph.sessions.find(session => session.id === input.graph.activeSessionId)
  if (active === undefined) throw new Error('active Branch Session is unavailable')
  const bySession = new Map(input.graph.sessions.map(session => [session.id, session]))
  const text = (node: ContextFamilyGraphNode | undefined): string => node === undefined
    ? ''
    : bounded(input.contents?.[node.id] ?? node.preview)
  const ancestors: SessionId[] = []
  let cursor = active
  while (cursor.parentSessionId !== undefined) {
    ancestors.unshift(cursor.parentSessionId)
    const parent = bySession.get(cursor.parentSessionId)
    if (parent === undefined) break
    cursor = parent
  }
  const activePath = input.graph.nodes
    .filter(node => node.sessionIds.includes(input.graph.activeSessionId)
      && input.graph.nodes.indexOf(node) < candidateIndex && node.id !== candidate.id)
    .sort((left, right) => (left.activeEventSeq ?? left.time) - (right.activeEventSeq ?? right.time))
  const localObjective = latestUser(input.graph.nodes, active.id, candidateIndex)
    ?? activePath.findLast(node => node.role === 'user')
  const localNodes = activePath.filter(node => node.owner.sessionId === active.id)
  const recentTurns: Array<{ input: string; output: string }> = []
  for (let index = 0; index < localNodes.length; index += 1) {
    const node = localNodes[index]
    if (node?.role !== 'user') continue
    const output = localNodes.slice(index + 1).find(next => next.role === 'assistant')
    if (output === undefined) continue
    recentTurns.push({ input: text(node), output: text(output) })
  }
  const siblings = input.graph.sessions.filter(session => session.id !== active.id
    && session.parentSessionId === active.parentSessionId)
  return Object.freeze({
    candidateInput: text(candidate),
    currentObjective: text(localObjective),
    ancestorObjectives: Object.freeze(ancestors.flatMap((sessionId) => {
      const objective = latestUser(input.graph.nodes, sessionId, candidateIndex)
      return objective === undefined ? [] : [text(objective)]
    })),
    recentTurns: Object.freeze(recentTurns.slice(-BRANCH_RECENT_TURNS).map(turn => Object.freeze(turn))),
    branchDepth: active.depth,
    activeBranchCount: siblings.length + 1,
    siblingIntents: Object.freeze(siblings.flatMap((session) => {
      const objective = latestUser(input.graph.nodes, session.id, input.graph.nodes.length)
      return objective === undefined ? [] : [text(objective)]
    }).slice(0, BRANCH_SIBLING_INTENTS)),
  })
}

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

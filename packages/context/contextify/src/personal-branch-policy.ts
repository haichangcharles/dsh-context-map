/** Training-free calibration for visible Branch suggestion choices. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph, ContextFamilyInspection } from './types.ts'
import { jaccardOverlap } from './lexical-tokens.ts'

/** One UI-declared response to a persisted Branch suggestion. */
export interface PersonalBranchFeedback {
  readonly candidateInput: string
  readonly branchDepth: number
  readonly confidence: number
  readonly choice: 'keep' | 'move'
  readonly uiOrigin?: 'contextify-client'
}

/** New Branch candidate to compare with earlier responses. */
export interface PersonalBranchQuery {
  readonly candidateInput: string
  readonly branchDepth: number
}

/**
 * Extract UI-declared choices once from the owning part of each Session log.
 * @param graph - Current native Session family projection.
 * @param inspections - Session logs with inherited-prefix counts.
 * @returns The latest 32 owned Keep/Move responses to persisted suggestions.
 */
export function branchFeedbackFromFamily(
  graph: ContextFamilyGraph,
  inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
): readonly PersonalBranchFeedback[] {
  const depths = new Map(graph.sessions.map(session => [session.id, session.depth]))
  const result: { time: number; sessionId: string; seq: number; feedback: PersonalBranchFeedback }[] = []
  for (const inspection of inspections.values()) {
    const suggestions = new Map(inspection.events.flatMap(event =>
      event.type === 'contextify/branch-review' && event.data.suggestion !== null
        ? [[event.data.suggestion.id, event.data.suggestion] as const]
        : []))
    for (const event of inspection.events.slice(inspection.inheritedEventCount)) {
      if (event.type !== 'contextify/branch-choice'
        || event.data.uiOrigin !== 'contextify-client') continue
      const suggestion = suggestions.get(event.data.suggestionId)
      const branchDepth = suggestion === undefined ? undefined : depths.get(suggestion.sourceSessionId)
      if (suggestion === undefined || branchDepth === undefined) continue
      result.push({
        time: event.time, sessionId: String(inspection.meta.id), seq: event.seq,
        feedback: {
          candidateInput: suggestion.inputPreview,
          branchDepth,
          confidence: suggestion.confidence,
          choice: event.data.choice,
          uiOrigin: event.data.uiOrigin,
        },
      })
    }
  }
  return result.sort((left, right) => left.time - right.time
    || left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
    .slice(-32).map(item => item.feedback)
}

/**
 * Calibrate the suggestion boundary from UI-declared Keep/Move actions.
 * Explicit Move and Keep choices have equal, opposite influence. The residual
 * is conditioned on candidate wording and graph depth, shrunk toward zero with
 * two pseudo-observations, and capped at five points.
 * @param base - Generic confidence threshold.
 * @param query - Current candidate wording and Branch depth.
 * @param history - Earlier UI-declared Keep/Move responses.
 * @returns Bounded personalized suggestion threshold.
 */
export function personalBranchThreshold(
  base: number,
  query: PersonalBranchQuery,
  history: readonly PersonalBranchFeedback[],
): number {
  let residual = 0
  let exposure = 0
  for (const item of history) {
    if (item.uiOrigin !== 'contextify-client'
      || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) continue
    const weight = 0.25
      + 0.5 / (1 + Math.abs(query.branchDepth - item.branchDepth))
      + 0.25 * jaccardOverlap(query.candidateInput, item.candidateInput)
    residual += weight * (item.choice === 'move' ? 1 : -1)
    exposure += weight
  }
  const correction = Math.max(-0.05, Math.min(0.05, -0.08 * residual / (2 + exposure)))
  return Math.max(0, Math.min(1, base + correction))
}

function branchStyleMoveRate(
  query: PersonalBranchQuery,
  history: readonly PersonalBranchFeedback[],
): number | null {
  const eligible = history.filter(item => item.uiOrigin === 'contextify-client'
    && Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1
    && Math.abs(query.branchDepth - item.branchDepth) <= 1)
  if (eligible.length < 5) return null
  return (1 + eligible.filter(item => item.choice === 'move').length) / (2 + eligible.length)
}

/**
 * Suppress a generic Move card after repeated same-family Keep decisions.
 * The strong style path is limited to nearby graph depths and non-extreme model
 * confidence; explicit requests to branch still bypass this suggestion policy.
 * @param query - Current candidate wording and Branch depth.
 * @param moveConfidence - Generic classifier confidence in Move.
 * @param history - Earlier UI-declared Keep/Move choices.
 * @returns Whether the user has established a conservative Keep style.
 */
export function personalBranchSuppressionFromMove(
  query: PersonalBranchQuery,
  moveConfidence: number,
  history: readonly PersonalBranchFeedback[],
): boolean {
  if (!Number.isFinite(moveConfidence) || moveConfidence < 0.5 || moveConfidence > 0.92) return false
  const moveRate = branchStyleMoveRate(query, history)
  return moveRate !== null && moveRate <= 0.25
}

/**
 * Give a weak generic Keep a reviewable Move suggestion when similar direct
 * decisions repeatedly favored Move. This never forks without user approval.
 * @param query - Current candidate wording and Branch depth.
 * @param keepConfidence - Generic classifier confidence in Keep.
 * @param history - Earlier UI-declared Keep/Move choices.
 * @returns A bounded personalized suggestion, or null without strong evidence.
 */
export function personalBranchSuggestionFromKeep(
  query: PersonalBranchQuery,
  keepConfidence: number,
  history: readonly PersonalBranchFeedback[],
): { readonly confidence: number; readonly reason: string } | null {
  if (!Number.isFinite(keepConfidence) || keepConfidence < 0.5) return null
  const styleMoveRate = branchStyleMoveRate(query, history)
  if (keepConfidence <= 0.9 && styleMoveRate !== null && styleMoveRate >= 0.75) {
    return {
      confidence: styleMoveRate,
      reason: 'You moved most earlier reviewed conversations to new branches; review this placement.',
    }
  }
  if (keepConfidence > 0.6) return null
  let moveCount = 0
  let moveWeight = 0
  let totalWeight = 0
  for (const item of history) {
    if (item.uiOrigin !== 'contextify-client'
      || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) continue
    const overlap = jaccardOverlap(query.candidateInput, item.candidateInput)
    if (overlap < 0.15) continue
    const weight = (0.5 + 0.5 * overlap)
      * (0.7 + 0.3 / (1 + Math.abs(query.branchDepth - item.branchDepth)))
    totalWeight += weight
    if (item.choice === 'move') {
      moveCount += 1
      moveWeight += weight
    }
  }
  if (moveCount < 3) return null
  const personalMoveRate = (1 + moveWeight) / (2 + totalWeight)
  if (personalMoveRate < 0.75) return null
  const confidence = 1 - keepConfidence + 0.5 * (personalMoveRate - 0.5)
  if (confidence < 0.575) return null
  return {
    confidence,
    reason: 'You moved similar earlier conversations to a new branch; review whether this Q&A belongs there.',
  }
}

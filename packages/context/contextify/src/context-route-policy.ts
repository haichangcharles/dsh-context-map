/** Review-only routing over a native Session family. No Session or Plan mutation here. */
import type { ContextFamilyGraph } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { jaccardOverlap } from './lexical-tokens.ts'

/** Interpreted purpose of the draft turn before selecting a native Session. */
export type ContextRouteIntent = 'continue' | 'resume' | 'reference' | 'new-task' | 'return' | 'unknown'
/** Reviewable routing or context-import action for one draft turn. */
export type ContextRouteAction = 'continue' | 'include' | 'navigate' | 'branch' | 'return'

/** One branch and its owned source candidates from the native family graph. */
export interface ContextRouteCandidate {
  readonly sessionId: SessionId
  readonly parentSessionId?: SessionId
  readonly depth: number
  readonly label: string
  readonly ownedNodeIds: readonly string[]
  /** Owned material absent from the active path; only these IDs may be imported. */
  readonly offPathNodeIds: readonly string[]
  /** Retrieval score only; semantic utility must be decided separately. */
  readonly lexicalScore: number
  readonly workState?: ContextFamilyGraph['sessions'][number]['workState']
}

/** Independent destination, evidence, and correction scores for one branch. */
export interface ScoredContextRouteCandidate extends ContextRouteCandidate {
  /** Ranking signal for the place where the next user turn belongs. */
  readonly destinationScore: number
  /** Ranking signal for material useful in the next answer. */
  readonly evidenceScore: number
  /** Ranking signal for later corrections making the candidate unsafe to reuse. */
  readonly supersededScore: number
  /** Bounded, dependency-closed source selection supplied by the scorer. */
  readonly evidenceNodeIds?: readonly string[]
}

/** A review-only action; callers must revalidate revisions before applying it. */
export interface ContextRouteProposal {
  readonly action: ContextRouteAction
  readonly targetSessionId?: SessionId
  readonly sourceNodeIds?: readonly string[]
  readonly reason: string
  /** Ambiguous route suggestions must be reviewed; this module never auto-applies. */
  readonly needsReview: boolean
}

/** Minimum score for proposing a destination switch or evidence import. */
export interface ContextRouteThresholds {
  readonly destination: number
  readonly evidence: number
}

/** Cold-user review thresholds for route and evidence decisions. */
export const DEFAULT_CONTEXT_ROUTE_THRESHOLDS: ContextRouteThresholds = Object.freeze({
  destination: 0.7,
  evidence: 0.7,
})

/** Only explicit task-routing language can move a draft away from its Session.
 * @param objective - The current unsent draft text.
 * @returns A conservative route intent or unknown when no explicit cue appears.
 */
export function draftRouteIntent(objective: string): ContextRouteIntent {
  const draft = objective.trim().toLocaleLowerCase()
  if (/\b(?:return|go back|back) to (?:the )?(?:parent|mainline|main thread)\b|回到主线|返回主线|回到父分支/.test(draft)) {
    return 'return'
  }
  if (/^(?:new (?:topic|task|thread|branch)\b|separate (?:topic|task)\b|另起(?:一个)?(?:话题|任务|分支)|新(?:话题|任务)[：:])/.test(draft)) {
    return 'new-task'
  }
  if (/\b(?:resume|continue|pick up|go back to|back to)\b|继续|接着|回到|返回/.test(draft)) {
    return 'resume'
  }
  return 'unknown'
}

function bounded(value: string, max = 100): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('')
}

/**
 * Index branch-owned material while retaining the native graph as authority.
 * @param input - Current family graph, visible content, and draft objective.
 * @returns Bounded branch candidates sorted by lexical overlap.
 */
export function buildContextRouteCandidates(input: {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly objective: string
}): readonly ContextRouteCandidate[] {
  const { graph, contents, objective } = input
  const ownedBySession = new Map<SessionId, ContextFamilyGraph['nodes'][number][]>()
  for (const node of graph.nodes) {
    const owned = ownedBySession.get(node.owner.sessionId) ?? []
    owned.push(node)
    ownedBySession.set(node.owner.sessionId, owned)
  }
  return graph.sessions.filter(session => session.id !== graph.activeSessionId).map((session) => {
    const owned = ownedBySession.get(session.id) ?? []
    const userStart = owned.find(node => node.role === 'user')
    const text = owned.slice(-12).map(node => contents[node.id] ?? node.preview).join('\n')
    const label = bounded(userStart === undefined ? '' : contents[userStart.id] ?? userStart.preview)
      || `Branch at depth ${String(session.depth)}`
    return Object.freeze({
      sessionId: session.id,
      ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
      depth: session.depth,
      label,
      ownedNodeIds: Object.freeze(owned.map(node => node.id)),
      offPathNodeIds: Object.freeze(owned.filter(node => !node.sessionIds.includes(graph.activeSessionId))
        .map(node => node.id)),
      lexicalScore: jaccardOverlap(objective, `${label}\n${text}`),
      ...(session.workState === undefined ? {} : { workState: session.workState }),
    })
  }).sort((left, right) => right.lexicalScore - left.lexicalScore
    || left.sessionId.localeCompare(right.sessionId))
}

const CONTINUE: ContextRouteProposal = Object.freeze({
  action: 'continue', reason: 'The current branch remains the safest route.', needsReview: false,
})

/**
 * Keep route choice separate from evidence choice. Scores are supplied by an
 * optional Jev/LLM scorer or a deterministic fallback, not learned here.
 * @param input - Intent, active route, scored candidates, and review thresholds.
 * @returns One review-only proposal or Continue when evidence is insufficient.
 */
export function planContextRoute(input: {
  readonly intent: ContextRouteIntent
  readonly activeSessionId: SessionId
  readonly parentSessionId?: SessionId
  readonly explicitTargetSessionId?: SessionId
  readonly candidates: readonly ScoredContextRouteCandidate[]
  readonly thresholds?: ContextRouteThresholds
}): ContextRouteProposal {
  const requestedDestination = input.thresholds?.destination
  const requestedEvidence = input.thresholds?.evidence
  const thresholds = {
    destination: requestedDestination !== undefined && Number.isFinite(requestedDestination)
      ? Math.max(0.6, Math.min(0.82, requestedDestination))
      : DEFAULT_CONTEXT_ROUTE_THRESHOLDS.destination,
    evidence: requestedEvidence !== undefined && Number.isFinite(requestedEvidence)
      ? Math.max(0.6, Math.min(0.82, requestedEvidence))
      : DEFAULT_CONTEXT_ROUTE_THRESHOLDS.evidence,
  }
  const byId = new Map(input.candidates.map(candidate => [candidate.sessionId, candidate]))
  const explicit = input.explicitTargetSessionId === undefined
    ? undefined : byId.get(input.explicitTargetSessionId)
  if (explicit !== undefined && (input.intent === 'resume' || input.intent === 'return')) {
    return Object.freeze({
      action: input.intent === 'return' ? 'return' : 'navigate',
      targetSessionId: explicit.sessionId,
      reason: `Resume the explicitly named branch: ${explicit.label}`,
      needsReview: true,
    })
  }
  if (input.intent === 'return' && input.parentSessionId !== undefined
    && input.parentSessionId !== input.activeSessionId) {
    return Object.freeze({ action: 'return', targetSessionId: input.parentSessionId,
      reason: 'Return to the parent branch.', needsReview: true })
  }
  const safe = [...input.candidates]
    .filter(candidate => candidate.sessionId !== input.activeSessionId
      && candidate.supersededScore < 0.5 && candidate.ownedNodeIds.length > 0)
  const destinations = safe.filter(candidate => input.intent === 'resume'
    || candidate.workState !== 'completed')
    .sort((a, b) => b.destinationScore - a.destinationScore)
  const evidence = [...safe].sort((a, b) => b.evidenceScore - a.evidenceScore)
  const bestDestination = destinations[0]
  const bestEvidence = evidence[0]
  const destinationClear = bestDestination !== undefined
    && bestDestination.destinationScore >= thresholds.destination
    && bestDestination.destinationScore - (destinations[1]?.destinationScore ?? 0) >= 0.15
  if (input.intent === 'resume' && destinationClear) {
    return Object.freeze({ action: 'navigate', targetSessionId: bestDestination.sessionId,
      reason: `This turn appears to resume ${bestDestination.label}.`, needsReview: true })
  }
  if (input.intent === 'new-task') {
    if (destinationClear) return Object.freeze({ action: 'navigate',
      targetSessionId: bestDestination.sessionId,
      reason: `An existing branch already covers this task: ${bestDestination.label}.`, needsReview: true })
    return Object.freeze({ action: 'branch', reason: 'This appears to be a separate task without a clear existing branch.',
      needsReview: true })
  }
  if ((input.intent === 'reference' || input.intent === 'continue' || input.intent === 'unknown')
    && bestEvidence !== undefined && bestEvidence.evidenceScore >= thresholds.evidence
    && bestEvidence.evidenceNodeIds !== undefined
    && bestEvidence.evidenceNodeIds.length > 0 && bestEvidence.evidenceNodeIds.length <= 4
    && bestEvidence.evidenceNodeIds.every(id => bestEvidence.offPathNodeIds.includes(id))) {
    return Object.freeze({ action: 'include', targetSessionId: bestEvidence.sessionId,
      sourceNodeIds: Object.freeze([...bestEvidence.evidenceNodeIds]),
      reason: `Borrow relevant evidence from ${bestEvidence.label} while staying on the current branch.`,
      needsReview: true })
  }
  return CONTINUE
}

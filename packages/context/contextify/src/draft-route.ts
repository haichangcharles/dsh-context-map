/** Conservative draft routing over native Sessions; no model call or mutation. */
import type { ContextRecommendationBase, ContextRouteAdvice,
  ContextStewardProfile, ContextFamilyGraph } from './types.ts'
import { buildContextRouteCandidates, planContextRoute,
  type ContextRouteIntent, type ScoredContextRouteCandidate } from './context-route-policy.ts'

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

/**
 * Attach one reviewable route to the existing Fast Context recommendation.
 * Lexical scores are a conservative fallback, never a claim of semantic confidence.
 * @param input - Frozen graph, exact reviewed draft, preference projection and revisions.
 * @returns A route card only for an unambiguous explicit request.
 */
export function draftRouteAdvice(input: {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly objective: string
  readonly base: ContextRecommendationBase
  readonly profile: ContextStewardProfile
}): ContextRouteAdvice | undefined {
  const objective = input.objective.trim()
  const intent = draftRouteIntent(objective)
  if (intent === 'unknown' || objective.length === 0) return undefined
  const active = input.graph.sessions.find(session => session.id === input.graph.activeSessionId)
  if (active === undefined) return undefined
  const candidates: readonly ScoredContextRouteCandidate[] = buildContextRouteCandidates({
    graph: input.graph, contents: input.contents, objective,
  }).filter(candidate => candidate.offPathNodeIds.length > 0).slice(0, 8).map(candidate => ({
    ...candidate,
    destinationScore: candidate.lexicalScore <= 0 ? 0
      : Math.min(0.82, 0.5 + 1.5 * candidate.lexicalScore),
    evidenceScore: 0,
    supersededScore: 0,
  }))
  const proposal = planContextRoute({
    intent, activeSessionId: input.graph.activeSessionId,
    ...(active.parentSessionId === undefined ? {} : { parentSessionId: active.parentSessionId }),
    candidates,
    thresholds: input.profile.thresholds,
  })
  if (proposal.action !== 'navigate' && proposal.action !== 'return'
    && proposal.action !== 'branch') return undefined
  // Repeated explicit Keeps suppress casual Branch advice, never a user's manual fork.
  if (proposal.action === 'branch' && input.profile.branch.support >= 3
    && input.profile.branch.acceptRate < 0.35) return undefined
  return Object.freeze({
    action: proposal.action,
    base: input.base,
    objective,
    ...(proposal.targetSessionId === undefined ? {} : { targetSessionId: proposal.targetSessionId }),
    reason: proposal.reason,
  })
}

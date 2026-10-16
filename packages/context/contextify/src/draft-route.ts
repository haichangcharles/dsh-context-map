/** Conservative draft routing over native Sessions; no model call or mutation. */
import type { ContextRecommendationBase, ContextRouteAdvice,
  ContextStewardProfile, ContextFamilyGraph } from './types.ts'
import { buildContextRouteCandidates, planContextRoute, draftRouteIntent,
  type ScoredContextRouteCandidate } from './context-route-policy.ts'
import { planSemanticContextRoute, type ContextActionPacket, type SemanticContextRoute } from './semantic-route.ts'

export { draftRouteIntent } from './context-route-policy.ts'

/**
 * Attach one reviewable route to a Local or Fast Context recommendation.
 * Lexical scores are a conservative fallback, never a claim of semantic confidence.
 * @param input - Frozen graph, exact reviewed draft, preference projection and revisions.
 * @returns A route card for explicit intent or sufficiently strong semantic intent.
 */
export function draftRouteAdvice(input: {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly objective: string
  readonly base: ContextRecommendationBase
  readonly profile: ContextStewardProfile
  readonly routePacket?: ContextActionPacket
  readonly semanticRoute?: SemanticContextRoute
  /** Set by the Host adapter, never by model output. */
  readonly jointPlacement?: boolean
  readonly selectedNodeIds?: readonly string[]
}): ContextRouteAdvice | undefined {
  const objective = input.objective.trim()
  const intent = draftRouteIntent(objective)
  if (objective.length === 0) return undefined
  const packet = input.routePacket
  if (packet !== undefined && (packet.objective !== objective
    || packet.base.planRevision !== input.base.planRevision
    || packet.base.graphRevision !== input.base.graphRevision
    || packet.base.activeSessionId !== input.base.activeSessionId)) return undefined
  if (intent === 'unknown' && (packet === undefined || input.semanticRoute === undefined)) return undefined
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
  const proposal = packet !== undefined && input.semanticRoute !== undefined
    ? planSemanticContextRoute({ packet, route: input.semanticRoute, profile: input.profile,
      ...(input.jointPlacement === undefined ? {} : { jointPlacement: input.jointPlacement }),
      ...(input.selectedNodeIds === undefined ? {} : { selectedNodeIds: input.selectedNodeIds }) })
    : planContextRoute({
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

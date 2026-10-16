/** Bounded Context-action data shared by Fast review, local scorers and offline replay. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph, ContextPolicyObservation, ContextRecommendationBase, ContextStewardProfile } from './types.ts'
import { buildContextRouteCandidates, planContextRoute, draftRouteIntent,
  type ContextRouteCandidate, type ContextRouteIntent, type ContextRouteProposal } from './context-route-policy.ts'
import { parseRecommendationJson, parseRecommendationDecisionText, type ContextRecommendationDecision } from './recommendation.ts'

/** Protocol ceiling on scored native Sessions in one Context-action packet. */
export const CONTEXT_ACTION_MAX_SESSIONS = 8
/** Protocol ceiling on bounded source summaries per Session. */
export const CONTEXT_ACTION_MAX_SESSION_NODES = 12
/** Confidence required before an inferred intent proposes a branch switch. */
export const CONTEXT_ACTION_INTENT_THRESHOLD = 0.8

/** A source summary with a stable native graph ID. */
export interface ContextActionNode {
  readonly id: string
  readonly role: ContextFamilyGraph['nodes'][number]['role']
  readonly sourceKind?: ContextFamilyGraph['nodes'][number]['sourceKind']
  readonly content: string
  readonly truncated: boolean
}

/** A native Session candidate with bounded, inspectable source summaries. */
export interface ContextActionCandidate extends ContextRouteCandidate {
  readonly nodes: readonly ContextActionNode[]
}

/** Serializable frozen input for the same-call Fast scorer or a Jev-style reranker. */
export interface ContextActionPacket {
  readonly base: ContextRecommendationBase
  readonly objective: string
  readonly explicitIntent: ContextRouteIntent
  readonly parentSessionId?: SessionId
  readonly candidates: readonly ContextActionCandidate[]
  /** Confirmed historical route examples; target IDs here do not authorize current actions. */
  readonly preferenceExamples?: readonly ContextPolicyObservation[]
}

/** Model-supplied ranking signals; these scores are not calibrated probabilities. */
export interface SemanticContextRoute {
  readonly intent: ContextRouteIntent
  readonly intentScore: number
  readonly candidates: readonly {
    readonly sessionId: SessionId
    readonly destinationScore: number
    readonly evidenceScore: number
    readonly supersededScore: number
  }[]
}

/** Selection and routing remain separate decisions from one optional Fast response. */
export interface FastContextDecision {
  readonly decision: ContextRecommendationDecision
  readonly route?: SemanticContextRoute
}

function bounded(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('')
}

/**
 * Build a bounded native-Session slate without fetching data or invoking a model.
 * @param input - Frozen graph, exact contents, draft, revisions and optional visible source IDs.
 * @returns A JSON-serializable candidate packet with native ancestry and work state.
 */
export function buildContextActionPacket(input: {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly objective: string
  readonly base: ContextRecommendationBase
  readonly visibleNodeIds?: readonly string[]
  readonly preferenceExamples?: readonly ContextPolicyObservation[]
}): ContextActionPacket {
  const visible = input.visibleNodeIds === undefined ? undefined : new Set(input.visibleNodeIds)
  const active = input.graph.sessions.find(session => session.id === input.graph.activeSessionId)
  const candidates = buildContextRouteCandidates(input).slice(0, CONTEXT_ACTION_MAX_SESSIONS)
    .map((candidate): ContextActionCandidate => {
      const nodes = input.graph.nodes.filter(node => node.owner.sessionId === candidate.sessionId
        && (visible === undefined || visible.has(node.id)))
        .slice(-CONTEXT_ACTION_MAX_SESSION_NODES).map((node): ContextActionNode => {
          const id = node.id
          const exact = input.contents[id] ?? node.preview
          const content = bounded(exact, 1200)
          return Object.freeze({ id, role: node.role,
            ...(node.sourceKind === undefined ? {} : { sourceKind: node.sourceKind }),
            content, truncated: content.length < exact.length })
        })
      const ownedNodeIds = nodes.map(node => node.id)
      return Object.freeze({ ...candidate,
        ownedNodeIds: Object.freeze(ownedNodeIds),
        offPathNodeIds: Object.freeze(candidate.offPathNodeIds.filter(id => ownedNodeIds.includes(id))),
        nodes: Object.freeze(nodes) })
    })
  const preferenceExamples = (input.preferenceExamples ?? []).filter(observation => !observation.undone
    && (observation.action === 'branch' || observation.action === 'navigate' || observation.action === 'return'))
    .slice(-8).map(observation => Object.freeze({ ...observation,
      ...(observation.objective === undefined ? {} : { objective: bounded(observation.objective, 800) }),
      ...(observation.routeContext === undefined ? {} : { routeContext: Object.freeze({
        source: bounded(observation.routeContext.source, 800),
        ...(observation.routeContext.target === undefined ? {} : { target: bounded(observation.routeContext.target, 800) }),
      }) }),
    }))
  return Object.freeze({
    ...(preferenceExamples.length === 0 ? {} : { preferenceExamples: Object.freeze(preferenceExamples) }),
    base: Object.freeze({ ...input.base }),
    objective: bounded(input.objective.trim(), 4000),
    explicitIntent: draftRouteIntent(input.objective),
    ...(active?.parentSessionId === undefined ? {} : { parentSessionId: active.parentSessionId }),
    candidates: Object.freeze(candidates),
  })
}

function record(value: unknown, label: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} field "${key}" is unsupported`)
  }
  return value as Record<string, unknown>
}

function score(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite score between 0 and 1`)
  }
  return value
}

/**
 * Validate optional untrusted route scores against exactly the supplied Session slate.
 * @param value - Model or external scorer JSON route value.
 * @param packet - Frozen packet whose native Session IDs are the complete legal score set.
 * @returns Frozen independent intent, destination, evidence and supersession scores.
 */
export function parseSemanticContextRoute(value: unknown, packet: ContextActionPacket): SemanticContextRoute {
  const root = record(value, 'route', ['intent', 'intentScore', 'candidates'])
  const intents: readonly ContextRouteIntent[] = ['continue', 'resume', 'reference', 'new-task', 'return', 'unknown']
  if (typeof root.intent !== 'string' || !intents.includes(root.intent as ContextRouteIntent)) {
    throw new Error('route intent is unsupported')
  }
  const intentScore = score(root.intentScore, 'route intentScore')
  if (!Array.isArray(root.candidates)) throw new Error('route candidates must be an array')
  if (root.candidates.length > CONTEXT_ACTION_MAX_SESSIONS) throw new Error('route candidates exceed 8 Sessions')
  const ids = new Map(packet.candidates.map(candidate => [String(candidate.sessionId), candidate.sessionId]))
  const seen = new Set<string>()
  const candidates = root.candidates.map((raw, index) => {
    const item = record(raw, `route candidates[${String(index)}]`,
      ['sessionId', 'destinationScore', 'evidenceScore', 'supersededScore'])
    const sessionId = typeof item.sessionId === 'string' ? ids.get(item.sessionId) : undefined
    if (sessionId === undefined) throw new Error('route candidate Session is unavailable')
    if (seen.has(sessionId)) throw new Error('route candidate Session is duplicated')
    seen.add(sessionId)
    return Object.freeze({ sessionId,
      destinationScore: score(item.destinationScore, 'destinationScore'),
      evidenceScore: score(item.evidenceScore, 'evidenceScore'),
      supersededScore: score(item.supersededScore, 'supersededScore') })
  })
  return Object.freeze({ intent: root.intent as ContextRouteIntent, intentScore,
    candidates: Object.freeze(candidates) })
}

/**
 * Parse a legacy three-list response or one response augmented with route scores.
 * @param text - Raw tool-free Fast classifier text.
 * @param packet - Frozen Session candidate packet used by that same request.
 * @returns Separate selection and optional route values for domain validation.
 */
export function parseFastContextDecisionText(text: string, packet: ContextActionPacket): FastContextDecision {
  const root = record(parseRecommendationJson(text), 'recommendation', ['include', 'exclude', 'archive', 'route', 'workStates'])
  const { route, ...selection } = root
  return Object.freeze({ decision: parseRecommendationDecisionText(JSON.stringify(selection)),
    ...(route === undefined ? {} : { route: parseSemanticContextRoute(route, packet) }) })
}

/**
 * Keep next-turn destination separate from evidence reuse and explicit routing intent.
 * @param input - Exact packet, validated scores, learned thresholds and independently selected evidence IDs.
 * @returns One review-only action; low similarity alone never proposes a new Branch.
 */
export function planSemanticContextRoute(input: {
  readonly packet: ContextActionPacket
  readonly route: SemanticContextRoute
  readonly profile: ContextStewardProfile
  readonly evidenceNodeIds?: readonly string[]
  /** Host-only signal that intent and destinations came from one concrete placement Choice. */
  readonly jointPlacement?: boolean
  /** Native-validated proposed Context, used to corroborate a concrete destination. */
  readonly selectedNodeIds?: readonly string[]
}): ContextRouteProposal {
  const { packet, route, profile } = input
  const scores = new Map(route.candidates.map(candidate => [candidate.sessionId, candidate]))
  const selected = new Set(input.selectedNodeIds ?? [])
  const supportedPlacement = input.jointPlacement === true
    && (route.intent === 'resume' || route.intent === 'return')
    && packet.candidates.some(candidate => scores.get(candidate.sessionId)?.destinationScore === route.intentScore
      && candidate.ownedNodeIds.some(id => selected.has(id)))
  const intentThreshold = supportedPlacement ? profile.thresholds.destination : CONTEXT_ACTION_INTENT_THRESHOLD
  const intent = packet.explicitIntent !== 'unknown' ? packet.explicitIntent
    : route.intentScore >= intentThreshold ? route.intent : 'unknown'
  const candidates = packet.candidates.map((candidate) => {
    const value = scores.get(candidate.sessionId)
    return { ...candidate, destinationScore: value?.destinationScore ?? 0,
      evidenceScore: value?.evidenceScore ?? 0, supersededScore: value?.supersededScore ?? 0,
      evidenceNodeIds: (input.evidenceNodeIds ?? []).filter(id => candidate.offPathNodeIds.includes(id)) }
  })
  const safeIntent = intent === 'return' && packet.explicitIntent === 'unknown'
    && !candidates.some(candidate => candidate.sessionId === packet.parentSessionId
      && candidate.ownedNodeIds.length > 0 && candidate.supersededScore < 0.5) ? 'unknown' : intent
  return planContextRoute({ intent: safeIntent, activeSessionId: packet.base.activeSessionId,
    ...(packet.parentSessionId === undefined ? {} : { parentSessionId: packet.parentSessionId }),
    candidates, thresholds: profile.thresholds })
}

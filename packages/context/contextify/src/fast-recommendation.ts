/** Deterministic bounded candidate routing for Fast Context recommendations. */
import type { ContextFamilyGraph } from './types.ts'
import type { ContextRecommendationInputNode } from './recommendation.ts'

/** Hard ceiling for every model-visible Fast candidate packet. */
export const FAST_RECOMMENDATION_MAX_NODES = 32
/** Maximum automatically ranked nodes outside the active path. */
export const FAST_RECOMMENDATION_OFF_PATH_LIMIT = 12
/** Number of recent user/assistant pairs retained from the active path. */
export const FAST_RECOMMENDATION_RECENT_TURNS = 3
/** Per-node Unicode code-point content ceiling. */
export const FAST_RECOMMENDATION_MAX_NODE_CHARS = 1_200

/** Deterministic reason that admitted a node into the bounded Fast packet. */
export type FastRecommendationReason =
  | 'recent-active'
  | 'branch-pivot'
  | 'explicit-override'
  | 'off-path-candidate'

/** One routed node with transparent deterministic selection metadata. */
export interface FastRecommendationNode extends ContextRecommendationInputNode {
  readonly reason: FastRecommendationReason
  readonly lexicalScore: number
  readonly graphDistance: number | null
}

/** Complete bounded value supplied to the tool-free Fast classifier. */
export interface FastRecommendationInput {
  readonly activeSessionId: string
  readonly objective: string
  readonly nodes: readonly FastRecommendationNode[]
}

interface FastRecommendationRequest {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly objective: string
  readonly effectiveIncludedNodeIds: readonly string[]
  readonly explicitIncludedNodeIds: readonly string[]
  readonly explicitExcludedNodeIds: readonly string[]
}

function tokens(value: string): ReadonlySet<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(token => Array.from(token).length > 1))
}

function lexicalScore(objective: ReadonlySet<string>, content: string): number {
  const candidate = tokens(content)
  if (objective.size === 0 || candidate.size === 0) return 0
  let intersection = 0
  for (const token of objective) if (candidate.has(token)) intersection += 1
  const union = objective.size + candidate.size - intersection
  return union === 0 ? 0 : intersection / union
}

function distancesFromActive(graph: ContextFamilyGraph): ReadonlyMap<string, number> {
  const adjacency = new Map<string, string[]>()
  for (const node of graph.nodes) adjacency.set(node.id, [])
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.push(edge.target)
    adjacency.get(edge.target)?.push(edge.source)
  }
  const distance = new Map<string, number>()
  const queue: string[] = []
  for (const node of graph.nodes) {
    if (!node.sessionIds.includes(graph.activeSessionId)) continue
    distance.set(node.id, 0)
    queue.push(node.id)
  }
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    if (current === undefined) continue
    const nextDistance = (distance.get(current) ?? 0) + 1
    for (const next of adjacency.get(current) ?? []) {
      if (distance.has(next)) continue
      distance.set(next, nextDistance)
      queue.push(next)
    }
  }
  return distance
}

function freezeNode(node: FastRecommendationNode): FastRecommendationNode {
  return Object.freeze({
    ...node,
    incoming: Object.freeze([...node.incoming]),
    outgoing: Object.freeze([...node.outgoing]),
    sessionDepths: Object.freeze([...node.sessionDepths]),
  })
}

/**
 * Route one small, deterministic graph slice for the common Context review path.
 * @param request - Frozen family, exact message content, objective, and durable overrides.
 * @returns A graph-ordered packet containing mandatory and ranked candidates only.
 */
export function buildFastRecommendationInput(request: FastRecommendationRequest): FastRecommendationInput {
  const graphOrder = new Map(request.graph.nodes.map((node, index) => [node.id, index]))
  const included = new Set(request.effectiveIncludedNodeIds)
  const explicit = new Set([...request.explicitIncludedNodeIds, ...request.explicitExcludedNodeIds])
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of request.graph.edges) {
    incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge.source])
    outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge.target])
  }
  const depth = new Map(request.graph.sessions.map(session => [session.id, session.depth]))
  const distance = distancesFromActive(request.graph)
  const objectiveTokens = tokens(request.objective)
  const selected = new Map<string, FastRecommendationReason>()
  for (const id of explicit) selected.set(id, 'explicit-override')

  const activeNodes = request.graph.nodes.filter(node => node.sessionIds.includes(request.graph.activeSessionId))
  const recentCount = FAST_RECOMMENDATION_RECENT_TURNS * 2
  for (const node of activeNodes.slice(-recentCount)) {
    if (!selected.has(node.id)) selected.set(node.id, 'recent-active')
  }
  for (const node of activeNodes) {
    if ((outgoing.get(node.id)?.length ?? 0) > 1 && !selected.has(node.id)) {
      selected.set(node.id, 'branch-pivot')
    }
  }
  if (selected.size > FAST_RECOMMENDATION_MAX_NODES) {
    throw new Error(`Fast recommendation mandatory candidates exceed ${String(FAST_RECOMMENDATION_MAX_NODES)} nodes`)
  }

  const offPath = request.graph.nodes
    .filter(node => !node.sessionIds.includes(request.graph.activeSessionId) && !selected.has(node.id))
    .map(node => ({
      node,
      score: lexicalScore(objectiveTokens, request.contents[node.id] ?? node.preview),
      distance: distance.get(node.id) ?? null,
      order: graphOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => right.score - left.score
      || (left.distance ?? Number.MAX_SAFE_INTEGER) - (right.distance ?? Number.MAX_SAFE_INTEGER)
      || left.order - right.order)
    .slice(0, Math.min(
      FAST_RECOMMENDATION_OFF_PATH_LIMIT,
      FAST_RECOMMENDATION_MAX_NODES - selected.size,
    ))
  for (const candidate of offPath) selected.set(candidate.node.id, 'off-path-candidate')

  const nodes = request.graph.nodes.flatMap((node): FastRecommendationNode[] => {
    const reason = selected.get(node.id)
    if (reason === undefined) return []
    const exact = request.contents[node.id] ?? node.preview
    const content = Array.from(exact).slice(0, FAST_RECOMMENDATION_MAX_NODE_CHARS).join('')
    return [freezeNode({
      id: node.id,
      role: node.role,
      content,
      truncated: content.length < exact.length,
      included: included.has(node.id),
      active: node.sessionIds.includes(request.graph.activeSessionId),
      incoming: incoming.get(node.id) ?? [],
      outgoing: outgoing.get(node.id) ?? [],
      sessionDepths: node.sessionIds.flatMap(id => depth.get(id) ?? []),
      reason,
      lexicalScore: lexicalScore(objectiveTokens, exact),
      graphDistance: distance.get(node.id) ?? null,
    })]
  })
  return Object.freeze({
    activeSessionId: request.graph.activeSessionId,
    objective: request.objective,
    nodes: Object.freeze(nodes),
  })
}

/** Deterministic bounded candidate routing for Fast Context recommendations. */
import type { ContextFamilyGraph } from './types.ts'
import type { ContextRecommendationInputNode } from './recommendation.ts'
import { personalContextCandidateBonus, type PersonalContextEdit,
  type PersonalContextPlanExample } from './personal-context-policy.ts'
import { lexicalTokens } from './lexical-tokens.ts'

/** Hard ceiling for every model-visible Fast candidate packet. */
export const FAST_RECOMMENDATION_MAX_NODES = 32
/** Maximum automatically ranked nodes outside the active path. */
export const FAST_RECOMMENDATION_OFF_PATH_LIMIT = 12
/** Maximum older active-path messages surfaced for long-conversation review. */
export const FAST_RECOMMENDATION_DISTANT_ACTIVE_LIMIT = 8
/** First messages after an active-path branch pivot kept visible on branch return. */
export const FAST_RECOMMENDATION_BRANCH_ENTRY_PER_PIVOT = 3
/** Total branch-entry nodes admitted before ranked distant candidates. */
export const FAST_RECOMMENDATION_BRANCH_ENTRY_LIMIT = 6
/** Number of recent user/assistant pairs retained from the active path. */
export const FAST_RECOMMENDATION_RECENT_TURNS = 3
/** Per-node Unicode code-point content ceiling. */
export const FAST_RECOMMENDATION_MAX_NODE_CHARS = 1_200
/** Maximum confirmed prior choices shown as personal review examples. */
export const FAST_RECOMMENDATION_PREFERENCE_EXAMPLES = 4
/** Maximum accepted multi-node Context deltas shown as grouped examples. */
export const FAST_RECOMMENDATION_PLAN_EXAMPLES = 2
/** Per-field Unicode code-point ceiling for a prior choice. */
export const FAST_RECOMMENDATION_EXAMPLE_CHARS = 180

/** Deterministic reason that admitted a node into the bounded Fast packet. */
export type FastRecommendationReason =
  | 'recent-active'
  | 'branch-pivot'
  | 'branch-entry'
  | 'explicit-override'
  | 'distant-active-candidate'
  | 'off-path-candidate'

/** One routed node with transparent deterministic selection metadata. */
export interface FastRecommendationNode extends ContextRecommendationInputNode {
  readonly reason: FastRecommendationReason
  readonly lexicalScore: number
  readonly graphDistance: number | null
  /** A prior reviewed Exclude may be suggested for restoration on this turn. */
  readonly reviewableExcluded?: boolean
}

/** Complete bounded value supplied to the tool-free Fast classifier. */
export interface FastRecommendationInput {
  readonly activeSessionId: string
  readonly objective: string
  readonly nodes: readonly FastRecommendationNode[]
  readonly preferenceExamples: readonly PersonalContextEdit[]
  readonly planExamples: readonly PersonalContextPlanExample[]
}

interface FastRecommendationRequest {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly objective: string
  readonly effectiveIncludedNodeIds: readonly string[]
  readonly explicitIncludedNodeIds: readonly string[]
  readonly explicitExcludedNodeIds: readonly string[]
  readonly reviewableExcludedNodeIds?: readonly string[]
  readonly preferenceEdits?: readonly PersonalContextEdit[]
  /** Profile-wide confirmed edits influence ranking without exposing old Session text to the model. */
  readonly rankingEdits?: readonly PersonalContextEdit[]
  readonly planExamples?: readonly PersonalContextPlanExample[]
}

function lexicalScore(objective: ReadonlySet<string>, content: string): number {
  const candidate = lexicalTokens(content)
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

function boundedText(value: string, maxChars: number): string {
  return Array.from(value).slice(0, maxChars).join('')
}

function preferenceExamples(
  objective: string,
  edits: readonly PersonalContextEdit[],
): readonly PersonalContextEdit[] {
  const eligible = edits.filter(edit => (edit.weight ?? 1) > 0)
  const terms = lexicalTokens(objective)
  const relevant = eligible.map((edit, index) => ({ edit, index,
    score: lexicalScore(terms, edit.objective) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, 2)
  const selected = new Set(relevant.map(item => item.index))
  for (let index = eligible.length - 1; index >= 0
    && selected.size < FAST_RECOMMENDATION_PREFERENCE_EXAMPLES; index -= 1) {
    selected.add(index)
  }
  return Object.freeze(eligible.flatMap((edit, index) => selected.has(index) ? [Object.freeze({
    objective: boundedText(edit.objective, FAST_RECOMMENDATION_EXAMPLE_CHARS),
    content: boundedText(edit.content, FAST_RECOMMENDATION_EXAMPLE_CHARS),
    mode: edit.mode,
    ...(edit.weight === undefined ? {} : { weight: edit.weight }),
    ...(edit.sourceKind === undefined ? {} : { sourceKind: edit.sourceKind }),
    ...(edit.speakerRole === undefined ? {} : { speakerRole: edit.speakerRole }),
    ...(edit.webAction === undefined ? {} : { webAction: edit.webAction }),
    ...(edit.onActiveBranch === undefined ? {} : { onActiveBranch: edit.onActiveBranch }),
  })] : []))
}

function planExamples(
  objective: string,
  examples: readonly PersonalContextPlanExample[],
): readonly PersonalContextPlanExample[] {
  const eligible = examples.filter(example => example.choices.length >= 2
    && example.choices.length <= 4
    && example.choices.every(choice => choice.beforeIncluded !== choice.afterIncluded
      && choice.afterIncluded === (choice.action === 'include')))
  const terms = lexicalTokens(objective)
  const relevant = eligible.map((example, index) => ({ index,
    score: lexicalScore(terms, example.objective) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)[0]
  const selected = new Set(relevant === undefined ? [] : [relevant.index])
  for (let index = eligible.length - 1; index >= 0
    && selected.size < FAST_RECOMMENDATION_PLAN_EXAMPLES; index -= 1) {
    selected.add(index)
  }
  return Object.freeze(eligible.flatMap((example, index) => selected.has(index) ? [Object.freeze({
    objective: boundedText(example.objective, FAST_RECOMMENDATION_EXAMPLE_CHARS),
    choices: Object.freeze(example.choices.map(choice => Object.freeze({
      ...choice,
      content: boundedText(choice.content, FAST_RECOMMENDATION_EXAMPLE_CHARS),
    }))),
  })] : []))
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
  const reviewableExcluded = new Set(request.reviewableExcludedNodeIds ?? [])
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of request.graph.edges) {
    incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge.source])
    outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge.target])
  }
  const depth = new Map(request.graph.sessions.map(session => [session.id, session.depth]))
  const distance = distancesFromActive(request.graph)
  const objectiveTokens = lexicalTokens(request.objective)
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

  // A resumed branch's first messages can be old and lexically unrelated to the
  // latest reply. Preserve a small, source-identifiable entry around each pivot
  // so the reviewer can notice what became active again without scanning a full
  // prefix. Leave the off-path budget intact for other still-open branches.
  const pivotIndexes = activeNodes.flatMap((node, index) =>
    (outgoing.get(node.id)?.length ?? 0) > 1 ? [index] : [])
  let branchEntries = 0
  for (const pivotIndex of pivotIndexes.reverse()) {
    for (const node of activeNodes.slice(pivotIndex + 1,
      pivotIndex + 1 + FAST_RECOMMENDATION_BRANCH_ENTRY_PER_PIVOT)) {
      if (branchEntries >= FAST_RECOMMENDATION_BRANCH_ENTRY_LIMIT
        || selected.size >= FAST_RECOMMENDATION_MAX_NODES - FAST_RECOMMENDATION_OFF_PATH_LIMIT) break
      if (selected.has(node.id) || !included.has(node.id)) continue
      selected.set(node.id, 'branch-entry')
      branchEntries += 1
    }
    if (branchEntries >= FAST_RECOMMENDATION_BRANCH_ENTRY_LIMIT) break
  }

  const distantActiveLimit = Math.min(FAST_RECOMMENDATION_DISTANT_ACTIVE_LIMIT,
    Math.max(0, FAST_RECOMMENDATION_MAX_NODES - selected.size - FAST_RECOMMENDATION_OFF_PATH_LIMIT))
  const distantActive = activeNodes
    .filter(node => !selected.has(node.id) && included.has(node.id))
    .map(node => ({
      node,
      score: lexicalScore(objectiveTokens, request.contents[node.id] ?? node.preview)
        + personalContextCandidateBonus(request.objective, request.contents[node.id] ?? node.preview,
          request.rankingEdits ?? request.preferenceEdits ?? [], true, node.sourceKind, node.webAction),
      order: graphOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
    }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.order - left.order)
  const admitted = new Set<string>()
  for (const anchor of distantActive.slice(0, Math.ceil(distantActiveLimit / 2))) {
    admitted.add(anchor.node.id)
    if (admitted.size >= distantActiveLimit) break
    const anchorText = request.contents[anchor.node.id] ?? anchor.node.preview
    const anchorTokens = lexicalTokens(anchorText)
    const later = activeNodes
      .filter(node => !selected.has(node.id) && included.has(node.id)
        && !admitted.has(node.id) && node.role === anchor.node.role
        && (graphOrder.get(node.id) ?? 0) > anchor.order)
      .map(node => ({
        node,
        score: lexicalScore(anchorTokens, request.contents[node.id] ?? node.preview),
        order: graphOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
      }))
      .filter(candidate => candidate.score >= 0.2)
      .sort((left, right) => right.score - left.score || right.order - left.order)[0]
    if (later !== undefined) admitted.add(later.node.id)
    if (admitted.size >= distantActiveLimit) break
  }
  for (const candidate of distantActive) {
    if (admitted.size >= distantActiveLimit) break
    admitted.add(candidate.node.id)
  }
  for (const id of admitted) selected.set(id, 'distant-active-candidate')

  const offPath = request.graph.nodes
    .filter(node => !node.sessionIds.includes(request.graph.activeSessionId)
      && (node.sourceKind === undefined || node.sourceKind === 'chat'
        || (node.sourceKind === 'web' && node.webAction !== undefined))
      && !selected.has(node.id))
    .map(node => ({
      node,
      score: lexicalScore(objectiveTokens, request.contents[node.id] ?? node.preview)
        + personalContextCandidateBonus(request.objective, request.contents[node.id] ?? node.preview,
          request.rankingEdits ?? request.preferenceEdits ?? [], false, node.sourceKind, node.webAction),
      distance: distance.get(node.id) ?? null,
      order: graphOrder.get(node.id) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => right.score - left.score
      || (left.distance ?? Number.MAX_SAFE_INTEGER) - (right.distance ?? Number.MAX_SAFE_INTEGER)
      || left.order - right.order)
  const offPathLimit = Math.min(FAST_RECOMMENDATION_OFF_PATH_LIMIT,
    FAST_RECOMMENDATION_MAX_NODES - selected.size)
  const offPathSelected = new Set<string>()
  const representedBranches = new Set<string>()
  const coverageFloor = Math.max(0.05, (offPath[0]?.score ?? 0) * 0.4)
  // Reserve one competitive source from each off-path branch before filling by
  // score. A long, lexically repetitive branch must not hide another relevant
  // branch from the bounded model-visible packet.
  for (const candidate of offPath) {
    if (offPathSelected.size >= offPathLimit || candidate.score < coverageFloor) break
    const branchId = candidate.node.sessionIds.at(-1) ?? candidate.node.owner.sessionId
    if (representedBranches.has(branchId)) continue
    representedBranches.add(branchId)
    offPathSelected.add(candidate.node.id)
  }
  for (const candidate of offPath) {
    if (offPathSelected.size >= offPathLimit) break
    offPathSelected.add(candidate.node.id)
  }
  for (const id of offPathSelected) selected.set(id, 'off-path-candidate')

  const nodes = request.graph.nodes.flatMap((node): FastRecommendationNode[] => {
    const reason = selected.get(node.id)
    if (reason === undefined) return []
    const exact = request.contents[node.id] ?? node.preview
    const content = Array.from(exact).slice(0, FAST_RECOMMENDATION_MAX_NODE_CHARS).join('')
    return [freezeNode({
      id: node.id,
      role: node.role,
      ...(node.sourceKind === undefined ? {} : { sourceKind: node.sourceKind }),
      ...(node.webAction === undefined ? {} : { webAction: node.webAction }),
      content,
      truncated: content.length < exact.length,
      included: included.has(node.id),
      ...(reviewableExcluded.has(node.id) ? { reviewableExcluded: true } : {}),
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
    preferenceExamples: preferenceExamples(request.objective, request.preferenceEdits ?? []),
    planExamples: planExamples(request.objective, request.planExamples ?? []),
  })
}

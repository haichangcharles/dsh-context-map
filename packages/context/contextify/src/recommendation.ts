/** Deterministic recommendation prompt projection and fail-closed result validation. */
import type {
  ContextArchiveCandidate,
  ContextFamilyGraph,
  ContextRecommendationBase,
  ContextRecommendationMode,
  ContextRecommendationProposal,
  ContextSelectionRecommendation,
} from './types.ts'

/** Maximum complete graph nodes accepted by one review run. */
export const CONTEXT_RECOMMENDATION_MAX_NODES = 500
/** Maximum serialized graph projection characters accepted by one review run. */
export const CONTEXT_RECOMMENDATION_MAX_CHARS = 96_000
const MAX_ITEM_TEXT = 500

/** One exact, bounded message plus topology metadata supplied as untrusted review data. */
export interface ContextRecommendationInputNode {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly truncated: boolean
  readonly included: boolean
  readonly active: boolean
  readonly incoming: readonly string[]
  readonly outgoing: readonly string[]
  readonly sessionDepths: readonly number[]
}

/** Complete deterministic graph projection supplied to an isolated review Agent. */
export interface ContextRecommendationInput {
  readonly activeSessionId: string
  readonly nodes: readonly ContextRecommendationInputNode[]
}

function boundedText(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const text = value.trim()
  if (!allowEmpty && text.length === 0) throw new Error(`${label} must not be empty`)
  if (text.length > MAX_ITEM_TEXT) throw new Error(`${label} must be at most ${String(MAX_ITEM_TEXT)} characters`)
  return text
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

/** Minimal model-owned decision. Version construction remains system-owned. */
export interface ContextRecommendationDecision {
  readonly exclude: readonly { readonly nodeId: string; readonly reason: string }[]
  readonly include: readonly { readonly nodeId: string; readonly reason: string }[]
  readonly archive: readonly { readonly nodeId: string; readonly reason: string }[]
}

/** Parse one JSON object from a tool-free classifier response. */
export function parseRecommendationDecisionText(text: string): ContextRecommendationDecision {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('recommendation response did not contain JSON')
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    throw new Error('recommendation response contained invalid JSON')
  }
  const root = record(parsed, 'recommendation')
  const allowed = new Set(['exclude', 'include', 'archive'])
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) throw new Error(`recommendation field "${key}" is unsupported`)
  }
  const items = (key: 'exclude' | 'include' | 'archive') =>
    (root[key] === undefined ? [] : array(root[key], key)).map((raw, index) => {
      const item = record(raw, `${key}[${String(index)}]`)
      return Object.freeze({
        nodeId: boundedText(item.nodeId, `${key} nodeId`),
        reason: boundedText(item.reason, `${key} reason`),
      })
    })
  return Object.freeze({
    exclude: Object.freeze(items('exclude')),
    include: Object.freeze(items('include')),
    archive: Object.freeze(items('archive')),
  })
}

/**
 * Build the bounded, instruction-safe JSON value supplied to the review Agent.
 * @param request - Exact graph, message contents, and current effective selection.
 * @returns A frozen projection containing every graph node within the hard character budget.
 */
export function buildRecommendationInput(request: {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly effectiveIncludedNodeIds: readonly string[]
}): ContextRecommendationInput {
  if (request.graph.nodes.length > CONTEXT_RECOMMENDATION_MAX_NODES) {
    throw new Error(`Context recommendation supports at most ${String(CONTEXT_RECOMMENDATION_MAX_NODES)} nodes`)
  }
  const included = new Set(request.effectiveIncludedNodeIds)
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of request.graph.edges) {
    incoming.set(edge.target, [...incoming.get(edge.target) ?? [], edge.source])
    outgoing.set(edge.source, [...outgoing.get(edge.source) ?? [], edge.target])
  }
  const depths = new Map(request.graph.sessions.map(session => [session.id, session.depth]))
  const count = Math.max(request.graph.nodes.length, 1)
  const contentLimit = Math.max(160, Math.min(4_000, Math.floor(72_000 / count)))
  const nodes = request.graph.nodes.map((node): ContextRecommendationInputNode => {
    const exact = request.contents[node.id] ?? node.preview
    const content = Array.from(exact).slice(0, contentLimit).join('')
    return Object.freeze({
      id: node.id,
      role: node.role,
      content,
      truncated: content.length < exact.length,
      included: included.has(node.id),
      active: node.sessionIds.includes(request.graph.activeSessionId),
      incoming: Object.freeze([...(incoming.get(node.id) ?? [])]),
      outgoing: Object.freeze([...(outgoing.get(node.id) ?? [])]),
      sessionDepths: Object.freeze(node.sessionIds.flatMap(id => depths.get(id) ?? [])),
    })
  })
  let input: ContextRecommendationInput = Object.freeze({
    activeSessionId: request.graph.activeSessionId,
    nodes: Object.freeze(nodes),
  })
  while (JSON.stringify(input).length > CONTEXT_RECOMMENDATION_MAX_CHARS) {
    const longest = input.nodes.reduce<ContextRecommendationInputNode | undefined>((current, candidate) =>
      current === undefined || candidate.content.length > current.content.length ? candidate : current, undefined)
    if (longest === undefined || longest.content.length <= 160) {
      throw new Error('Context recommendation topology exceeds the serialized input budget')
    }
    const nextLength = Math.max(160, Math.floor(longest.content.length * 0.8))
    input = Object.freeze({
      ...input,
      nodes: Object.freeze(input.nodes.map(node => node.id === longest.id
        ? Object.freeze({ ...node, content: Array.from(node.content).slice(0, nextLength).join(''), truncated: true })
        : node)),
    })
  }
  return input
}

/**
 * Validate untrusted structured Agent output against one exact graph snapshot.
 * @param value - Untrusted structured output returned by the review Agent.
 * @param context - Revision base, graph, and effective selection used for semantic validation.
 * @returns A frozen, field-stripped, review-only proposal.
 */
export function validateRecommendation(
  value: unknown,
  context: {
    readonly mode: ContextRecommendationMode
    readonly base: ContextRecommendationBase
    readonly graph: ContextFamilyGraph
    readonly effectiveIncludedNodeIds: readonly string[]
    readonly explicitIncludedNodeIds: readonly string[]
    readonly explicitExcludedNodeIds: readonly string[]
  },
): ContextRecommendationProposal {
  const root = record(value, 'recommendation')
  const nodeIds = new Set(context.graph.nodes.map(node => node.id))
  const effective = new Set(context.effectiveIncludedNodeIds)
  const explicitIncluded = new Set(context.explicitIncludedNodeIds ?? [])
  const explicitExcluded = new Set(context.explicitExcludedNodeIds ?? [])
  const allowed = new Set(['exclude', 'include', 'archive'])
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) throw new Error(`recommendation field "${key}" is unsupported`)
  }
  const selectionByNode = new Map<string, ContextSelectionRecommendation>()
  const readSelection = (action: 'exclude' | 'include'): void => {
    const items = root[action] === undefined ? [] : array(root[action], action)
    for (const [index, raw] of items.entries()) {
      const item = record(raw, `${action}[${String(index)}]`)
      const nodeId = boundedText(item.nodeId, `${action} nodeId`)
      if (!nodeIds.has(nodeId)) throw new Error(`${action} node "${nodeId}" is unavailable`)
      const parsed: ContextSelectionRecommendation = Object.freeze({
        nodeId,
        action,
        reason: boundedText(item.reason, `${action} reason`),
        confidence: 'medium',
      })
      const prior = selectionByNode.get(nodeId)
      if (prior !== undefined && prior.action !== parsed.action) {
        throw new Error(`selection node "${nodeId}" has conflicting actions`)
      }
      if (prior === undefined) selectionByNode.set(nodeId, parsed)
    }
  }
  readSelection('exclude')
  readSelection('include')
  const graphOrder = context.graph.nodes.map(node => node.id)
  const selection = graphOrder.flatMap((nodeId) => {
    const item = selectionByNode.get(nodeId)
    if (item === undefined
      || (item.action === 'include') === effective.has(nodeId)
      || (item.action === 'exclude' && explicitIncluded.has(nodeId))
      || (item.action === 'include' && explicitExcluded.has(nodeId))) return []
    return [item]
  })
  const seenArchive = new Set<string>()
  const archiveItems = root.archive === undefined ? [] : array(root.archive, 'archive')
  const archive = archiveItems.map((raw, index): ContextArchiveCandidate => {
    const item = record(raw, `archive[${String(index)}]`)
    const nodeId = boundedText(item.nodeId, 'archive nodeId')
    if (!nodeIds.has(nodeId)) throw new Error(`archive node "${nodeId}" is unavailable`)
    if (seenArchive.has(nodeId)) throw new Error(`archive node "${nodeId}" is duplicated`)
    seenArchive.add(nodeId)
    return Object.freeze({
      nodeId,
      category: 'obsolete',
      reason: boundedText(item.reason, 'archive reason'),
      evidenceNodeIds: Object.freeze([]),
    })
  })
  const proposed = new Set(effective)
  for (const item of selection) {
    if (item.action === 'include') proposed.add(item.nodeId)
    else proposed.delete(item.nodeId)
  }
  const currentNodeIds = graphOrder.filter(nodeId => effective.has(nodeId))
  const proposedNodeIds = graphOrder.filter(nodeId => proposed.has(nodeId))
  return Object.freeze({
    mode: context.mode,
    base: Object.freeze({ ...context.base }),
    currentNodeIds: Object.freeze(currentNodeIds),
    proposedNodeIds: Object.freeze(proposedNodeIds),
    addedNodeIds: Object.freeze(proposedNodeIds.filter(nodeId => !effective.has(nodeId))),
    removedNodeIds: Object.freeze(currentNodeIds.filter(nodeId => !proposed.has(nodeId))),
    selection: Object.freeze(selection),
    archive: Object.freeze(archive),
  })
}

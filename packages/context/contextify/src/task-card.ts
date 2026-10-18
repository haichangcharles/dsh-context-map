/** Extractive task evidence is independent of the fine-grained Context slate. */
import type { ContextFamilyGraph } from './types.ts'
import type { ContextActionCandidate, ContextActionNode } from './semantic-route.ts'
import type { ContextRouteCandidate } from './context-route-policy.ts'
import { lexicalTokens, jaccardOverlap } from './lexical-tokens.ts'

/** Build a bounded entry/query/recency card using only sources owned by this task.
 * @param candidate - Native task metadata; ownership never comes from a model.
 * @param graph - Frozen family authority.
 * @param contents - Exact available source contents.
 * @param objective - Current unsent draft.
 * @returns At most four chronological source spans and an informative entry label.
 */
export function buildTaskCard(candidate: ContextRouteCandidate, graph: ContextFamilyGraph,
  contents: Readonly<Record<string, string>>, objective: string): ContextActionCandidate {
  const owned = graph.nodes.filter(node => node.owner.sessionId === candidate.sessionId)
  const text = (node: ContextFamilyGraph['nodes'][number]) => contents[node.id] ?? node.preview
  const entry = owned.find(node => node.role === 'user' && lexicalTokens(text(node)).size >= 3)
    ?? owned.find(node => lexicalTokens(text(node)).size >= 3) ?? owned[0]
  const ranked = [...owned].sort((a, b) => jaccardOverlap(objective, text(b)) - jaccardOverlap(objective, text(a)))
  const selected = new Set([entry, ranked[0], owned.at(-1)].filter(node => node !== undefined))
  // Preserve the neighboring response for a query hit before filling a fourth span.
  const hit = owned.findIndex(node => node.id === ranked[0]?.id)
  const neighbor = owned[hit + 1] ?? ranked[1]
  if (neighbor !== undefined) selected.add(neighbor)
  const nodes = owned.filter(node => selected.has(node)).slice(0, 4).map((node): ContextActionNode => {
    const exact = text(node), content = Array.from(exact).slice(0, 1200).join('')
    return Object.freeze({ id: node.id, role: node.role,
      ...(node.sourceKind === undefined ? {} : { sourceKind: node.sourceKind }),
      content, truncated: content.length < exact.length })
  })
  const label = entry === undefined ? candidate.label : Array.from(text(entry).replace(/\s+/g, ' ').trim()).slice(0, 100).join('')
  return Object.freeze({ ...candidate, label, nodes: Object.freeze(nodes) })
}

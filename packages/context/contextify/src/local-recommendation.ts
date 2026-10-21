/** Model-free calibration features over the native graph, without Fast admission limits. */
import type { ContextFamilyGraph } from './types.ts'
import type { PersonalContextCandidate } from './personal-context-policy.ts'
import { jaccardOverlap } from './lexical-tokens.ts'

/** Build local calibration features without copying source text or applying model packet ceilings.
 * @param request - Frozen native graph, current selection, objective and source text.
 * @returns Read-only candidate features; native validation retains every manual constraint.
 */
export function buildLocalContextCandidates(request: {
  readonly graph: ContextFamilyGraph
  readonly contents: Readonly<Record<string, string>>
  readonly objective: string
  readonly effectiveIncludedNodeIds: readonly string[]
  readonly explicitExcludedNodeIds: readonly string[]
  readonly reviewableExcludedNodeIds: readonly string[]
}): readonly PersonalContextCandidate[] {
  const included = new Set(request.effectiveIncludedNodeIds)
  const reviewable = new Set(request.reviewableExcludedNodeIds)
  const protectedExcluded = new Set(request.explicitExcludedNodeIds.filter(id => !reviewable.has(id)))
  return Object.freeze(request.graph.nodes.map((node) => {
    const active = node.sessionIds.includes(request.graph.activeSessionId)
    return Object.freeze({ id: node.id, active, included: included.has(node.id), role: node.role,
      reason: protectedExcluded.has(node.id) ? 'local-protected' : active ? 'local-active' : 'off-path-candidate',
      ...(node.sourceKind === undefined ? {} : { sourceKind: node.sourceKind }),
      ...(node.webAction === undefined ? {} : { webAction: node.webAction }),
      lexicalScore: jaccardOverlap(request.objective, request.contents[node.id] ?? node.preview) })
  }))
}

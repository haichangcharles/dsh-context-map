/** Deterministic operation DAG over native Sessions; never executes model-supplied steps. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph, ContextRouteAdvice } from './types.ts'

/** One operation whose dependencies precede it in the returned topological order. */
export type ContextRouteOperation =
  | { readonly id: 'destination'; readonly kind: 'navigate'; readonly sessionId: SessionId; readonly dependsOn: readonly [] }
  | { readonly id: 'branch'; readonly kind: 'fork'; readonly parentSessionId: SessionId; readonly dependsOn: readonly ('destination')[] }
  | {
    readonly id: 'context'
    readonly kind: 'set-context'
    readonly destination: 'branch' | 'destination'
    readonly sourceNodeIds: readonly string[]
    readonly dependsOn: readonly ('branch' | 'destination')[]
  }

/** Compile an approved placement and complete selection into a native operation DAG.
 * @param input - Frozen family, reviewed route and canonical selected source IDs.
 * @returns Topologically ordered navigation, optional fork, and final scope operation.
 */
export function compileContextRoutePlan(input: {
  readonly graph: ContextFamilyGraph
  readonly route: ContextRouteAdvice
  readonly selectedNodeIds: readonly string[]
}): readonly ContextRouteOperation[] {
  const { graph, route } = input
  const sessions = new Set(graph.sessions.map(session => session.id))
  const sources = new Set(graph.nodes.map(node => node.id))
  if (route.base.activeSessionId !== graph.activeSessionId || !sessions.has(graph.activeSessionId)
    || input.selectedNodeIds.some(id => !sources.has(id))) throw new Error('The route source or Context is unavailable')
  const steps: ContextRouteOperation[] = []
  let destination: 'branch' | 'destination'
  if (route.action === 'branch') {
    const parent = route.forkParentSessionId ?? graph.activeSessionId
    if (!sessions.has(parent) || route.targetSessionId !== undefined) throw new Error('The fork parent is unavailable')
    if (parent !== graph.activeSessionId) steps.push(Object.freeze({
      id: 'destination', kind: 'navigate', sessionId: parent, dependsOn: Object.freeze([] as const),
    }))
    steps.push(Object.freeze({ id: 'branch', kind: 'fork', parentSessionId: parent,
      dependsOn: Object.freeze(parent === graph.activeSessionId ? [] : ['destination'] as const) }))
    destination = 'branch'
  } else {
    const target = route.targetSessionId
    if (target === undefined || !sessions.has(target) || target === graph.activeSessionId
      || route.forkParentSessionId !== undefined) throw new Error('The route destination is unavailable')
    steps.push(Object.freeze({ id: 'destination', kind: 'navigate', sessionId: target, dependsOn: Object.freeze([] as const) }))
    destination = 'destination'
  }
  steps.push(Object.freeze({ id: 'context', kind: 'set-context', destination,
    sourceNodeIds: Object.freeze([...new Set(input.selectedNodeIds)]), dependsOn: Object.freeze([destination]) }))
  return Object.freeze(steps)
}

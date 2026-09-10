/** Native archive-aware projection of a Contextify Session family. */
import type {
  ContextFamilyGraph, ContextFamilyGraphNode, ContextFamilySession,
} from '@deepseek-ai/dsh-contextify/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

function nearestVisibleParent(
  session: ContextFamilySession,
  sessions: ReadonlyMap<SessionId, ContextFamilySession>,
  visible: ReadonlySet<SessionId>,
): SessionId | undefined {
  let parent = session.parentSessionId
  const seen = new Set<SessionId>()
  while (parent !== undefined && !seen.has(parent)) {
    seen.add(parent)
    if (visible.has(parent)) return parent
    parent = sessions.get(parent)?.parentSessionId
  }
  return undefined
}

function emptyProjection(graph: ContextFamilyGraph): ContextFamilyGraph {
  return Object.freeze({
    rootSessionId: graph.activeSessionId,
    activeSessionId: graph.activeSessionId,
    sessions: Object.freeze([]),
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
  })
}

/**
 * Hide native archived Session paths while retaining messages inherited by a
 * visible descendant. Retained nodes are rebound to a visible Session so
 * Locate, Branch, and Context Plan mutations never target an archived owner.
 *
 * @param graph - Complete native Contextify family returned by Harness.
 * @param archivedSessionIds - Native Workspace archive set.
 * @returns A graph containing only paths addressable from the Workspace UI.
 */
export function projectUnarchivedContextFamily(
  graph: ContextFamilyGraph,
  archivedSessionIds: readonly SessionId[],
): ContextFamilyGraph {
  if (archivedSessionIds.length === 0) return graph
  const archived = new Set(archivedSessionIds)
  if (archived.has(graph.activeSessionId)) return emptyProjection(graph)

  const originalSessions = new Map(graph.sessions.map(session => [session.id, session]))
  const visibleIds = new Set(graph.sessions
    .map(session => session.id)
    .filter(id => !archived.has(id)))
  const nodes: ContextFamilyGraphNode[] = graph.nodes.flatMap((node) => {
    const sessionIds = node.sessionIds.filter(id => visibleIds.has(id))
    if (sessionIds.length === 0) return []
    const inheritedOwner = sessionIds.includes(graph.activeSessionId)
      ? graph.activeSessionId
      : sessionIds[0]
    if (inheritedOwner === undefined) return []
    const ownerSessionId = visibleIds.has(node.owner.sessionId)
      ? node.owner.sessionId
      : inheritedOwner
    return [Object.freeze({
      ...node,
      owner: Object.freeze({ sessionId: ownerSessionId, seq: node.owner.seq }),
      sessionIds: Object.freeze(sessionIds),
    })]
  })
  const nodeIds = new Set(nodes.map(node => node.id))
  const edges = graph.edges.flatMap((edge) => {
    const sessionIds = edge.sessionIds.filter(id => visibleIds.has(id))
    if (sessionIds.length === 0 || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return []
    return [Object.freeze({ ...edge, sessionIds: Object.freeze(sessionIds) })]
  })

  const projectedParents = new Map<SessionId, SessionId | undefined>()
  for (const session of graph.sessions) {
    if (visibleIds.has(session.id)) {
      projectedParents.set(session.id, nearestVisibleParent(session, originalSessions, visibleIds))
    }
  }
  const depthMemo = new Map<SessionId, number>()
  const depthOf = (id: SessionId, visiting = new Set<SessionId>()): number => {
    const known = depthMemo.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    const nextVisiting = new Set(visiting).add(id)
    const parent = projectedParents.get(id)
    const depth = parent === undefined ? 0 : depthOf(parent, nextVisiting) + 1
    depthMemo.set(id, depth)
    return depth
  }
  const sessions = graph.sessions.flatMap((session) => {
    if (!visibleIds.has(session.id)) return []
    const parentSessionId = projectedParents.get(session.id)
    const tipNodeId = nodes.findLast(node => node.sessionIds.includes(session.id))?.id ?? null
    return [Object.freeze({
      id: session.id,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      seedLength: session.seedLength,
      depth: depthOf(session.id),
      tipNodeId,
    })]
  })
  let rootSessionId = graph.activeSessionId
  const seen = new Set<SessionId>()
  while (!seen.has(rootSessionId)) {
    seen.add(rootSessionId)
    const parent = projectedParents.get(rootSessionId)
    if (parent === undefined) break
    rootSessionId = parent
  }
  return Object.freeze({
    rootSessionId,
    activeSessionId: graph.activeSessionId,
    sessions: Object.freeze(sessions),
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  })
}

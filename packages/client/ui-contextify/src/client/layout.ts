/** Deterministic Context Map layouts adapted from the standalone Context Map. */
import dagre from 'dagre'
import { Position, type Node } from '@xyflow/react'
import type { ContextFamilyGraphEdge, ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import type { ContextMapLayout } from './store.ts'

/** Width reserved for every deterministic Context Map message card. */
export const CONTEXT_MAP_NODE_WIDTH = 224
/** Height reserved for every deterministic Context Map message card. */
export const CONTEXT_MAP_NODE_HEIGHT = 116

/** Data-independent node position used before renderer callbacks are attached. */
export interface ContextMapLayoutData extends Record<string, unknown> {
  readonly record: ContextFamilyGraphNode
}

function dagreLayout(
  records: readonly ContextFamilyGraphNode[],
  edges: readonly ContextFamilyGraphEdge[],
  direction: 'TB' | 'LR',
): Array<Node<ContextMapLayoutData>> {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: direction, nodesep: 54, ranksep: 86 })
  for (const record of records) {
    graph.setNode(record.id, { width: CONTEXT_MAP_NODE_WIDTH, height: CONTEXT_MAP_NODE_HEIGHT })
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  const horizontal = direction === 'LR'
  return records.map((record) => {
    const point = graph.node(record.id) as { x: number; y: number } | undefined
    return {
      id: record.id,
      type: 'contextMessage',
      data: { record },
      position: {
        x: (point?.x ?? 0) - CONTEXT_MAP_NODE_WIDTH / 2,
        y: (point?.y ?? 0) - CONTEXT_MAP_NODE_HEIGHT / 2,
      },
      targetPosition: horizontal ? Position.Left : Position.Top,
      sourcePosition: horizontal ? Position.Right : Position.Bottom,
    }
  })
}

function mindMapLayout(
  records: readonly ContextFamilyGraphNode[],
  edges: readonly ContextFamilyGraphEdge[],
): Array<Node<ContextMapLayoutData>> {
  const byId = new Map(records.map(record => [record.id, record]))
  const children = new Map<string, string[]>()
  const incoming = new Set<string>()
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    const list = children.get(edge.source) ?? []
    if (!list.includes(edge.target)) list.push(edge.target)
    children.set(edge.source, list)
    incoming.add(edge.target)
  }
  const roots = records.filter(record => !incoming.has(record.id))
  const positions = new Map<string, { x: number; y: number; side: -1 | 1 }>()
  let leftLane = 0
  let rightLane = 0
  const visited = new Set<string>()
  const walk = (id: string, depth: number, side: -1 | 1, lane: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    positions.set(id, {
      x: depth === 0 ? 0 : side * depth * 310,
      y: depth === 0 ? lane * 170 : lane * 154,
      side,
    })
    const descendants = children.get(id) ?? []
    descendants.forEach((child, index) => {
      const childSide = depth === 0 ? (index % 2 === 0 ? 1 : -1) : side
      const childLane = childSide === 1 ? rightLane++ : leftLane++
      walk(child, depth + 1, childSide, childLane)
    })
  }
  roots.forEach((root, index) => { walk(root.id, 0, 1, index) })
  records.forEach((record, index) => {
    if (!visited.has(record.id)) walk(record.id, 0, 1, roots.length + index)
  })
  return records.map((record) => {
    const point = positions.get(record.id) ?? { x: 0, y: 0, side: 1 as const }
    return {
      id: record.id,
      type: 'contextMessage',
      data: { record },
      position: { x: point.x, y: point.y },
      targetPosition: point.side === 1 ? Position.Left : Position.Right,
      sourcePosition: point.side === 1 ? Position.Right : Position.Left,
    }
  })
}

/**
 * Place one native Session-family message graph.
 * @param nodes - Canonical visible user and assistant messages.
 * @param edges - De-duplicated causal family edges.
 * @param mode - Tree, radial mind-map, or left-to-right timeline.
 * @returns React Flow nodes with deterministic coordinates and handles.
 */
export function layoutContextMap(
  nodes: readonly ContextFamilyGraphNode[],
  edges: readonly ContextFamilyGraphEdge[],
  mode: ContextMapLayout,
): Array<Node<ContextMapLayoutData>> {
  if (mode === 'mindmap') return mindMapLayout(nodes, edges)
  return dagreLayout(nodes, edges, mode === 'timeline' ? 'LR' : 'TB')
}

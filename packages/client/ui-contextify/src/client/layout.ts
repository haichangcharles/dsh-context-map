/** Deterministic Context Map layouts adapted from the standalone Context Map. */
import dagre from 'dagre'
import { Position, type Node } from '@xyflow/react'
import type { ContextFamilyGraphEdge, ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import type { ContextMapLayout } from './store.ts'

/** Width reserved for every deterministic Context Map message card. */
export const CONTEXT_MAP_NODE_WIDTH = 224
/** Height reserved for every deterministic Context Map message card. */
export const CONTEXT_MAP_NODE_HEIGHT = 116
/** Minimum vertical gap between measured tree ranks. */
export const CONTEXT_MAP_RANK_GAP = 86
/** Minimum horizontal gap between measured sibling bounds. */
export const CONTEXT_MAP_NODE_GAP = 54

/** Renderer-measured bounds for one Context Map message card. */
export interface ContextMapNodeSize {
  readonly width: number
  readonly height: number
}

/** Renderer-measured bounds keyed by canonical Context Map node id. */
export type ContextMapNodeSizes = Readonly<Record<string, ContextMapNodeSize>>

/** Data-independent node position used before renderer callbacks are attached. */
export interface ContextMapLayoutData extends Record<string, unknown> {
  readonly record: ContextFamilyGraphNode
}

function dagreLayout(
  records: readonly ContextFamilyGraphNode[],
  edges: readonly ContextFamilyGraphEdge[],
  direction: 'TB' | 'LR',
  sizes: ContextMapNodeSizes,
): Array<Node<ContextMapLayoutData>> {
  const graph = new dagre.graphlib.Graph()
  graph.setDefaultEdgeLabel(() => ({}))
  graph.setGraph({ rankdir: direction, nodesep: CONTEXT_MAP_NODE_GAP, ranksep: CONTEXT_MAP_RANK_GAP })
  for (const record of records) {
    graph.setNode(record.id, sizeFor(record.id, sizes))
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target)
  dagre.layout(graph)
  const horizontal = direction === 'LR'
  return records.map((record) => {
    // Every record is inserted before a successful layout assigns coordinates.
    const point = graph.node(record.id) as { x: number; y: number }
    const size = sizeFor(record.id, sizes)
    return {
      id: record.id,
      type: 'contextMessage',
      data: { record },
      position: {
        x: point.x - size.width / 2,
        y: point.y - size.height / 2,
      },
      targetPosition: horizontal ? Position.Left : Position.Top,
      sourcePosition: horizontal ? Position.Right : Position.Bottom,
    }
  })
}

function sizeFor(id: string, sizes: ContextMapNodeSizes): ContextMapNodeSize {
  return sizes[id] ?? { width: CONTEXT_MAP_NODE_WIDTH, height: CONTEXT_MAP_NODE_HEIGHT }
}

/** Exact Dagre placement for one connected chain, without general rank optimization. */
function chainLayout(
  records: readonly ContextFamilyGraphNode[],
  edges: readonly ContextFamilyGraphEdge[],
  direction: 'TB' | 'LR',
  sizes: ContextMapNodeSizes,
): Array<Node<ContextMapLayoutData>> | undefined {
  if (records.length === 0) return edges.length === 0 ? [] : undefined
  if (edges.length !== records.length - 1) return undefined
  const indexedRecords = records.map((record, index) => ({ record, index }))
  const byId = new Map(indexedRecords.map(item => [item.record.id, item]))
  if (byId.size !== records.length) return undefined
  const successors = new Map<string, (typeof indexedRecords)[number]>()
  const incoming = new Set<string>()
  for (const edge of edges) {
    const target = byId.get(edge.target)
    if (!byId.has(edge.source) || target === undefined
      || successors.has(edge.source) || incoming.has(edge.target)) return undefined
    successors.set(edge.source, target)
    incoming.add(edge.target)
  }
  // N-1 distinct targets leave one root; at most one predecessor prevents a
  // cycle reachable from it. A disconnected cycle fails the final count.
  const root = indexedRecords.reduce((selected, item) => incoming.has(item.record.id) ? selected : item)
  const horizontal = direction === 'LR'
  let crossExtent = 0
  for (const record of records) {
    const size = sizeFor(record.id, sizes)
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)
      || size.width <= 0 || size.height <= 0) return undefined
    crossExtent = Math.max(crossExtent, horizontal ? size.height : size.width)
  }
  const nodes: Array<Node<ContextMapLayoutData>> = []
  let cursor: (typeof indexedRecords)[number] | undefined = root
  let visitedCount = 0
  let rankStart = 0
  while (cursor !== undefined) {
    const { record, index } = cursor
    visitedCount += 1
    const size = sizeFor(record.id, sizes)
    const crossStart = (crossExtent - (horizontal ? size.height : size.width)) / 2
    nodes[index] = {
      id: record.id, type: 'contextMessage', data: { record },
      position: horizontal ? { x: rankStart, y: crossStart } : { x: crossStart, y: rankStart },
      targetPosition: horizontal ? Position.Left : Position.Top,
      sourcePosition: horizontal ? Position.Right : Position.Bottom,
    }
    rankStart += (horizontal ? size.width : size.height) + CONTEXT_MAP_RANK_GAP
    cursor = successors.get(record.id)
  }
  return visitedCount === records.length ? nodes : undefined
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
  const walk = (id: string, depth: number, side: -1 | 1, lane: number): { x: number; y: number; side: -1 | 1 } => {
    const known = positions.get(id)
    if (known !== undefined) return known
    const point = {
      x: depth === 0 ? 0 : side * depth * 310,
      y: depth === 0 ? lane * 170 : lane * 154,
      side,
    }
    positions.set(id, point)
    const descendants = children.get(id) ?? []
    descendants.forEach((child, index) => {
      const childSide = depth === 0 ? (index % 2 === 0 ? 1 : -1) : side
      const childLane = childSide === 1 ? rightLane++ : leftLane++
      walk(child, depth + 1, childSide, childLane)
    })
    return point
  }
  roots.forEach((root, index) => { walk(root.id, 0, 1, index) })
  return records.map((record, index) => {
    const point = walk(record.id, 0, 1, roots.length + index)
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
 * @param sizes - Renderer-measured bounds, with deterministic estimates for missing entries.
 * @returns React Flow nodes with deterministic coordinates and handles.
 */
export function layoutContextMap(
  nodes: readonly ContextFamilyGraphNode[],
  edges: readonly ContextFamilyGraphEdge[],
  mode: ContextMapLayout,
  sizes: ContextMapNodeSizes = {},
): Array<Node<ContextMapLayoutData>> {
  if (mode === 'mindmap') return mindMapLayout(nodes, edges)
  const direction = mode === 'timeline' ? 'LR' : 'TB'
  return chainLayout(nodes, edges, direction, sizes) ?? dagreLayout(nodes, edges, direction, sizes)
}

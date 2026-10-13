import { describe, expect, it, vi } from 'vitest'
import dagre from 'dagre'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraphEdge, ContextFamilyGraphNode } from '@deepseek-ai/dsh-contextify/types'
import {
  CONTEXT_MAP_NODE_GAP,
  CONTEXT_MAP_RANK_GAP,
  layoutContextMap,
  type ContextMapNodeSizes,
} from '../src/client/layout.ts'

const sessionId = 'layout-session' as SessionId

function node(id: string, seq: number): ContextFamilyGraphNode {
  return {
    id,
    owner: { sessionId, seq },
    role: seq % 2 === 0 ? 'assistant' : 'user',
    preview: id,
    time: seq,
    branchAtSeq: seq,
    sessionIds: [sessionId],
    activeEventSeq: seq,
  }
}

function edge(source: string, target: string): ContextFamilyGraphEdge {
  return { id: `${source}->${target}`, source, target, sessionIds: [sessionId] }
}

describe('measured Context Map layout', () => {
  it('retains empty and duplicate-identity graph behavior', () => {
    expect(layoutContextMap([], [], 'tree')).toEqual([])
    expect(layoutContextMap([], [edge('missing', 'other')], 'tree')).toEqual([])
    const duplicate = [node('same', 1), node('same', 2)]
    expect(layoutContextMap(duplicate, [edge('same', 'same')], 'tree').map(item => item.data.record))
      .toEqual(duplicate)
  })

  it('retains independent roots when there is no connecting chain', () => {
    const generalLayout = vi.spyOn(dagre, 'layout')
    try {
      const layout = layoutContextMap([node('first-root', 1), node('second-root', 2)], [], 'tree')
      expect(layout.map(item => item.id)).toEqual(['first-root', 'second-root'])
      expect(layout[0]?.position).not.toEqual(layout[1]?.position)
      expect(generalLayout).toHaveBeenCalledOnce()
    } finally { generalLayout.mockRestore() }
  })

  it.each([
    { width: NaN, height: 100 }, { width: 100, height: Infinity },
    { width: 0, height: 100 }, { width: 100, height: -1 },
  ])('preserves general handling of invalid public measurements %#', (size) => {
    const generalLayout = vi.spyOn(dagre, 'layout')
    try {
      const apply = () => layoutContextMap([node('root', 1), node('child', 2)], [edge('root', 'child')], 'tree', { root: size })
      if (size.height === Infinity) expect(apply).toThrow('Not possible to find intersection inside of the rectangle')
      else apply()
      expect(generalLayout).toHaveBeenCalledOnce()
    } finally { generalLayout.mockRestore() }
  })

  it('preserves horizontal branch placement and handles', () => {
    const layout = layoutContextMap([node('root', 1), node('left', 2), node('right', 3)],
      [edge('root', 'left'), edge('root', 'right')], 'timeline')
    expect(layout.map(item => [item.sourcePosition, item.targetPosition])).toEqual([
      ['right', 'left'], ['right', 'left'], ['right', 'left'],
    ])
    for (const child of layout.slice(1)) expect(child.position.x).toBeGreaterThan(layout[0]!.position.x)
  })

  it('keeps mind-map side order, descendants and isolated roots while filtering duplicate/unknown edges', () => {
    const nodes = [node('root', 1), node('left', 2), node('right', 3), node('leaf', 4), node('isolated', 5)]
    const layout = layoutContextMap(nodes, [edge('root', 'left'), edge('root', 'right'), edge('left', 'leaf'),
      edge('root', 'left'), edge('ghost', 'left'), edge('right', 'ghost')], 'mindmap')
    expect(layout.map(item => ({ id: item.id, position: item.position }))).toEqual([
      { id: 'root', position: { x: 0, y: 0 } },
      { id: 'left', position: { x: 310, y: 0 } },
      { id: 'right', position: { x: -310, y: 0 } },
      { id: 'leaf', position: { x: 620, y: 154 } },
      { id: 'isolated', position: { x: 0, y: 170 } },
    ])
    expect(layout[2]).toMatchObject({ targetPosition: 'right', sourcePosition: 'left' })
  })

  it('retains mind-map cycle fallback and shared-descendant traversal order', () => {
    expect(layoutContextMap([], [], 'mindmap')).toEqual([])
    const cycle = layoutContextMap([node('a', 1), node('b', 2)], [edge('a', 'b'), edge('b', 'a')], 'mindmap')
    expect(cycle.map(item => item.position)).toEqual([{ x: 0, y: 0 }, { x: 310, y: 0 }])
    const joined = layoutContextMap([node('root', 1), node('left', 2), node('right', 3), node('shared', 4)],
      [edge('root', 'left'), edge('root', 'right'), edge('left', 'shared'), edge('right', 'shared')], 'mindmap')
    expect(joined.map(item => item.position)).toEqual([
      { x: 0, y: 0 }, { x: 310, y: 0 }, { x: -310, y: 0 }, { x: 620, y: 154 },
    ])
  })

  it.each(['tree', 'timeline'] as const)('places an unordered measured chain exactly as Dagre in %s mode', (mode) => {
    const nodes = [node('leaf', 3), node('root', 1), node('middle', 2)]
    const edges = [edge('middle', 'leaf'), edge('root', 'middle')]
    const sizes: ContextMapNodeSizes = {
      root: { width: 400, height: 100 }, middle: { width: 100, height: 150 }, leaf: { width: 224, height: 116 },
    }
    const expected = new dagre.graphlib.Graph()
    expected.setDefaultEdgeLabel(() => ({}))
    expected.setGraph({ rankdir: mode === 'tree' ? 'TB' : 'LR', nodesep: CONTEXT_MAP_NODE_GAP, ranksep: CONTEXT_MAP_RANK_GAP })
    for (const record of nodes) expected.setNode(record.id, sizes[record.id]!)
    for (const link of edges) expected.setEdge(link.source, link.target)
    dagre.layout(expected)

    const layout = layoutContextMap(nodes, edges, mode, sizes)
    expect(layout.map(record => record.id)).toEqual(nodes.map(record => record.id))
    for (const record of layout) {
      const center = expected.node(record.id) as { x: number; y: number }
      const size = sizes[record.id]!
      expect(record.position).toEqual({ x: center.x - size.width / 2, y: center.y - size.height / 2 })
    }
  })

  it('places all 480 chain messages without invoking general graph optimization', () => {
    const nodes = Array.from({ length: 480 }, (_, index) => node(`turn-message-${String(index)}`, index))
    const edges = nodes.slice(1).map((record, index) => edge(nodes[index]!.id, record.id))
    const generalLayout = vi.spyOn(dagre, 'layout')
    try {
      const layout = layoutContextMap(nodes, edges, 'tree')
      expect(layout).toHaveLength(480)
      for (let index = 0; index < layout.length; index++) {
        expect(layout[index]?.position).toEqual({ x: 0, y: index * (116 + CONTEXT_MAP_RANK_GAP) })
      }
      expect(generalLayout).not.toHaveBeenCalled()
    } finally { generalLayout.mockRestore() }
  })

  it('retains Dagre alignment for fractional renderer measurements in a longer chain', () => {
    const nodes = Array.from({ length: 16 }, (_, index) => node(`measured-${String(index)}`, index))
    const edges = nodes.slice(1).map((record, index) => edge(nodes[index]!.id, record.id))
    const sizes: ContextMapNodeSizes = Object.fromEntries(nodes.map((record, index) => [record.id,
      { width: 180 + (index % 7) * 12.5, height: 88 + (index % 5) * 15.5 }]))
    for (const mode of ['tree', 'timeline'] as const) {
      const expected = new dagre.graphlib.Graph()
      expected.setDefaultEdgeLabel(() => ({}))
      expected.setGraph({ rankdir: mode === 'tree' ? 'TB' : 'LR', nodesep: CONTEXT_MAP_NODE_GAP, ranksep: CONTEXT_MAP_RANK_GAP })
      for (const record of nodes) expected.setNode(record.id, sizes[record.id]!)
      for (const link of edges) expected.setEdge(link.source, link.target)
      dagre.layout(expected)
      for (const record of layoutContextMap(nodes, edges, mode, sizes)) {
        const center = expected.node(record.id) as { x: number; y: number }
        const size = sizes[record.id]!
        expect(record.position).toEqual({ x: center.x - size.width / 2, y: center.y - size.height / 2 })
      }
    }
  })

  it.each([
    [edge('root', 'left'), edge('root', 'right')],
    [edge('root', 'right'), edge('left', 'right')],
    [edge('root', 'left'), edge('left', 'root')],
    [edge('root', 'missing'), edge('left', 'right')],
    [edge('root', 'left'), edge('root', 'left')],
  ].map(edges => ({ edges })))('keeps the general layout for branches, joins, cycles and invalid endpoints %#', ({ edges }) => {
    const generalLayout = vi.spyOn(dagre, 'layout')
    try {
      expect(layoutContextMap([node('root', 1), node('left', 2), node('right', 3)], edges, 'tree'))
        .toHaveLength(3)
      expect(generalLayout).toHaveBeenCalledOnce()
    } finally { generalLayout.mockRestore() }
  })

  it('places a child below the measured bottom of a tall parent', () => {
    const nodes = [node('parent', 1), node('child', 2)]
    const sizes: ContextMapNodeSizes = {
      parent: { width: 224, height: 340 },
      child: { width: 224, height: 116 },
    }

    const layout = layoutContextMap(nodes, [edge('parent', 'child')], 'tree', sizes)
    const parent = layout.find(candidate => candidate.id === 'parent')!
    const child = layout.find(candidate => candidate.id === 'child')!

    expect(child.position.y - (parent.position.y + sizes.parent!.height)).toBeGreaterThanOrEqual(
      CONTEXT_MAP_RANK_GAP,
    )
  })

  it('keeps the same rank gap when the child is taller than its parent', () => {
    const nodes = [node('parent', 1), node('child', 2)]
    const sizes: ContextMapNodeSizes = {
      parent: { width: 224, height: 116 },
      child: { width: 224, height: 340 },
    }

    const layout = layoutContextMap(nodes, [edge('parent', 'child')], 'tree', sizes)
    const parent = layout.find(candidate => candidate.id === 'parent')!
    const child = layout.find(candidate => candidate.id === 'child')!

    expect(child.position.y - (parent.position.y + sizes.parent!.height)).toBeGreaterThanOrEqual(
      CONTEXT_MAP_RANK_GAP,
    )
  })

  it('separates differently sized siblings by their measured horizontal bounds', () => {
    const nodes = [node('root', 1), node('left', 2), node('right', 3)]
    const sizes: ContextMapNodeSizes = {
      root: { width: 224, height: 116 },
      left: { width: 360, height: 116 },
      right: { width: 180, height: 116 },
    }

    const layout = layoutContextMap(nodes, [edge('root', 'left'), edge('root', 'right')], 'tree', sizes)
    const siblings = layout
      .filter(candidate => candidate.id !== 'root')
      .sort((a, b) => a.position.x - b.position.x)
    const first = siblings[0]!
    const second = siblings[1]!

    expect(second.position.x - (first.position.x + sizes[first.id]!.width)).toBeGreaterThanOrEqual(
      CONTEXT_MAP_NODE_GAP,
    )
    expect(layoutContextMap(nodes, [edge('root', 'left'), edge('root', 'right')], 'tree', sizes))
      .toEqual(layout)
  })
})

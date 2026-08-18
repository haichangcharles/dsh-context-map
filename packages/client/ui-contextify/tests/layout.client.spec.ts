import { describe, expect, it } from 'vitest'
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
  it('places a child below the measured bottom of a tall parent', () => {
    const nodes = [node('parent', 1), node('child', 2)]
    const sizes: ContextMapNodeSizes = {
      parent: { width: 224, height: 340 },
      child: { width: 224, height: 116 },
    }

    const layout = layoutContextMap(nodes, [edge('parent', 'child')], 'tree', sizes)
    const parent = layout.find(candidate => candidate.id === 'parent')!
    const child = layout.find(candidate => candidate.id === 'child')!

    expect(child.position.y - (parent.position.y + sizes.parent.height)).toBeGreaterThanOrEqual(
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

    expect(child.position.y - (parent.position.y + sizes.parent.height)).toBeGreaterThanOrEqual(
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

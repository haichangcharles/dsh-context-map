import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextFamilyGraph } from '@deepseek-ai/dsh-contextify/types'
import { projectUnarchivedContextFamily } from '../src/client/archived-family.ts'

const root = 'lifecycle-root' as SessionId
const middle = 'lifecycle-middle' as SessionId
const child = 'lifecycle-child' as SessionId
const unrelated = 'unrelated-archived-session' as SessionId

/** Explicit lifecycle choices and a derived reopen coexist in the same family. */
function family(): ContextFamilyGraph {
  return {
    rootSessionId: root, activeSessionId: child, nodes: [], edges: [],
    sessions: [
      { id: root, seedLength: 0, depth: 0, tipNodeId: null, workState: 'completed', workStateSource: 'explicit' },
      { id: middle, parentSessionId: root, seedLength: 3, depth: 1, tipNodeId: null,
        workState: 'parked', workStateSource: 'explicit' },
      { id: child, parentSessionId: middle, seedLength: 5, depth: 2, tipNodeId: null,
        workState: 'open', workStateSource: 'derived' },
    ],
  }
}

describe('archive-aware native family lifecycle', () => {
  it('keeps graph identity when the Workspace has no archived Sessions', () => {
    const graph = family()
    expect(projectUnarchivedContextFamily(graph, [])).toBe(graph)
  })

  it('prefers an active visible alias without changing a visible original owner', () => {
    const graph: ContextFamilyGraph = { ...family(), nodes: [{
      id: 'shared-prefix', owner: { sessionId: root, seq: 1 }, role: 'user', preview: 'shared', time: 1,
      branchAtSeq: 1, activeEventSeq: 1, sessionIds: [root, middle, child],
    }] }
    expect(projectUnarchivedContextFamily(graph, [unrelated]).nodes).toEqual(graph.nodes)
    expect(projectUnarchivedContextFamily(graph, [root]).nodes[0]?.owner.sessionId).toBe(child)
  })

  it('returns a frozen empty projection when the active native Session is archived', () => {
    const projected = projectUnarchivedContextFamily(family(), [child])
    expect(projected).toEqual({ rootSessionId: child, activeSessionId: child, sessions: [], nodes: [], edges: [] })
    expect(Object.isFrozen(projected)).toBe(true)
    expect(Object.isFrozen(projected.nodes)).toBe(true)
  })

  it('rebinds non-active inherited nodes to a visible alias and removes unavailable edge endpoints', () => {
    const original: ContextFamilyGraph = { ...family(), nodes: [
      { id: 'hidden', owner: { sessionId: root, seq: 1 }, role: 'user', preview: 'hidden', time: 1,
        branchAtSeq: 1, activeEventSeq: null, sessionIds: [root] },
      { id: 'shared', owner: { sessionId: root, seq: 2 }, role: 'user', preview: 'shared', time: 2,
        branchAtSeq: 2, activeEventSeq: null, sessionIds: [root, middle] },
      { id: 'active', owner: { sessionId: child, seq: 3 }, role: 'assistant', preview: 'active', time: 3,
        branchAtSeq: 3, activeEventSeq: 3, sessionIds: [child] },
    ], edges: [
      { id: 'source-hidden', source: 'hidden', target: 'shared', sessionIds: [middle] },
      { id: 'target-hidden', source: 'shared', target: 'hidden', sessionIds: [middle] },
      { id: 'archived-only', source: 'shared', target: 'active', sessionIds: [root] },
      { id: 'retained', source: 'shared', target: 'active', sessionIds: [middle, child] },
    ] }
    const projected = projectUnarchivedContextFamily(original, [root])
    expect(projected.nodes.map(node => [node.id, node.owner.sessionId])).toEqual([
      ['shared', middle], ['active', child],
    ])
    expect(projected.edges).toEqual([original.edges[3]])
    expect(projected.rootSessionId).toBe(middle)
    expect(original.nodes[1]?.owner.sessionId).toBe(root)
  })

  it('terminates when archived ancestors form a cycle or their parent is missing', () => {
    const graph: ContextFamilyGraph = { ...family(), sessions: [
      { id: root, parentSessionId: middle, seedLength: 0, depth: 0, tipNodeId: null },
      { id: middle, parentSessionId: root, seedLength: 1, depth: 1, tipNodeId: null },
      { id: child, parentSessionId: middle, seedLength: 2, depth: 2, tipNodeId: null },
    ] }
    expect(projectUnarchivedContextFamily(graph, [root, middle]).sessions).toEqual([
      { id: child, seedLength: 2, depth: 0, tipNodeId: null },
    ])
    const missing = { ...graph, sessions: [{ id: child, parentSessionId: unrelated,
      seedLength: 2, depth: 2, tipNodeId: null }] }
    expect(projectUnarchivedContextFamily(missing, [root]).sessions).toEqual([
      { id: child, seedLength: 2, depth: 0, tipNodeId: null },
    ])
  })

  it('bounds depth and root traversal for cyclic visible legacy parents', () => {
    const graph: ContextFamilyGraph = { ...family(), sessions: [
      { id: middle, parentSessionId: child, seedLength: 1, depth: 1, tipNodeId: null },
      { id: child, parentSessionId: middle, seedLength: 2, depth: 2, tipNodeId: null },
    ] }
    const projected = projectUnarchivedContextFamily(graph, [root])
    expect(projected.sessions.map(session => session.depth)).toEqual([2, 1])
    expect(projected.rootSessionId).toBe(child)
  })

  it('preserves all lifecycle choices when an unrelated Session is archived', () => {
    const original = family()
    const projected = projectUnarchivedContextFamily(original, [unrelated])
    expect(projected.sessions).toEqual(original.sessions)
    expect(projected.activeSessionId).toBe(child)
    expect(projected.rootSessionId).toBe(root)
  })

  it('retains completed and reopened states while bypassing an archived ancestor', () => {
    const original = family()
    const projected = projectUnarchivedContextFamily(original, [middle])
    expect(projected.sessions).toEqual([
      original.sessions[0],
      { ...original.sessions[2], parentSessionId: root, depth: 1 },
    ])
    expect(original.sessions[2]).toMatchObject({ parentSessionId: middle, depth: 2, workState: 'open' })
    expect(projected.activeSessionId).toBe(child)
    expect(projected.rootSessionId).toBe(root)
  })
})

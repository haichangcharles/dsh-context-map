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

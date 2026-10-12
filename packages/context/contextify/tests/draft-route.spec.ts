import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { draftRouteAdvice, draftRouteIntent } from '../src/draft-route.ts'
import { deriveContextStewardProfile } from '../src/context-steward-profile.ts'
import type { ContextFamilyGraph } from '../src/types.ts'

const root = SessionId('main')
const current = SessionId('experiment')
const writing = SessionId('writing')
const graph = {
  rootSessionId: root, activeSessionId: current,
  sessions: [
    { id: root, depth: 0, tipNodeId: 'main:1' },
    { id: current, parentSessionId: root, depth: 1, tipNodeId: 'experiment:1' },
    { id: writing, parentSessionId: root, depth: 1, tipNodeId: 'writing:1' },
  ],
  nodes: [
    { id: 'main:1', owner: { sessionId: root, seq: 1 }, role: 'user',
      preview: 'Start research', sessionIds: [root, current, writing] },
    { id: 'experiment:1', owner: { sessionId: current, seq: 1 }, role: 'user',
      preview: 'Design experiments', sessionIds: [current] },
    { id: 'writing:1', owner: { sessionId: writing, seq: 1 }, role: 'user',
      preview: 'Write paper introduction', sessionIds: [writing] },
  ], edges: [],
} as unknown as ContextFamilyGraph
const base = { planRevision: 2, graphRevision: 'g2', activeSessionId: current }
const profile = deriveContextStewardProfile([], { branchDepth: 1 })
const advise = (objective: string, contextGraph = graph) => draftRouteAdvice({
  graph: contextGraph, contents: {}, objective, base, profile,
})

describe('draft-bound native route advice', () => {
  it('keeps short corrections and implicit references on the current branch', () => {
    expect(draftRouteIntent('Actually I meant method A, not B')).toBe('unknown')
    expect(advise('Actually I meant method A, not B')).toBeUndefined()
    expect(advise('Use the paper introduction as evidence here')).toBeUndefined()
  })

  it('offers the native parent only for an explicit mainline return', () => {
    expect(advise('回到主线继续整体计划')).toMatchObject({
      action: 'return', targetSessionId: root, base, objective: '回到主线继续整体计划',
    })
  })

  it('routes an explicit resume to the matching sibling but abstains on an unknown target', () => {
    expect(advise('Continue writing the paper introduction')).toMatchObject({
      action: 'navigate', targetSessionId: writing,
    })
    expect(advise('Continue quantum gardening')).toBeUndefined()
  })

  it('offers a branch only when the user explicitly starts a separate task', () => {
    expect(advise('New topic: plan a website launch')).toMatchObject({ action: 'branch' })
    expect(advise('Plan a website launch')).toBeUndefined()
  })

  it('honors repeated explicit Keeps without changing manual Branch behavior', () => {
    const conservative = deriveContextStewardProfile(Array.from({ length: 8 }, (_, at) => ({
      action: 'branch' as const, choice: 'reject' as const,
      origin: 'explicit-review' as const, branchDepth: 1, at,
    })), { branchDepth: 1 })
    expect(draftRouteAdvice({ graph, contents: {}, objective: 'New topic: website launch',
      base, profile: conservative })).toBeUndefined()
  })
})

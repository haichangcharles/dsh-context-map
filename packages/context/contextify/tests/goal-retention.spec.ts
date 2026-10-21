import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { projectSessionFamily } from '../src/family.ts'
import { resolveGoalPreservationScope } from '../src/goal-retention.ts'
import type { ContextFamilyInspection } from '../src/types.ts'

it('uses original headers when the display graph collapses an inherited fork boundary', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const a = ctx.sessions.create(SessionId('retention-a'))
    a.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'A source' }] }), { surfaceOp: 'append' })
    const b = ctx.sessions.fork(a, undefined, SessionId('retention-b'))
    b.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'B source' }] }), { surfaceOp: 'append' })
    const c = ctx.sessions.create(SessionId('retention-c'), { seed: a.snapshotEvents(),
      inheritedEventCount: SessionLogOffset(a.snapshotEvents().length), meta: { parentSession: b.id, isSeeded: true } })
    c.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'C source' }] }), { surfaceOp: 'append' })
    const inspections = new Map<SessionId, ContextFamilyInspection>([a, b, c].map(session => [session.id, {
      meta: session.header, events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount,
    }]))
    const graph = projectSessionFamily({ activeSessionId: c.id, sessions: [...inspections.values()] })
    expect(graph.sessions.find(session => session.id === c.id)?.parentSessionId).toBe(a.id)
    const assignment = { goal: 'Keep explicit lineage', assignment: 'existing' as const,
      sessionId: c.id, retention: 'task-lineage' as const }
    const lineage = resolveGoalPreservationScope(assignment, graph, inspections)
    expect(lineage?.nodeIds).toEqual(graph.nodes.map(node => node.id))
    expect(resolveGoalPreservationScope({ ...assignment, retention: 'task-owned' }, graph, inspections)?.nodeIds)
      .toEqual(graph.nodes.filter(node => node.owner.sessionId === c.id).map(node => node.id))
    expect(resolveGoalPreservationScope({ ...assignment, assignment: 'new', retention: 'task-owned' }, graph, inspections)?.nodeIds)
      .toEqual([])
    for (const parentSession of [SessionId('missing'), c.id]) {
      const partial = new Map(inspections)
      partial.set(a.id, { ...inspections.get(a.id)!, meta: { ...a.header, parentSession } })
      expect(resolveGoalPreservationScope(assignment, graph, partial)).toBeNull()
    }
    const missing = new Map(inspections)
    missing.delete(b.id)
    expect(resolveGoalPreservationScope(assignment, graph, missing)).toBeNull()
    const noEvent = new Map(inspections)
    noEvent.set(b.id, { ...inspections.get(b.id)!, events: [] })
    expect(resolveGoalPreservationScope(assignment, graph, noEvent)).toBeNull()
  } finally { await ctx.fiber.dispose() }
})

it('does not treat an unverifiable copied prefix as task-owned material', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try {
    const root = ctx.sessions.create(SessionId('retention-copy-root'))
    root.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Copied source' }] }), { surfaceOp: 'append' })
    const child = ctx.sessions.create(SessionId('retention-copy-child'), { seed: root.snapshotEvents(),
      inheritedEventCount: SessionLogOffset(1), meta: { parentSession: root.id, isSeeded: true } })
    const inspections = new Map<SessionId, ContextFamilyInspection>([[child.id, {
      meta: child.header, events: child.snapshotEvents(), inheritedEventCount: child.inheritedEventCount,
    }]])
    const graph = projectSessionFamily({ activeSessionId: child.id, sessions: [...inspections.values()] })
    expect(graph.nodes[0]?.owner.sessionId).toBe(child.id)
    expect(resolveGoalPreservationScope({ goal: 'Keep owned', assignment: 'existing', sessionId: child.id,
      retention: 'task-owned' }, graph, inspections)).toBeNull()
  } finally { await ctx.fiber.dispose() }
})

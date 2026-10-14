import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { contextPolicyWatermarks, currentPolicyInspections } from '../src/policy-memory.ts'
import type { ContextFamilyInspection } from '../src/types.ts'

function inspect(session: Session): ContextFamilyInspection {
  return { meta: session.header, inheritedEventCount: session.inheritedEventCount,
    events: session.snapshotEvents() }
}

function choice(session: Session, objective = 'Use the Web evidence') {
  return session.append('contextify/manual-route', {
    actionId: objective, action: 'navigate', targetSessionId: SessionId('target'),
    objective, graphRevision: 'g1', uiOrigin: 'contextify-client',
  })
}

function message(session: Session) {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Plan the article' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

describe('Context policy reset event watermarks', () => {
  it('has no policy reset or discarded choices for an empty Profile', () => {
    expect([...contextPolicyWatermarks([])]).toEqual([])
    expect([...currentPolicyInspections(new Map(), new Map())]).toEqual([])
  })

  it('keeps a later choice at the same millisecond and retains original messages and logs', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('reset-same-ms'))
    const clock = vi.spyOn(Date, 'now').mockReturnValue(12345)
    try {
      message(session)
      const old = choice(session, 'Old choice')
      const reset = session.append('contextify/policy-reset', {
        cursors: [{ sessionId: session.id, seq: old.seq }], uiOrigin: 'contextify-client',
      })
      const fresh = choice(session, 'New choice')
      expect(old.time).toBe(reset.time)
      expect(fresh.time).toBe(reset.time)
      const raw = inspect(session)
      const projected = currentPolicyInspections(new Map([[session.id, raw]]), contextPolicyWatermarks([raw]))
      expect(projected.get(session.id)?.events.some(event => event.seq === old.seq)).toBe(false)
      expect(projected.get(session.id)?.events.some(event => event.seq === fresh.seq)).toBe(true)
      expect(projected.get(session.id)?.events.filter(event => event.type === 'user/message')).toHaveLength(1)
      expect(projected.get(session.id)?.events.filter(event => event.type === 'contextify/policy-reset')).toHaveLength(1)
      expect(session.snapshotEvents()).toEqual(raw.events)
      expect(raw.events.some(event => event.seq === old.seq)).toBe(true)
    } finally {
      clock.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('ignores inherited reset copies and preserves the exact inherited prefix for ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const root = ctx.sessions.create(SessionId('reset-owner'))
    try {
      message(root)
      const old = choice(root, 'Before fork')
      root.append('contextify/policy-reset', {
        cursors: [{ sessionId: root.id, seq: old.seq }], uiOrigin: 'contextify-client',
      })
      const boundary = message(root)
      const child = ctx.sessions.fork(root, boundary.seq, SessionId('reset-inheritor'))
      const childChoice = choice(child, 'Owned child choice')
      const parentInspection = inspect(root)
      const childInspection = inspect(child)
      expect(childInspection.inheritedEventCount).toBeGreaterThan(0)
      expect([...contextPolicyWatermarks([childInspection])]).toEqual([])
      const cursors = contextPolicyWatermarks([parentInspection, childInspection])
      expect([...cursors]).toEqual([[root.id, old.seq]])
      const projected = currentPolicyInspections(new Map([
        [root.id, parentInspection], [child.id, childInspection],
      ]), cursors)
      expect(projected.get(root.id)?.events.some(event => event.seq === old.seq)).toBe(false)
      expect(projected.get(child.id)?.inheritedEventCount).toBe(childInspection.inheritedEventCount)
      expect(projected.get(child.id)?.events.slice(0, childInspection.inheritedEventCount))
        .toEqual(childInspection.events.slice(0, childInspection.inheritedEventCount))
      expect(projected.get(child.id)?.events.slice(childInspection.inheritedEventCount))
        .toContainEqual(childChoice)
    } finally { await ctx.fiber.dispose() }
  })

  it('merges cursor maxima across independent families and leaves uncovered families unchanged', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const first = ctx.sessions.create(SessionId('reset-first-family'))
    const second = ctx.sessions.create(SessionId('reset-second-family'))
    const third = ctx.sessions.create(SessionId('uncovered-family'))
    try {
      const oldFirst = choice(first)
      const oldSecond = choice(second)
      choice(third)
      first.append('contextify/policy-reset', {
        cursors: [{ sessionId: first.id, seq: oldFirst.seq }, { sessionId: second.id, seq: oldSecond.seq }],
        uiOrigin: 'contextify-client',
      })
      const freshFirst = choice(first, 'Fresh first')
      second.append('contextify/policy-reset', {
        cursors: [{ sessionId: first.id, seq: 0 }, { sessionId: second.id, seq: oldSecond.seq + 1 }],
        uiOrigin: 'contextify-client',
      })
      const freshSecond = choice(second, 'Fresh second')
      const inspections = new Map([first, second, third].map(session => [session.id, inspect(session)]))
      const cursors = contextPolicyWatermarks([...inspections.values()])
      expect(cursors.get(first.id)).toBe(oldFirst.seq)
      expect(cursors.get(second.id)).toBe(oldSecond.seq + 1)
      const projected = currentPolicyInspections(inspections, cursors)
      expect(projected.get(first.id)?.events.filter(event => event.type === 'contextify/manual-route'))
        .toEqual([freshFirst])
      expect(projected.get(second.id)?.events.filter(event => event.type === 'contextify/manual-route'))
        .toEqual([freshSecond])
      expect(projected.get(third.id)).toEqual(inspections.get(third.id))
    } finally { await ctx.fiber.dispose() }
  })

  it('does not accept unmarked reset events and discards no structural work state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('unmarked-reset'))
    try {
      const preference = choice(session)
      const work = session.append('contextify/work-state', {
        targetSessionId: session.id, state: 'completed', targetEventSeq: preference.seq,
        uiOrigin: 'contextify-client',
      })
      session.append('contextify/policy-reset', { cursors: [{ sessionId: session.id, seq: work.seq }] })
      const raw = inspect(session)
      expect([...contextPolicyWatermarks([raw])]).toEqual([])
      const projected = currentPolicyInspections(new Map([[session.id, raw]]), new Map([[session.id, work.seq]]))
      expect(projected.get(session.id)?.events).toContainEqual(work)
      expect(projected.get(session.id)?.events).not.toContainEqual(preference)
    } finally { await ctx.fiber.dispose() }
  })
})

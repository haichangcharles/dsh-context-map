import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { contextPolicyObservationsFromFamily, deriveContextStewardProfile } from '../src/context-steward-profile.ts'
import { createInitialContextPlan, nextPlan, redoPlan, undoPlan } from '../src/plan.ts'
import type { ContextFamilyGraph, ContextFamilyInspection } from '../src/types.ts'

describe('Context Steward event-derived preferences', () => {
  it('counts a reviewed batch once, ignores passive or non-client events, and avoids inherited duplicates', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('steward-profile-root'))
      const childId = SessionId('steward-profile-child')
      root.append('contextify/recommendation-reviewed', {
        mode: 'fast', base: { planRevision: 1, graphRevision: 'g', activeSessionId: root.id },
        objective: 'Compare the two Web sources before writing',
        selection: [{ nodeId: 'old-a', action: 'include' }, { nodeId: 'old-b', action: 'include' }],
        acceptedNodeIds: ['old-a'], declinedNodeIds: ['old-b'], uiOrigin: 'contextify-client',
      })
      root.append('contextify/node-choice', {
        origin: 'direct', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
        mutations: [{ nodeId: 'old-c', mode: 'include' }],
      })
      root.append('contextify/recommendation-dismissed', {
        mode: 'fast', base: { planRevision: 2, graphRevision: 'g', activeSessionId: root.id },
        selection: [{ nodeId: 'old-d', action: 'include' }], archiveNodeIds: [],
        uiOrigin: 'contextify-client',
      })
      root.append('contextify/branch-choice', {
        suggestionId: 'branch-1', choice: 'keep', turnEndSeq: 0, uiOrigin: 'contextify-client',
      })
      root.append('contextify/branch-choice', {
        suggestionId: 'branch-2', choice: 'move', turnEndSeq: 0,
      })
      const events = root.snapshotEvents()
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: root.id,
        sessions: [
          { id: root.id, seedLength: 0, depth: 0, tipNodeId: null },
          { id: childId, parentSessionId: root.id, seedLength: events.length, depth: 1, tipNodeId: null },
        ],
        nodes: (['old-a', 'old-b', 'old-c'] as const).map((id, index) => ({
          id, owner: { sessionId: root.id, seq: SessionSeq(index + 1) }, role: 'user',
          sourceKind: (['web', 'chat', 'worker'] as const)[index]!, preview: id, time: index,
          branchAtSeq: 1, sessionIds: [root.id, childId], activeEventSeq: null,
        })), edges: [],
      }
      const inspections = new Map<ReturnType<typeof SessionId>, ContextFamilyInspection>([
        [root.id, { meta: root.header, events, inheritedEventCount: 0 }],
        [childId, { meta: { ...root.header, id: childId, parentSession: root.id },
          events, inheritedEventCount: events.length }],
      ])
      const observations = contextPolicyObservationsFromFamily(graph, inspections)
      expect(observations.map(({ action, choice, weight }) => ({ action, choice, weight }))).toEqual([
        { action: 'include', choice: 'accept', weight: 0.5 },
        { action: 'include', choice: 'reject', weight: 0.5 },
        { action: 'include', choice: 'accept', weight: 1 },
        { action: 'branch', choice: 'reject', weight: 1 },
      ])
      expect(observations.slice(0, 3).map(item => item.sourceKind)).toEqual(['web', 'chat', 'worker'])
      expect(observations.slice(0, 2).map(item => ({
        objective: item.objective, targetNodeId: item.targetNodeId,
        displayedIndex: item.displayedIndex, onActiveBranch: item.onActiveBranch,
      }))).toEqual([
        { objective: 'Compare the two Web sources before writing', targetNodeId: 'old-a',
          displayedIndex: 0, onActiveBranch: true },
        { objective: 'Compare the two Web sources before writing', targetNodeId: 'old-b',
          displayedIndex: 1, onActiveBranch: true },
      ])
      expect(observations[2]).toMatchObject({ targetNodeId: 'old-c', onActiveBranch: true })
      const profile = deriveContextStewardProfile(observations, { branchDepth: 0 })
      expect(profile.evidence.support).toBe(2)
      expect(profile.branch.support).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes an undone Context choice from policy support and restores it on Redo', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('steward-undo'))
      const initial = createInitialContextPlan()
      session.append('contextify/plan', initial)
      const changed = nextPlan(initial, { excluded: [{ nodeId: 'old', eventSeq: 0 }],
        included: [], replacements: [] })
      session.append('contextify/plan', changed)
      session.append('contextify/node-choice', {
        origin: 'direct', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: initial.revision, afterPlanRevision: changed.revision,
        graphRevision: 'g', mutations: [{ nodeId: 'old', mode: 'exclude' }],
      })
      const graph: ContextFamilyGraph = {
        rootSessionId: session.id, activeSessionId: session.id,
        sessions: [{ id: session.id, seedLength: 0, depth: 0, tipNodeId: null }],
        nodes: [], edges: [],
      }
      const observations = () => contextPolicyObservationsFromFamily(graph,
        new Map([[session.id, { meta: session.header, events: session.snapshotEvents(),
          inheritedEventCount: 0 }]]))
      expect(deriveContextStewardProfile(observations(), { branchDepth: 0 }).release.support).toBe(1)
      const undone = undoPlan(session, changed)
      expect(undone).not.toBeNull()
      session.append('contextify/plan', undone!)
      expect(deriveContextStewardProfile(observations(), { branchDepth: 0 }).release.support).toBe(0)
      const redone = redoPlan(session, undone!)
      expect(redone).not.toBeNull()
      session.append('contextify/plan', redone!)
      expect(deriveContextStewardProfile(observations(), { branchDepth: 0 }).release.support).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retains the reviewed draft and destination for route-policy learning', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('steward-route-context'))
      const destination = SessionId('steward-route-destination')
      session.append('contextify/route-choice', {
        routeKey: 'route-1', action: 'navigate', choice: 'accept',
        base: { planRevision: 1, graphRevision: 'g', activeSessionId: session.id },
        objective: 'Return to the literature review', targetSessionId: destination,
        uiOrigin: 'contextify-client',
      })
      const graph: ContextFamilyGraph = {
        rootSessionId: session.id, activeSessionId: session.id,
        sessions: [{ id: session.id, seedLength: 0, depth: 0, tipNodeId: null },
          { id: destination, seedLength: 0, depth: 1, parentSessionId: session.id, tipNodeId: null }],
        nodes: [], edges: [],
      }
      const observations = contextPolicyObservationsFromFamily(graph,
        new Map([[session.id, { meta: session.header, events: session.snapshotEvents(),
          inheritedEventCount: 0 }]]))
      expect(observations).toMatchObject([{ action: 'navigate', choice: 'accept',
        objective: 'Return to the literature review', targetSessionId: destination }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects explicit route choices into activity-local policy cells', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('steward-activity-context'))
      const destination = SessionId('steward-activity-destination')
      for (let index = 0; index < 8; index += 1) {
        session.append('contextify/route-choice', {
          routeKey: `write-${String(index)}`, action: 'navigate', choice: 'accept',
          base: { planRevision: 1, graphRevision: 'g', activeSessionId: session.id },
          objective: 'Continue writing the paper introduction', targetSessionId: destination,
          uiOrigin: 'contextify-client',
        })
        session.append('contextify/route-choice', {
          routeKey: `plan-${String(index)}`, action: 'navigate', choice: 'reject',
          base: { planRevision: 1, graphRevision: 'g', activeSessionId: session.id },
          objective: 'Plan the website launch', targetSessionId: destination,
          uiOrigin: 'contextify-client',
        })
      }
      const graph: ContextFamilyGraph = {
        rootSessionId: session.id, activeSessionId: session.id,
        sessions: [{ id: session.id, seedLength: 0, depth: 0, tipNodeId: null }],
        nodes: [], edges: [],
      }
      const observations = contextPolicyObservationsFromFamily(graph,
        new Map([[session.id, { meta: session.header, events: session.snapshotEvents(),
          inheritedEventCount: 0 }]]))
      expect(observations.map(item => item.activity)).toEqual(
        Array.from({ length: 8 }).flatMap(() => ['writing', 'planning']))
      const writing = deriveContextStewardProfile(observations, { activity: 'writing', branchDepth: 0 })
      const planning = deriveContextStewardProfile(observations, { activity: 'planning', branchDepth: 0 })
      expect(writing.destination).toEqual({ acceptRate: 10 / 12, support: 8 })
      expect(planning.destination).toEqual({ acceptRate: 2 / 12, support: 8 })
      expect(writing.thresholds.destination).toBeLessThan(planning.thresholds.destination)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses the reviewed turn rather than the latest draft for branch-granularity memory', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('steward-branch-activity'))
      const reviewedInputSeq = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Brainstorm alternate approaches' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Write the introduction' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('contextify/branch-choice', {
        suggestionId: 'reviewed-turn', choice: 'keep', turnEndSeq: reviewedInputSeq.seq,
        uiOrigin: 'contextify-client',
      })
      const graph: ContextFamilyGraph = {
        rootSessionId: session.id, activeSessionId: session.id,
        sessions: [{ id: session.id, seedLength: 0, depth: 0, tipNodeId: null }],
        nodes: [], edges: [],
      }
      const observations = contextPolicyObservationsFromFamily(graph,
        new Map([[session.id, { meta: session.header, events: session.snapshotEvents(),
          inheritedEventCount: 0 }]]))
      expect(observations).toMatchObject([{ action: 'branch', choice: 'reject',
        activity: 'brainstorming' }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('conditions a confirmed manual Branch on its transferred draft without guessing from later turns', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('steward-manual-branch'))
      const child = SessionId('steward-manual-child')
      session.append('contextify/manual-branch', {
        childSessionId: child, objective: 'Write the paper introduction', uiOrigin: 'contextify-client',
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Plan the next experiment' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('contextify/manual-branch', { childSessionId: SessionId('legacy-child'),
        uiOrigin: 'contextify-client' })
      const graph: ContextFamilyGraph = {
        rootSessionId: session.id, activeSessionId: session.id,
        sessions: [{ id: session.id, seedLength: 0, depth: 0, tipNodeId: null }],
        nodes: [], edges: [],
      }
      const observations = contextPolicyObservationsFromFamily(graph,
        new Map([[session.id, { meta: session.header, events: session.snapshotEvents(),
          inheritedEventCount: 0 }]]))
      expect(observations).toMatchObject([
        { action: 'branch', choice: 'accept', activity: 'writing',
          objective: 'Write the paper introduction', targetSessionId: child },
        { action: 'branch', choice: 'accept', targetSessionId: 'legacy-child' },
      ])
      expect(observations[1]?.activity).toBeUndefined()
      expect(observations[1]?.objective).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
})

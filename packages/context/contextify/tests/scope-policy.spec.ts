import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { projectSessionFamily } from '../src/family.ts'
import { resolveGoalPreservationScope } from '../src/goal-retention.ts'
import { createInitialContextPlan, nextPlan, undoPlan, redoPlan, currentContextPlan } from '../src/plan.ts'
import { buildScopePolicyReview, approvedScopePolicy, scopePolicyExamplesFromInspections } from '../src/scope-policy.ts'
import type { ContextFamilyInspection, ContextRecommendationProposal } from '../src/types.ts'

async function fixture() {
  const ctx = new Context(); await ctx.plugin(SessionStore)
  const root = ctx.sessions.create(SessionId('scope-pure-root'))
  const add = (session: typeof root) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Engineering source' }] }), { surfaceOp: 'append' })
  add(root); const child = ctx.sessions.fork(root, undefined, SessionId('scope-pure-child')); add(child)
  const sibling = ctx.sessions.fork(root, undefined, SessionId('scope-pure-sibling')); add(sibling)
  const inspect = (session: typeof root): ContextFamilyInspection => ({ meta: session.header,
    events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount })
  const inspections = new Map([root, child, sibling].map(s => [s.id, inspect(s)]))
  const graph = projectSessionFamily({ activeSessionId: child.id, sessions: [...inspections.values()] })
  const preservation = resolveGoalPreservationScope({ goal: 'Own', assignment: 'existing', sessionId: child.id, retention: 'task-owned' }, graph, inspections)!
  const base = { activeSessionId: child.id, planRevision: 1, graphRevision: 'engineering-graph' }
  const input = { reviewId: 'fixture-publication-1', preservation, base, graph, inspections, proposedNodeIds: preservation.nodeIds, replacedNodeIds: [] as readonly string[] }
  const policy = buildScopePolicyReview(input)!
  const parent = graph.nodes.find(n => n.owner.sessionId === root.id)!
  const selection = [{ nodeId: parent.id, action: 'exclude' as const }]
  const proposal = { mode: 'fast', base, currentNodeIds: graph.nodes.map(n => n.id), proposedNodeIds: preservation.nodeIds,
    addedNodeIds: [], removedNodeIds: [parent.id], selection, archive: [], scopePolicy: policy } as unknown as ContextRecommendationProposal
  child.append('contextify/plan', createInitialContextPlan())
  const after = nextPlan(currentContextPlan(child), { excluded: [{ nodeId: parent.id, eventSeq: SessionSeq(parent.activeEventSeq!) }],
    included: [], replacements: [] })
  child.append('contextify/plan', after)
  child.append('contextify/node-choice', { origin: 'recommendation', changed: true, uiOrigin: 'contextify-client', beforePlanRevision: 1, afterPlanRevision: 2,
    graphRevision: base.graphRevision, mutations: [{ nodeId: parent.id, mode: 'exclude' }], proposal: { currentNodeIds: proposal.currentNodeIds, proposedNodeIds: proposal.proposedNodeIds, selection } })
  child.append('contextify/recommendation-reviewed', { mode: 'fast', base, objective: '😀'.repeat(201), selection, acceptedNodeIds: [parent.id], declinedNodeIds: [], uiOrigin: 'contextify-client', scopePolicy: policy })
  return { ctx, root, child, inspect, input, policy, proposal }
}

it('describes only complete, nonempty, unambiguous native bases without replacements', async () => {
  const f = await fixture()
  try {
    expect(f.policy).toMatchObject({ mode: 'task-owned', sourceCount: 1 })
    expect(buildScopePolicyReview({ ...f.input, proposedNodeIds: [...f.input.proposedNodeIds].reverse() })).toEqual(f.policy)
    for (const change of [
      { preservation: { ...f.input.preservation, nodeIds: [] } }, { proposedNodeIds: [] },
      { proposedNodeIds: [...f.input.proposedNodeIds, ...f.input.proposedNodeIds] },
      { preservation: { ...f.input.preservation, nodeIds: [...f.input.proposedNodeIds, ...f.input.proposedNodeIds] } },
      { replacedNodeIds: f.input.proposedNodeIds }, { inspections: new Map() },
    ]) expect(buildScopePolicyReview({ ...f.input, ...change })).toBeUndefined()
    const rootOwned = resolveGoalPreservationScope({ goal: '', assignment: 'existing', retention: 'task-owned', sessionId: f.root.id }, f.input.graph, f.input.inspections)!
    expect(buildScopePolicyReview({ ...f.input, preservation: rootOwned, proposedNodeIds: rootOwned.nodeIds })).toBeUndefined()
    const lineage = resolveGoalPreservationScope({ goal: '', assignment: 'existing', retention: 'task-lineage', sessionId: f.child.id }, f.input.graph, f.input.inspections)!
    expect(buildScopePolicyReview({ ...f.input, preservation: lineage, proposedNodeIds: lineage.nodeIds })?.mode).toBe('task-lineage')
  } finally { await f.ctx.fiber.dispose() }
})

it('acknowledgement supplies no scope authority and cannot label partial or unchanged actions', async () => {
  const f = await fixture()
  try {
    const input = { proposal: f.proposal, displayedPolicyKey: f.policy.key, uiOrigin: 'contextify-client' as const,
      enabled: true, changed: true, declinedNodeIds: [] as readonly string[], effectiveNodeIds: f.proposal.proposedNodeIds }
    expect(approvedScopePolicy(input)).toEqual(f.policy)
    for (const change of [{ enabled: false }, { changed: false }, { uiOrigin: undefined },
      { proposal: { ...f.proposal, scopePolicy: undefined } }, { displayedPolicyKey: undefined },
      { displayedPolicyKey: 'wrong' }, { declinedNodeIds: ['kept'] }, { proposal: { ...f.proposal, selection: [] } },
      { effectiveNodeIds: [] }, { effectiveNodeIds: [...f.proposal.proposedNodeIds, ...f.proposal.proposedNodeIds] },
    ]) expect(approvedScopePolicy({ ...input, ...change } as Parameters<typeof approvedScopePolicy>[0])).toBeUndefined()
  } finally { await f.ctx.fiber.dispose() }
})

it('projects owned receipts with native Undo/Redo/reset rather than inherited or partial masks', async () => {
  const f = await fixture()
  try {
    const project = () => scopePolicyExamplesFromInspections([f.inspect(f.child)], new Map())
    expect(project()).toHaveLength(1); expect(Array.from(project()[0]!.objective)).toHaveLength(200)
    f.child.append('contextify/plan', undoPlan(f.child, currentContextPlan(f.child))!)
    expect(project()).toHaveLength(0)
    f.child.append('contextify/plan', redoPlan(f.child, currentContextPlan(f.child))!)
    expect(project()).toHaveLength(1)
    const inspection = f.inspect(f.child)
    expect(scopePolicyExamplesFromInspections([inspection], new Map([[f.child.id, f.child.seq]]))).toEqual([])
    expect(scopePolicyExamplesFromInspections([{ ...inspection, inheritedEventCount: inspection.events.length }], new Map())).toEqual([])
  } finally { await f.ctx.fiber.dispose() }
})

it('ignores malformed or unmatched receipt fields without acquiring labels from old events', async () => {
  const f = await fixture()
  try {
    const inspection = f.inspect(f.child), events = inspection.events
    const reviewed = events.at(-1)!, choice = events.at(-2)!
    const project = (last: unknown = reviewed, previous: unknown = choice, log = events.slice(0, -2)) =>
      scopePolicyExamplesFromInspections([
        { ...inspection, events: [...log, previous, last] as typeof events }], new Map())
    for (const scopePolicy of [undefined, null, 1, [], {}, { ...f.policy, reviewId: 0 }, { ...f.policy, reviewId: '' }, { ...f.policy, reviewId: 'x'.repeat(129) }, { ...f.policy, key: 'wrong' }, { ...f.policy, mode: 'unknown' },
      { ...f.policy, assignment: 'unknown' }, { ...f.policy, sessionId: 0 }, { ...f.policy, sessionId: '' },
      { ...f.policy, sourceCount: 0 }, { ...f.policy, sourceCount: '1' }, { ...f.policy, sourceCount: 1.2 },
    ]) expect(project({ ...reviewed, data: { ...reviewed.data, scopePolicy } })).toEqual([])
    for (const data of [{ uiOrigin: undefined }, { declinedNodeIds: ['x'] }, { selection: [] }, { acceptedNodeIds: ['x'] },
      { acceptedNodeIds: [...(reviewed as Extract<typeof reviewed, { type: 'contextify/recommendation-reviewed' }>).data.acceptedNodeIds, 'x'] },
      { scopePolicy: { ...f.policy, sourceCount: 2 } }, { objective: '' }, { objective: undefined },
      { base: { ...f.input.base, planRevision: 99 } }, { base: { ...f.input.base, activeSessionId: SessionId('other') } }, { sourceBase: { ...f.input.base, graphRevision: 'changed' } },
    ]) expect(project({ ...reviewed, data: { ...reviewed.data, ...data } })).toEqual([])
    expect(project({ ...reviewed, time: NaN })).toEqual([])
    expect(project({ ...reviewed, type: 'user/message' })).toEqual([])
    for (const data of [{ origin: 'direct' }, { uiOrigin: undefined }, { changed: false }, { proposal: undefined },
      { afterPlanRevision: 999 }, { beforePlanRevision: 2 },
      { proposal: { ...f.proposal, proposedNodeIds: [...f.proposal.proposedNodeIds, ...f.proposal.proposedNodeIds] } },
      { proposal: { ...f.proposal, selection: [] } },
    ]) expect(project(reviewed, { ...choice, data: { ...choice.data, ...data } })).toEqual([])
    expect(project(reviewed, { ...choice, type: 'user/message' })).toEqual([])
    expect(scopePolicyExamplesFromInspections([{ ...inspection, inheritedEventCount: 0, events: [reviewed] }], new Map())).toEqual([])
    expect(project({ ...reviewed, data: { ...reviewed.data, sourceBase: f.input.base } })).toHaveLength(1)
  } finally { await f.ctx.fiber.dispose() }
})

it('never labels a post-Jev preservation set with a borrowed source as a pure policy', async () => {
  const f = await fixture()
  try {
    const borrowed = f.input.graph.nodes.find(n => n.owner.sessionId === 'scope-pure-sibling')!.id
    const nodeIds = [...f.input.preservation.nodeIds, borrowed]
    expect(buildScopePolicyReview({ ...f.input, preservation: { ...f.input.preservation, nodeIds },
      proposedNodeIds: nodeIds })).toBeUndefined()
  } finally { await f.ctx.fiber.dispose() }
})

it('bounds and orders event-referenced examples deterministically without duplicating an owned event', async () => {
  const f = await fixture()
  try {
    const original = f.inspect(f.child)
    const clone = (id: string, at: number, seq: number): ContextFamilyInspection => ({ ...original,
      meta: { ...original.meta, id: SessionId(id) },
      events: original.events.map(event => event.type === 'contextify/recommendation-reviewed'
        ? { ...event, seq, time: at, data: { ...event.data, base: { ...event.data.base, activeSessionId: SessionId(id) },
          sourceBase: f.input.base } }
        : event) as typeof original.events })
    const b = clone('b', 1, 40)
    const records = [clone('e', 3, 40), clone('a', 1, 41), clone('d', 3, 40), b, clone('c', 2, 40), clone('a', 1, 40), b]
    expect(scopePolicyExamplesFromInspections(records, new Map()).map(row => row.sourceSessionId)).toEqual(['b', 'c', 'd', 'e'])
    expect(scopePolicyExamplesFromInspections(records.slice(0, 2), new Map()).map(row => row.at)).toEqual([1, 3])
    expect(buildScopePolicyReview({ ...f.input,
      inspections: new Map([...f.input.inspections].filter(([id]) => id !== f.root.id)) })).toBeUndefined()
  } finally { await f.ctx.fiber.dispose() }
})

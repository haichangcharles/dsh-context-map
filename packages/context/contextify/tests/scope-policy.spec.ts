import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { projectSessionFamily } from '../src/family.ts'
import { resolveGoalPreservationScope } from '../src/goal-retention.ts'
import { createInitialContextPlan, nextPlan, undoPlan, redoPlan, currentContextPlan } from '../src/plan.ts'
import { buildScopePolicyReview, approvedScopePolicy, scopePolicyExamplesFromInspections } from '../src/scope-policy.ts'
import type { ContextFamilyInspection, ContextRecommendationProposal } from '../src/types.ts'

async function fixture(borrow = false) {
  const ctx = new Context(); await ctx.plugin(SessionStore)
  const root = ctx.sessions.create(SessionId('scope-pure-root'))
  const add = (session: typeof root) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Engineering source' }] }), { surfaceOp: 'append' })
  add(root); const child = ctx.sessions.fork(root, undefined, SessionId('scope-pure-child')); add(child)
  const sibling = ctx.sessions.fork(root, undefined, SessionId('scope:pure-sibling')); add(sibling)
  const alias = ctx.sessions.fork(sibling, undefined, SessionId('legal:inherited-alias'))
  const inspect = (session: typeof root): ContextFamilyInspection => ({ meta: session.header,
    events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount })
  const inspections = new Map([root, child, sibling, alias].map(s => [s.id, inspect(s)]))
  const graph = projectSessionFamily({ activeSessionId: child.id, sessions: [...inspections.values()] })
  const preservation = resolveGoalPreservationScope({ goal: 'Own', assignment: 'existing', sessionId: borrow ? sibling.id : child.id, retention: 'task-owned' }, graph, inspections)!
  const base = { activeSessionId: child.id, planRevision: 1, graphRevision: 'engineering-graph' }
  const input = { reviewId: 'fixture-publication-1', preservation, base, graph, inspections, proposedNodeIds: preservation.nodeIds, replacedNodeIds: [] as readonly string[] }
  const policy = buildScopePolicyReview(input)!
  const parent = graph.nodes.find(n => n.owner.sessionId === root.id)!
  const excluded = borrow ? graph.nodes.filter(node => node.sessionIds.includes(child.id)) : [parent]
  const foreign = graph.nodes.find(node => node.owner.sessionId === sibling.id)!
  const selection = [...excluded.map(node => ({ nodeId: node.id, action: 'exclude' as const })),
    ...(borrow ? [{ nodeId: foreign.id, action: 'include' as const }] : [])]
  const proposal = { mode: 'fast', base, currentNodeIds: graph.nodes.map(n => n.id), proposedNodeIds: preservation.nodeIds,
    addedNodeIds: [], removedNodeIds: [parent.id], selection, archive: [], scopePolicy: policy } as unknown as ContextRecommendationProposal
  child.append('contextify/plan', createInitialContextPlan())
  const snapshotSeq = child.seq
  if (borrow) {
    const source = sibling.eventAt(SessionSeq(foreign.owner.seq))!
    if (source.type !== 'user/message') throw new Error('Expected fixture user source')
    child.append('context/compiler-snapshot', { id: foreign.id, message: source.data,
      provenance: { provider: 'contextify', sourceId: SessionId('legal:inherited-alias'), sourceSeq: foreign.owner.seq,
        contentHash: createHash('sha256').update(JSON.stringify(source.data)).digest('hex') } })
  }
  const after = nextPlan(currentContextPlan(child), {
    excluded: excluded.map(node => ({ nodeId: node.id, eventSeq: SessionSeq(node.activeEventSeq!) })),
    included: borrow ? [{ nodeId: foreign.id, snapshotSeq, position: 1 }] : [], replacements: [] })
  child.append('contextify/plan', after)
  child.append('contextify/node-choice', { origin: 'recommendation', changed: true, uiOrigin: 'contextify-client', beforePlanRevision: 1, afterPlanRevision: 2,
    graphRevision: base.graphRevision, mutations: [...excluded.map(node => ({ nodeId: node.id, mode: 'exclude' as const })),
      ...(borrow ? [{ nodeId: foreign.id, mode: 'include' as const }] : [])], proposal: { currentNodeIds: proposal.currentNodeIds, proposedNodeIds: proposal.proposedNodeIds, selection } })
  child.append('contextify/recommendation-reviewed', { mode: 'fast', base, objective: '😀'.repeat(201), selection, acceptedNodeIds: selection.map(item => item.nodeId), declinedNodeIds: [], uiOrigin: 'contextify-client', scopePolicy: policy })
  return { ctx, root, child, inspect, input, policy, proposal }
}

function changedInspection(original: ContextFamilyInspection) {
  return (change: (events: Array<typeof original.events[number]>) => void) => {
    const events = structuredClone([...original.events])
    change(events)
    return scopePolicyExamplesFromInspections([{ ...original, events }], new Map())
  }
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
    const borrowed = f.input.graph.nodes.find(n => n.owner.sessionId === 'scope:pure-sibling')!.id
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


it('rejects contradictory historical Plan effects without revoking a valid approval after later edits', async () => {
  const f = await fixture()
  try {
    const original = f.inspect(f.child)
    const project = changedInspection(original)
    expect(project((events) => { events.splice(events.findIndex(event => event.type === 'contextify/plan'), 1) })).toEqual([])
    for (const mutations of [null, undefined, 1, {}, [null], [1], [[]], [{}], [{ nodeId: 1, mode: 'exclude' }],
      [{ nodeId: 'source:1', mode: 'unknown' }]]) {
      expect(project((events) => {
        const at = events.findLastIndex(event => event.type === 'contextify/node-choice')
        const choice = events[at]!
        if (choice.type !== 'contextify/node-choice') throw new Error('Expected fixture choice')
        events[at] = { ...choice, data: { ...choice.data, mutations: mutations as typeof choice.data.mutations } }
      })).toEqual([])
    }
    const planIndex = original.events.findLastIndex(event => event.type === 'contextify/plan')
    const choiceIndex = original.events.length - 2
    const actual = original.events[planIndex]!
    if (actual.type !== 'contextify/plan') throw new Error('Expected fixture Plan')
    expect(project((events) => {
      events[planIndex] = { ...actual, data: { ...actual.data, excluded: [] } }
    })).toEqual([])
    expect(project((events) => {
      const choice = events[choiceIndex]!
      if (choice.type !== 'contextify/node-choice') throw new Error('Expected fixture choice')
      events[choiceIndex] = { ...choice, data: { ...choice.data,
        mutations: [{ nodeId: choice.data.mutations[0]!.nodeId, mode: 'unknown' as 'natural' }] } }
      events[planIndex] = { ...actual, data: { ...actual.data, excluded: [] } }
    })).toEqual([])
    for (const fault of ['invalid-before', 'invalid-after', 'wrong-before', 'wrong-after', 'future-only',
      'max-revision', 'mutations-missing', 'action-mismatch', 'bad-id', 'missing-exclude', 'wrong-pointer', 'non-message', 'unexplained-history']) {
      expect(project((events) => {
        const beforeIndex = events.findIndex(event => event.type === 'contextify/plan')
        const before = events[beforeIndex]!, after = events[planIndex]!, choice = events[choiceIndex]!
        if (before.type !== 'contextify/plan' || after.type !== 'contextify/plan' || choice.type !== 'contextify/node-choice') throw new Error('Expected fixture Plan/choice')
        if (fault === 'invalid-before') events[beforeIndex] = { ...before, data: { ...before.data, revision: 0 } }
        if (fault === 'invalid-after') {
          events[planIndex] = { ...after, data: { ...after.data, revision: 0 } }; events.push(after)
        }
        if (fault === 'wrong-before') events[beforeIndex] = { ...before, data: { ...before.data, revision: 9 } }
        if (fault === 'wrong-after') {
          events[planIndex] = { ...after, data: { ...after.data, revision: 3 } }; events.push(after)
        }
        if (fault === 'future-only') {
          events.splice(planIndex, 1); events.splice(beforeIndex, 1); events.push(before, after)
        }
        if (fault === 'max-revision') {
          events[beforeIndex] = { ...before, data: { ...before.data, revision: Number.MAX_SAFE_INTEGER } }
          events[choiceIndex] = { ...choice, data: { ...choice.data, beforePlanRevision: Number.MAX_SAFE_INTEGER } }
          const reviewed = events.at(-1)!
          if (reviewed.type !== 'contextify/recommendation-reviewed') throw new Error('Expected fixture review')
          events[events.length - 1] = { ...reviewed, data: { ...reviewed.data, sourceBase: f.input.base,
            base: { ...reviewed.data.base, planRevision: Number.MAX_SAFE_INTEGER } } }
        }
        if (fault === 'mutations-missing') events[choiceIndex] = { ...choice, data: { ...choice.data, mutations: [] } }
        if (fault === 'action-mismatch') events[choiceIndex] = { ...choice, data: { ...choice.data,
          mutations: [{ ...choice.data.mutations[0]!, mode: 'natural' }] } }
        if (fault === 'bad-id') {
          const reviewed = events.at(-1)!
          if (reviewed.type !== 'contextify/recommendation-reviewed') throw new Error('Expected fixture review')
          const selection = [{ nodeId: 'bad-id', action: 'exclude' as const }]
          events[choiceIndex] = { ...choice, data: { ...choice.data, mutations: [{ nodeId: 'bad-id', mode: 'exclude' }],
            proposal: { ...choice.data.proposal!, selection } } }
          events[events.length - 1] = { ...reviewed, data: { ...reviewed.data, selection, acceptedNodeIds: ['bad-id'] } }
        }
        if (fault === 'missing-exclude') events[planIndex] = { ...after, data: { ...after.data,
          excluded: [{ ...after.data.excluded[0]!, nodeId: 'unrelated:0' }] } }
        if (fault === 'wrong-pointer') events[planIndex] = { ...after, data: { ...after.data,
          excluded: [{ ...after.data.excluded[0]!, eventSeq: SessionSeq(99) }] } }
        if (fault === 'non-message') {
          const seq = after.data.excluded[0]!.eventSeq
          const at = events.findIndex(event => event.seq === seq)
          const source = { ...events[at]! }; delete source.surfaceOp; events[at] = source
        }
        if (fault === 'unexplained-history') events[planIndex] = { ...after, data: { ...after.data, history: { past: [], future: [] } } }
      })).toEqual([])
    }
    f.child.append('contextify/plan', nextPlan(currentContextPlan(f.child), { excluded: [], included: [], replacements: [] }))
    expect(scopePolicyExamplesFromInspections([f.inspect(f.child)], new Map())).toHaveLength(1)
  } finally { await f.ctx.fiber.dispose() }
})


it('checks persisted Include snapshots and preserves a legitimate inherited alias without requiring a global clock', async () => {
  const f = await fixture(true)
  try {
    const original = f.inspect(f.child)
    const project = changedInspection(original)
    expect(project(() => {})).toHaveLength(1)
    const planIndex = original.events.findLastIndex(event => event.type === 'contextify/plan')
    const snapshotIndex = original.events.findIndex(event => event.type === 'context/compiler-snapshot')
    const snapshot = original.events[snapshotIndex]!
    if (snapshot.type !== 'context/compiler-snapshot') throw new Error('Expected fixture snapshot')
    for (const provenance of [undefined, { ...snapshot.data.provenance!, provider: 'other' },
      { ...snapshot.data.provenance!, sourceId: SessionId('') }, { ...snapshot.data.provenance!, sourceSeq: .5 },
      { ...snapshot.data.provenance!, sourceSeq: -1 }, { ...snapshot.data.provenance!, sourceSeq: 99 },
      { ...snapshot.data.provenance!, contentHash: 'wrong' }]) {
      expect(project((events) => {
        const data = { ...snapshot.data }
        if (provenance === undefined) delete data.provenance
        else data.provenance = provenance
        events[snapshotIndex] = { ...snapshot, data }
      })).toEqual([])
    }
    expect(project((events) => { events[snapshotIndex] = { ...snapshot, data: { ...snapshot.data, id: 'wrong' } } })).toEqual([])
    expect(project((events) => { events.splice(snapshotIndex, 1) })).toEqual([])
    expect(project((events) => {
      const plan = events[planIndex]!
      if (plan.type !== 'contextify/plan') throw new Error('Expected fixture Plan')
      events[planIndex] = { ...plan, data: { ...plan.data, included: [] } }
    })).toEqual([])
    f.child.append('contextify/plan', nextPlan(currentContextPlan(f.child), { excluded: [], included: [], replacements: [] }))
    expect(scopePolicyExamplesFromInspections([f.inspect(f.child)], new Map())).toHaveLength(1)
  } finally { await f.ctx.fiber.dispose() }
})


it('corroborates Natural restoration against its historical Plan and rejects an unknown imported mode', async () => {
  const f = await fixture()
  try {
    const base = { ...f.input.base, planRevision: 2 }
    const preservation = resolveGoalPreservationScope({ goal: 'Restore lineage', assignment: 'existing',
      sessionId: f.child.id, retention: 'task-lineage' }, f.input.graph, f.input.inspections)!
    const policy = buildScopePolicyReview({ ...f.input, reviewId: 'restore-lineage', base, preservation,
      proposedNodeIds: preservation.nodeIds })!
    const selection = [{ nodeId: f.proposal.selection[0]!.nodeId, action: 'include' as const }]
    f.child.append('contextify/plan', nextPlan(currentContextPlan(f.child), { excluded: [], included: [], replacements: [] }))
    f.child.append('contextify/node-choice', { origin: 'recommendation', changed: true, uiOrigin: 'contextify-client',
      beforePlanRevision: 2, afterPlanRevision: 3, graphRevision: base.graphRevision,
      mutations: [{ nodeId: selection[0]!.nodeId, mode: 'natural' }],
      proposal: { currentNodeIds: f.input.preservation.nodeIds, proposedNodeIds: preservation.nodeIds, selection } })
    f.child.append('contextify/recommendation-reviewed', { mode: 'fast', base, objective: 'Restore the whole task lineage.',
      selection, acceptedNodeIds: [selection[0]!.nodeId], declinedNodeIds: [], uiOrigin: 'contextify-client', scopePolicy: policy })
    const inspection = f.inspect(f.child)
    expect(scopePolicyExamplesFromInspections([inspection], new Map())).toHaveLength(2)
    const events = inspection.events.map(event => event.type === 'contextify/node-choice' && event.data.afterPlanRevision === 3
      ? { ...event, data: { ...event.data, mutations: [{ nodeId: selection[0]!.nodeId, mode: 'unknown' as 'natural' }] } } : event)
    expect(scopePolicyExamplesFromInspections([{ ...inspection, events }], new Map())).toHaveLength(1)
  } finally { await f.ctx.fiber.dispose() }
})

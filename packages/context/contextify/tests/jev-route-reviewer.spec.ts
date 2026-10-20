import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildJevRouteRequest, parseJevRouteResponse } from '../src/jev-route-reviewer.ts'
import type { FastRecommendationInput } from '../src/fast-recommendation.ts'
import type { ContextActionPacket } from '../src/semantic-route.ts'
import type { ContextFamilyGraph } from '../src/types.ts'
import type { GoalRouteAssignment } from '../src/goal-route.ts'
const input = { activeSessionId: 'active', objective: 'Resume planning', nodes: [
  { id: 'main:1', content: 'original goal' }, { id: 'active:1', content: 'other task' },
], preferenceExamples: [], planExamples: [] } as unknown as FastRecommendationInput
const route = { base: { activeSessionId: SessionId('active'), graphRevision: 'g', planRevision: 1 },
  objective: input.objective, explicitIntent: 'unknown', parentSessionId: SessionId('main'),
  candidates: [{ sessionId: SessionId('main'), label: 'Planning', nodes: [] }],
} as unknown as ContextActionPacket
const graph = { sessions: [{ id: 'main' }, { id: 'active', parentSessionId: 'main' }],
  nodes: [{ id: 'main:1', owner: { sessionId: 'main' } }, { id: 'active:1', owner: { sessionId: 'active' } }] } as unknown as ContextFamilyGraph
function wire() { return { model: 'jev-1.13.0', answers: {
  n0: { type: 'noul', noul: 0 }, n1: { type: 'noul', noul: 1 },
  active: { type: 'noul', noul: .05 }, task0: { type: 'noul', noul: .95 },
  newTask: { type: 'noul', noul: .03 }, wholeTask: { type: 'noul', noul: 1 },
  parent: { type: 'choice', choice: 'p0', probabilities: { p0: 1 } },
  e0: { type: 'noul', noul: 0 }, s0: { type: 'noul', noul: 0 },
} } }
it('uses independent task judgments and compiles an explicit whole-task scope instead of answer relevance', async () => {
  const body = buildJevRouteRequest(input, route, 'Retain the selected task and its ancestors.')
  expect(body.questions.intent).toBeUndefined()
  expect(body.questions.task0?.type).toBe('noul')
  await expect(JSON.stringify(body, null, 2) + '\n').toMatchFileSnapshot('./expected/jev-route-request.json')
  const parsed = parseJevRouteResponse(wire(), input, route, graph)
  expect(parsed.route).toMatchObject({ intent: 'return', intentScore: .95 })
  expect(parsed.decision.include.map(n => n.nodeId)).toEqual(['main:1'])
  expect(parsed.decision.exclude.map(n => n.nodeId)).toEqual(['active:1'])
})
it('requires affirmative new-task evidence, a confident legal parent and a clear margin', () => {
  const raw = wire(); raw.answers.task0.noul = .1; raw.answers.newTask.noul = .95
  expect(parseJevRouteResponse(raw, input, route, graph).route).toMatchObject({ intent: 'new-task', forkParentSessionId: 'main' })
  raw.answers.active.noul = .9
  expect(parseJevRouteResponse(raw, input, route, graph).route?.intent).toBe('unknown')
})
it('retains fine-grained selection without an explicit whole-task policy and validates every answer', () => {
  const raw = wire(); raw.answers.wholeTask.noul = .4
  expect(parseJevRouteResponse(raw, input, route, graph).decision.include.map(n => n.nodeId)).toEqual(['active:1'])
  for (const invalid of [null, {}, { ...wire(), model: 'other' }, { ...wire(), answers: { ...wire().answers, active: { type: 'noul', noul: NaN } } }]) {
    expect(() => parseJevRouteResponse(invalid, input, route, graph)).toThrow()
  }
})
it('rejects malformed question types, parent choices and inconsistent masses before any decision', () => {
  const cases = [
    { active: { type: 'choice', noul: 1 } },
    { parent: { type: 'noul', choice: 'p0', probabilities: { p0: 1 } } },
    { parent: { type: 'choice', choice: 'foreign', probabilities: { foreign: 1 } } },
    { parent: { type: 'choice', choice: 'p0', probabilities: { p0: 1, foreign: 0 } } },
    { parent: { type: 'choice', choice: 'p0', probabilities: { p0: .4, active: .6 } } },
    { parent: { type: 'choice', choice: 'p0', probabilities: { p0: .5 } } },
  ]
  for (const answers of cases) {
    expect(() => parseJevRouteResponse({ ...wire(), answers: { ...wire().answers, ...answers } }, input, route, graph)).toThrow()
  }
})
it('abstains on an unknown parent, resumes a sibling, and preserves active scope when continuing', () => {
  const raw = wire(); raw.answers.newTask.noul = 1; raw.answers.task0.noul = 0
  raw.answers.parent = { type: 'choice', choice: 'unknown', probabilities: { unknown: 1 } } as unknown as typeof raw.answers.parent
  expect(parseJevRouteResponse(raw, input, route, graph)).toMatchObject({ decision: { include: [], exclude: [] }, route: { intent: 'unknown' } })
  const { parentSessionId: _parent, ...sibling } = route
  expect(parseJevRouteResponse(wire(), input, sibling, graph).route?.intent).toBe('resume')
  const stay = wire(); stay.answers.active.noul = .99; stay.answers.task0.noul = 0
  expect(parseJevRouteResponse(stay, input, route, graph)).toMatchObject({ route: { intent: 'continue' }, decision: { exclude: [] } })
})
it('caps the complete atomic request including the extra questions', () => {
  const huge = { ...route, preferenceExamples: [{ objective: 'x'.repeat(129000) }] } as unknown as ContextActionPacket
  expect(() => buildJevRouteRequest(input, huge, 'policy')).toThrow('byte limit')
})
it('isolates each question evidence instead of mixing all node content into shared state', () => {
  const body = buildJevRouteRequest(input, route, 'policy')
  expect(body.state.graph.nodes).toEqual([])
  expect(body.questions.n0?.instructions).toContain('original goal')
  expect(body.questions.n0?.instructions).not.toContain('other task')
  expect(body.questions.n1?.instructions).toContain('other task')
})
it('keeps evidence and supersession judgments grounded after isolating task state', () => {
  const candidate = { ...route.candidates[0], nodes: [{ id: 'main:1', role: 'user', content: 'unique-target-evidence', truncated: false }] }
  const body = buildJevRouteRequest(input, { ...route, candidates: [candidate] } as ContextActionPacket, 'policy')
  expect(body.questions.e0?.instructions).toContain('unique-target-evidence')
  expect(body.questions.s0?.instructions).toContain('unique-target-evidence')
  expect(JSON.stringify(body.state)).not.toContain('unique-target-evidence')
})
it('delegates existing-task confidence to native Profile review while keeping the stronger new-task gate', () => {
  const raw = wire(); raw.answers.task0.noul = .78
  expect(parseJevRouteResponse(raw, input, route, graph).route).toMatchObject({ intent: 'return', intentScore: .78 })
  raw.answers.newTask.noul = .78; raw.answers.task0.noul = .1
  expect(parseJevRouteResponse(raw, input, route, graph).route?.intent).toBe('unknown')
})
it('does not delegate low-confidence active-task scope to a nonexistent routing check', () => {
  const raw = wire(); raw.answers.active.noul = .3; raw.answers.task0.noul = .1; raw.answers.newTask.noul = .1
  expect(parseJevRouteResponse(raw, input, route, graph).scopeSessionId).toBeUndefined()
})

it('conditions source judgments on the assigned goal without treating its destination as a whole-task scope', async () => {
  const assignment: GoalRouteAssignment = { goal: 'Resume the transport plan', retention: 'relevance' as const, assignment: 'existing', sessionId: SessionId('main') }
  const body = buildJevRouteRequest(input, route, 'Select relevant sources only.', assignment, graph)
  const different = buildJevRouteRequest(input, route, 'Select relevant sources only.', { ...assignment, goal: 'Compare lodging options' })
  expect(body.state.instructions).toContain(JSON.stringify(assignment))
  expect(body.state.instructions).not.toEqual(different.state.instructions)
  expect(body.questions.n0?.instructions).toContain('assigned work item')
  expect(body.questions.e0?.instructions).toContain('assigned work item')
  expect(body.questions.s0?.instructions).toContain('assigned work item')
  expect(body.questions.wholeTask).toBeUndefined()
  expect(body.questions.n0?.instructions).toContain('original goal')
  expect(body.questions.n0?.instructions).not.toContain('other task')
  expect(input.objective).toBe('Resume planning')
  await expect(JSON.stringify(body, null, 2) + '\n').toMatchFileSnapshot('./expected/jev-goal-route-request.json')
})

it('uses destination evidence as the assigned existing task and no inherited task evidence for a new item', () => {
  const card = { ...route.candidates[0], nodes: [{ id: 'main:1', role: 'user', content: 'TARGET_TASK_DETAIL', truncated: false }] }
  const packet = { ...route, activeTask: { ...card, sessionId: SessionId('active'), nodes: [{ ...card.nodes[0], content: 'OLD_ACTIVE_DETAIL' }] }, candidates: [card] } as ContextActionPacket
  const existing = buildJevRouteRequest(input, packet, 'policy', { goal: 'Resume planning', retention: 'relevance' as const, assignment: 'existing', sessionId: SessionId('main') })
  expect(existing.questions.e0?.instructions).not.toContain('OLD_ACTIVE_DETAIL')
  expect(existing.questions.e0?.instructions).toContain('TARGET_TASK_DETAIL')
  const creating = buildJevRouteRequest(input, packet, 'policy', { goal: 'New independent work', retention: 'relevance' as const, assignment: 'new', sessionId: SessionId('main') })
  expect(creating.questions.e0?.instructions).toContain('"currentTask":[]')
  expect(creating.questions.e0?.instructions).not.toContain('OLD_ACTIVE_DETAIL')
})

it('distinguishes inherited and locally owned sources with identical active flags using native provenance', () => {
  expect(buildJevRouteRequest(input, route, 'policy', undefined, graph)).toEqual(buildJevRouteRequest(input, route, 'policy'))
  const duplicateContent = { ...input, nodes: input.nodes.map(node => ({ ...node, content: 'shared planning fact', active: true })) }
  const assigned = { goal: 'Resume the main task', retention: 'relevance' as const, assignment: 'existing' as const, sessionId: SessionId('main') }
  const body = buildJevRouteRequest(duplicateContent, route, 'policy', assigned, graph)
  expect(body.questions.n0?.instructions).toContain(JSON.stringify({ ownerSessionId: 'main', relation: 'assigned-task' }))
  expect(body.questions.n1?.instructions).toContain(JSON.stringify({ ownerSessionId: 'active', relation: 'other-owner' }))
  expect(body.questions.n1?.instructions).toContain('Inherited and other-owner sources remain eligible')
  expect(duplicateContent.nodes.map(node => node.active)).toEqual([true, true])
  const creating = buildJevRouteRequest(input, route, 'policy', { ...assigned, retention: 'relevance' as const, assignment: 'new' }, graph)
  expect(creating.questions.n0?.instructions).toContain(JSON.stringify({ ownerSessionId: 'main', relation: 'new-parent' }))
  const unknown = buildJevRouteRequest(input, route, 'policy', assigned)
  expect(unknown.questions.n0?.instructions).toContain(JSON.stringify({ ownerSessionId: null, relation: 'unknown' }))
  const incomplete = buildJevRouteRequest(input, route, 'policy', assigned, { nodes: graph.nodes.slice(0, 1) })
  expect(incomplete.questions.n1?.instructions).toContain(JSON.stringify({ ownerSessionId: null, relation: 'unknown' }))
})

it('counts native provenance in the complete request byte limit', () => {
  const assigned = { goal: 'Resume planning', retention: 'relevance' as const, assignment: 'existing' as const, sessionId: SessionId('main') }
  const base = buildJevRouteRequest(input, route, '', assigned)
  const policy = 'x'.repeat(131_072 - new TextEncoder().encode(JSON.stringify(base)).byteLength)
  expect(new TextEncoder().encode(JSON.stringify(buildJevRouteRequest(input, route, policy, assigned))).byteLength).toBe(131_072)
  expect(() => buildJevRouteRequest(input, route, policy, assigned, graph)).toThrow('byte limit')
})


it('asks a known goal only about sources, evidence, supersession and explicit preservation', () => {
  const assigned = { goal: 'Resume planning', retention: 'relevance' as const, assignment: 'existing' as const, sessionId: SessionId('main') }
  const known = buildJevRouteRequest(input, route, 'policy', assigned, graph)
  expect(Object.keys(known.questions).sort()).toEqual(['e0', 'n0', 'n1', 's0'])
  expect(Object.keys(buildJevRouteRequest(input, route, 'policy').questions)).toHaveLength(9)
})

import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildGoalRouteInput, parseGoalRouteText, composeGoalContextReview } from '../src/goal-route.ts'
import type { FastRecommendationInput } from '../src/fast-recommendation.ts'
import type { ContextActionPacket } from '../src/semantic-route.ts'
import type { ContextFamilyGraph } from '../src/types.ts'

const packet = { base: { activeSessionId: SessionId('hotel'), planRevision: 1, graphRevision: 'g' },
  objective: 'Arrange a taxi from the hotel to dinner.', parentSessionId: SessionId('main'), explicitIntent: 'unknown',
  activeTask: { sessionId: SessionId('hotel'), label: 'Lodging', depth: 1, nodes: [
    { id: 'hotel:1', role: 'user', content: 'Find a hotel.', truncated: false }],
  }, candidates: [{ sessionId: SessionId('main'), label: 'Dinner', depth: 0, nodes: [
    { id: 'main:1', role: 'user', content: 'Find dinner.', truncated: false }],
  }],
} as unknown as ContextActionPacket
const input = { activeSessionId: packet.base.activeSessionId, objective: packet.objective, nodes: [
  { id: 'main:1', content: 'Find dinner.' }, { id: 'hotel:1', content: 'Find a hotel.' },
], preferenceExamples: [], planExamples: [] } as unknown as FastRecommendationInput
const graph = { sessions: [{ id: 'main' }, { id: 'hotel', parentSessionId: 'main' }],
  nodes: [{ id: 'main:1', owner: { sessionId: 'main' } }, { id: 'hotel:1', owner: { sessionId: 'hotel' } }] } as unknown as ContextFamilyGraph
const assignment = { goal: 'Arrange transport', assignment: 'new', sessionId: 'main' } as const
function wire() { return { model: 'jev-1.13.0', answers: {
  n0: { type: 'noul', noul: .1 }, n1: { type: 'noul', noul: .9 },
  active: { type: 'noul', noul: .3 }, task0: { type: 'noul', noul: .4 }, newTask: { type: 'noul', noul: .5 },
  wholeTask: { type: 'noul', noul: .9 }, parent: { type: 'choice', choice: 'p0', probabilities: { p0: 1 } },
  e0: { type: 'noul', noul: .6 }, s0: { type: 'noul', noul: .1 },
} } }

it('provides native tasks and confirmed route examples without asking the model to copy evidence', () => {
  const withHistory = { ...packet, preferenceExamples: [{ action: 'branch', choice: 'accept', objective: 'Old task',
    routeContext: { source: 'Writing draft', parent: 'Main plan' } }] } as unknown as ContextActionPacket
  const result = buildGoalRouteInput(withHistory, 'Keep independent services separate.')
  expect(result.maxTokens).toBe(512)
  expect(result.system).toContain('unknown')
  const data = JSON.parse(result.userText) as { tasks: unknown[]; confirmedExamples: unknown[]; policy: string }
  expect(data.tasks).toHaveLength(2)
  expect(data.confirmedExamples).toHaveLength(1)
  expect(data.policy).toContain('services separate')
  expect(JSON.stringify(data)).toContain('Find a hotel.')
})
it('accepts only bounded categorical assignments over current native IDs', () => {
  expect(parseGoalRouteText(JSON.stringify(assignment), packet)).toEqual(assignment)
  for (const value of [null, [], {}, { ...assignment, sessionId: 'historical-target' },
    { ...assignment, assignment: 'archive' }, { ...assignment, goal: '' }, { ...assignment, goal: '字'.repeat(201) },
    { ...assignment, quotedEvidence: 'invented' }, { ...assignment, sessionId: null }]) {
    expect(() => parseGoalRouteText(JSON.stringify(value), packet)).toThrow()
  }
  expect(() => parseGoalRouteText('x'.repeat(8193), packet)).toThrow('byte')
})
it('rejects a valid-looking assignment wrapped in an array or surrounding prose', () => {
  expect(() => parseGoalRouteText(JSON.stringify([assignment]), packet)).toThrow()
  expect(() => parseGoalRouteText(`Untrusted text ${JSON.stringify(assignment)}`, packet)).toThrow()
})
it('accepts a short Chinese goal while rejecting a whitespace-only goal', () => {
  expect(parseGoalRouteText(JSON.stringify({ ...assignment, goal: '订车' }), packet).goal).toBe('订车')
  expect(() => parseGoalRouteText(JSON.stringify({ ...assignment, goal: '  ' }), packet)).toThrow()
})
it('allows an explicit abstention and performs no inferred Context or route operation', () => {
  const unknown = parseGoalRouteText('{"goal":"Ambiguous work","assignment":"unknown","sessionId":null}', packet)
  expect(composeGoalContextReview(unknown, undefined, input, packet, graph)).toMatchObject({
    decision: { include: [], exclude: [], archive: [] }, route: { intent: 'unknown', intentScore: 0 },
  })
  expect(() => parseGoalRouteText('{"goal":"Ambiguous work","assignment":"unknown","sessionId":"main"}', packet)).toThrow()
})
it('uses the generated parent assignment and native whole-task scope while retaining Jev supersession', () => {
  const result = composeGoalContextReview(parseGoalRouteText(JSON.stringify(assignment), packet), wire(), input, packet, graph)
  expect(result.route).toMatchObject({ intent: 'new-task', forkParentSessionId: 'main',
    candidates: [{ sessionId: 'main', supersededScore: .1, evidenceScore: .6 }] })
  expect(result.scopeSessionId).toBe('main')
  expect(result.decision.include.map(x => x.nodeId)).toEqual(['main:1'])
  expect(result.decision.exclude.map(x => x.nodeId)).toEqual(['hotel:1'])
})
it('keeps Jev individual membership when whole-task policy is absent and maps existing work correctly', () => {
  const raw = wire(); raw.answers.wholeTask.noul = .1
  const existing = (id: string) => parseGoalRouteText(JSON.stringify({ ...assignment, assignment: 'existing', sessionId: id }), packet)
  expect(composeGoalContextReview(existing('hotel'), raw, input, packet, graph)).toMatchObject({
    route: { intent: 'continue' }, decision: { include: [{ nodeId: 'hotel:1' }] },
  })
  expect(composeGoalContextReview(existing('main'), raw, input, packet, graph).route?.intent).toBe('return')
  const sibling = { ...packet }
  delete sibling.parentSessionId
  expect(composeGoalContextReview(existing('main'), raw, input, sibling, graph).route?.intent).toBe('resume')
  expect(() => composeGoalContextReview(existing('main'), {}, input, packet, graph)).toThrow()
})
it('bounds complete proposal input including Unicode evidence and policy', () => {
  expect(() => buildGoalRouteInput(packet, '字'.repeat(24000))).toThrow('byte')
  const withoutActive = { ...packet }
  delete withoutActive.activeTask
  const partial = buildGoalRouteInput(withoutActive, 'Review available evidence.')
  expect((JSON.parse(partial.userText) as { tasks: unknown[] }).tasks).toHaveLength(1)
})

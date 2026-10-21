import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextFamilyGraph } from '../src/types.ts'
import { buildLocalContextCandidates } from '../src/local-recommendation.ts'

it('derives local calibration candidates without a model slate or losing current selection', () => {
  const active = SessionId('local-active'), other = SessionId('local-other')
  const graph = { activeSessionId: active, nodes: [
    { id: 'a', role: 'user', preview: 'Plan this task', sessionIds: [active] },
    { id: 'b', role: 'tool', preview: 'Plan this task', sourceKind: 'web', webAction: 'web_fetch', sessionIds: [other] },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `old-${i}`, role: 'assistant', preview: 'Old task', sessionIds: [active] })),
  ] } as unknown as ContextFamilyGraph
  const result = buildLocalContextCandidates({ graph, contents: { a: 'Unrelated content' },
    objective: 'Plan this task', effectiveIncludedNodeIds: ['a'], explicitExcludedNodeIds: [], reviewableExcludedNodeIds: [] })
  expect(result).toHaveLength(42)
  expect(result[0]).toMatchObject({ id: 'a', active: true, included: true, lexicalScore: 0 })
  expect(result[1]).toMatchObject({ id: 'b', active: false, included: false,
    sourceKind: 'web', webAction: 'web_fetch', reason: 'off-path-candidate', lexicalScore: 1 })
  expect(Object.isFrozen(result)).toBe(true)
  expect(result.every(Object.isFrozen)).toBe(true)
})
it('handles an empty local graph without inventing candidates', () => {
  expect(buildLocalContextCandidates({ graph: { activeSessionId: SessionId('empty'), nodes: [] } as unknown as ContextFamilyGraph,
    contents: {}, objective: '', effectiveIncludedNodeIds: [], explicitExcludedNodeIds: [], reviewableExcludedNodeIds: [] })).toEqual([])
})
it('keeps direct Excludes out of automatic additions while allowing reviewed temporary exclusions', () => {
  const active = SessionId('active'), other = SessionId('other')
  const graph = { activeSessionId: active, nodes: ['pinned', 'reviewed', 'eligible'].map(id => ({
    id, role: 'user', preview: 'Plan this task', sessionIds: [other],
  })) } as unknown as ContextFamilyGraph
  const result = buildLocalContextCandidates({ graph, contents: {}, objective: 'Plan this task',
    effectiveIncludedNodeIds: [], explicitExcludedNodeIds: ['pinned', 'reviewed'], reviewableExcludedNodeIds: ['reviewed'] })
  expect(result.map(row => [row.id, row.reason])).toEqual([
    ['pinned', 'local-protected'], ['reviewed', 'off-path-candidate'], ['eligible', 'off-path-candidate'],
  ])
})

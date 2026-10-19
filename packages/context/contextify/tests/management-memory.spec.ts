import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextPolicyObservation } from '../src/types.ts'
import { buildManagementMemory } from '../src/management-memory.ts'

const context = { activity: 'planning' as const, branchDepth: 0 }
type ObservationPatch = { [K in keyof ContextPolicyObservation]?: ContextPolicyObservation[K] | undefined }
function observation(index: number, patch: ObservationPatch = {}): ContextPolicyObservation {
  const value = { sourceSessionId: SessionId('root'), sourceEventSeq: index, at: index,
    action: 'include', choice: 'accept', origin: 'manual-action', branchDepth: 0,
    activity: 'planning', objective: 'Plan the trip', ...patch }
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as unknown as ContextPolicyObservation
}
function chain(index: number, choice: 'accept' | 'reject' = 'accept'): ContextPolicyObservation[] {
  const root = SessionId(`root-${index}`), child = SessionId(`child-${index}`)
  return [observation(index, { sourceSessionId: root, action: 'branch', targetSessionId: child }),
    observation(index + 1, { sourceSessionId: child, action: 'return', branchDepth: 1,
      targetSessionId: root, choice, objective: 'Return to the main plan' })]
}
const memory = (observations: ContextPolicyObservation[]) => buildManagementMemory(observations, context)

describe('conditional management memory', () => {
  it('keeps source-conditioned support and native event references', () => {
    const rows = [...Array.from({ length: 6 }, (_, i) => observation(i, { sourceKind: 'web' })),
      ...Array.from({ length: 6 }, (_, i) => observation(i + 6, { sourceKind: 'chat', choice: 'reject' }))]
    const result = memory(rows)
    expect(result.rules).toHaveLength(2)
    expect(result.rules.find(rule => rule.sourceKind === 'web')).toMatchObject({
      action: 'include', tendency: 'favor', support: 6, accepted: 6, rejected: 0,
      references: [{ sessionId: 'root', eventSeq: 5 }, { sessionId: 'root', eventSeq: 4 },
        { sessionId: 'root', eventSeq: 3 }, { sessionId: 'root', eventSeq: 2 },
        { sessionId: 'root', eventSeq: 1 }, { sessionId: 'root', eventSeq: 0 }],
    })
    expect(result.rules.find(rule => rule.sourceKind === 'chat')?.tendency).toBe('avoid')
  })

  it('does not turn missing references, duplicate events or one grouped review into repeated support', () => {
    expect(memory(Array.from({ length: 8 }, () => observation(1))).rules).toEqual([])
    expect(memory(Array.from({ length: 8 }, (_, i) => observation(i, { sourceSessionId: undefined }))).rules).toEqual([])
    expect(memory(Array.from({ length: 8 }, (_, i) => observation(i, { weight: .1 }))).rules).toEqual([])
  })

  it('learns only repeated causal cross-session management workflows', () => {
    const result = memory([...chain(1), ...chain(10)])
    expect(result.workflows).toHaveLength(1)
    expect(result.workflows[0]).toMatchObject({ actions: ['branch', 'return'], activity: 'planning',
      branchDepth: 0, tendency: 'favor', support: 2, accepted: 2, rejected: 0 })
    expect(result.workflows[0]!.references).toHaveLength(4)
    expect(result.workflows[0]!.examples).toHaveLength(2)
    expect(memory(chain(1)).workflows).toEqual([])
  })

  it('preserves rejected terminal actions as negative workflow evidence and abstains on mixed support', () => {
    expect(memory([...chain(1, 'reject'), ...chain(10, 'reject')]).workflows[0])
      .toMatchObject({ actions: ['branch', 'return'], tendency: 'avoid', accepted: 0, rejected: 2 })
    expect(memory([...chain(1), ...chain(10, 'reject')]).workflows).toEqual([])
  })

  it('does not join unrelated owners, backwards cursors or missing destinations', () => {
    const rows = [...chain(1), ...chain(10)]
    expect(memory(rows.map(row => row.action === 'branch' ? observation(row.sourceEventSeq!, { ...row, targetSessionId: undefined }) : row)).workflows).toEqual([])
    expect(memory(rows.map(row => row.action === 'return' ? { ...row, sourceSessionId: SessionId('unrelated') } : row)).workflows).toEqual([])
    expect(memory([4, 3, 2, 1].map((seq, at) => observation(seq, { at }))).workflows).toEqual([])
  })

  it('does not treat a lifecycle mutation in another task as a navigation step', () => {
    const rows = [...chain(1), ...chain(10)].map(row => row.action === 'branch'
      ? { ...row, action: 'park' as const } : row)
    expect(memory(rows).workflows).toEqual([])
  })

  it('retracts workflows and rules after Undo or an empty reset projection', () => {
    const rows = [...chain(1), ...chain(10)]
    rows[1] = { ...rows[1]!, undone: true }
    expect(memory(rows).workflows).toEqual([])
    expect(memory(Array.from({ length: 6 }, (_, i) => observation(i, { undone: true }))).rules).toEqual([])
    expect(memory([])).toEqual({ rules: [], workflows: [] })
  })

  it('does not promote a rule for a different activity or workflows at a different depth', () => {
    const rows = [...chain(1), ...chain(10)]
    expect(buildManagementMemory(rows, { activity: 'writing', branchDepth: 0 }).workflows).toEqual([])
    expect(buildManagementMemory(rows, { activity: 'planning', branchDepth: 4 }).workflows).toEqual([])
    expect(buildManagementMemory(Array.from({ length: 6 }, (_, i) => observation(i)),
      { activity: 'writing', branchDepth: 0 }).rules).toEqual([])
  })

  it('bounds complete UTF-8 output without truncating evidence identities', () => {
    const rows = Array.from({ length: 8 }, (_, i) => observation(i, { sourceSessionId: SessionId('汉'.repeat(9000)) }))
    const result = memory(rows)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024)
    expect(result.rules).toEqual([])
    expect(result.omittedRules).toBeGreaterThan(0)
  })

  it('retains unknown-condition evidence without inventing an activity and supports fractional votes', () => {
    const rows = Array.from({ length: 8 }, (_, i) => observation(i, { activity: undefined,
      sourceKind: i < 4 ? 'web' : 'chat', choice: i === 7 ? 'reject' : 'accept', weight: .75 }))
    const result = buildManagementMemory(rows, { branchDepth: 0 })
    expect(result.rules[0]).toMatchObject({ accepted: 5.25, rejected: .75, support: 6 })
    expect(result.rules[0]!.activity).toBeUndefined()
    expect(result.rules[0]!.sourceKind).toBeUndefined()
    const unknown = Array.from({ length: 7 }, (_, i) => observation(i, { activity: undefined,
      sourceKind: 'web', action: i % 2 === 0 ? 'include' : 'release', objective: undefined }))
    expect(buildManagementMemory(unknown, { branchDepth: 0 }).workflows[0]?.examples[0]).toEqual(['', ''])
    expect(buildManagementMemory(rows, { sourceKind: 'web', branchDepth: 0 }).rules).toEqual([])
  })

  it('treats task transfer as a causal boundary within the same owner', () => {
    const rows = [observation(1, { action: 'navigate', targetSessionId: SessionId('other') }), observation(2),
      observation(3, { action: 'navigate', targetSessionId: SessionId('other') }), observation(4)]
    expect(memory(rows).workflows).toEqual([])
    const simultaneous = [...chain(1), ...chain(10)].map(row => ({ ...row, at: 1 }))
    expect(memory(simultaneous).workflows).toEqual([])
  })

  it('keeps fractional workflow support below the repeated-review requirement', () => {
    expect(memory([...chain(1), ...chain(10)].map(row => ({ ...row, weight: .25 }))).workflows).toEqual([])
  })

  it('caps both rule and workflow inventories rather than growing an unbounded persona', () => {
    const actions = ['include', 'release', 'branch', 'return', 'navigate', 'park', 'complete', 'reopen'] as const
    const rows = actions.flatMap((action, a) => Array.from({ length: 8 }, (_, i) => observation(a * 8 + i,
      { action, sourceKind: i < 4 ? 'web' : 'chat', choice: i < 4 ? 'accept' : 'reject' })))
    const result = memory(rows)
    expect(result.rules).toHaveLength(8)
    expect(result.omittedRules).toBeGreaterThan(0)
    const repeated = actions.flatMap((action, a) => Array.from({ length: 4 }, (_, i) => observation(a * 4 + i,
      { action, sourceSessionId: SessionId(`workflow-${a}`) })))
    const workflows = memory(repeated)
    expect(workflows.workflows).toHaveLength(4)
    expect(workflows.omittedWorkflows).toBeGreaterThan(0)
  })

  it('drops oversized workflow examples as complete items', () => {
    const rows = [...chain(1), ...chain(10)].map(row => ({ ...row,
      sourceSessionId: SessionId('汉'.repeat(5000) + String(row.sourceSessionId)),
      targetSessionId: SessionId('汉'.repeat(5000) + String(row.targetSessionId)), objective: '字'.repeat(1000) }))
    const result = memory(rows)
    expect(result.workflows).toEqual([])
    expect(result.omittedWorkflows).toBe(1)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024)
  })

  it('ignores unusable evidence cursors, times and zero support', () => {
    const rows = [observation(1, { sourceEventSeq: undefined }), observation(2, { sourceEventSeq: -1 }),
      observation(3, { sourceEventSeq: .5 }), observation(4, { at: NaN }), observation(5, { weight: 0 })]
    expect(memory(rows)).toEqual({ rules: [], workflows: [] })
  })

  it('retains activity exceptions and only generalizes when multiple activities support the same rule', () => {
    const rows = Array.from({ length: 12 }, (_, i) => observation(i, {
      activity: i < 6 ? 'planning' : 'writing', choice: i < 6 ? 'accept' : 'reject' }))
    const result = buildManagementMemory(rows, { branchDepth: 0 })
    expect(result.rules.map(rule => [rule.activity, rule.tendency]).sort()).toEqual([
      ['planning', 'favor'], ['writing', 'avoid'],
    ])
    const agreed = buildManagementMemory(rows.map(row => ({ ...row, choice: 'accept' })), { branchDepth: 0 })
    expect(agreed.rules[0]!.activity).toBeUndefined()
  })

  it('orders same-millisecond actions by their owned event cursors', () => {
    const rows = Array.from({ length: 5 }, (_, i) => observation(5 - i, { at: 1 }))
    expect(memory(rows).workflows[0]).toMatchObject({ actions: ['include', 'include'], support: 4 })
  })
})

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { contextLifecycleAdvice } from '../src/lifecycle-advice.ts'
import type { ContextFamilyGraph } from '../src/types.ts'

const root = SessionId('lifecycle-root')
const current = SessionId('lifecycle-current')
const graph: ContextFamilyGraph = {
  rootSessionId: root, activeSessionId: current,
  sessions: [{ id: root, depth: 0, seedLength: 0, tipNodeId: null, workState: 'parked' },
    { id: current, parentSessionId: root, depth: 1, seedLength: 0, tipNodeId: null, workState: 'open' }],
  nodes: [], edges: [],
}

describe('review-only current-task lifecycle advice', () => {
  it.each(['Park this task', 'Pause the current branch', 'Defer this task until tomorrow',
    '暂缓当前任务', '暂停这个分支', '搁置当前任务'])('proposes Park for the explicit prefix %s', (objective) => {
    const before = JSON.stringify(graph)
    expect(contextLifecycleAdvice(graph, objective)).toMatchObject([{ sessionId: current, state: 'parked' }])
    expect(JSON.stringify(graph)).toBe(before)
  })

  it.each(['Complete this task', 'Finish the current branch', 'Close this task',
    '完成当前任务', '结束这个分支'])('proposes Complete for the explicit prefix %s', (objective) => {
    expect(contextLifecycleAdvice(graph, objective)).toMatchObject([{ sessionId: current, state: 'completed' }])
  })

  it.each(['Reopen this task', 'Restart the current branch', '重新打开当前任务', '重新开始这个分支'])(
    'proposes Reopen only when state differs: %s', (objective) => {
      const closed = { ...graph, sessions: graph.sessions.map(session => session.id === current
        ? { ...session, workState: 'completed' as const } : session) }
      const advice = contextLifecycleAdvice(closed, objective)
      expect(advice).toMatchObject([{ sessionId: current, state: 'open' }])
      expect(Object.isFrozen(advice)).toBe(true)
      expect(Object.isFrozen(advice[0])).toBe(true)
      expect(contextLifecycleAdvice(graph, objective)).toEqual([])
    })

  it.each(['', 'Finish writing the next paragraph', 'The user said complete this task',
    'Please discuss whether to pause this task', 'Complete a different task',
    '完成另一项任务', '想一想暂停当前任务的利弊'])(
    'abstains for quoted, incidental or noncurrent lifecycle language: %s', (objective) => {
      expect(contextLifecycleAdvice(graph, objective)).toEqual([])
    })

  it('does not repeat the existing state or propose a change without an active Session', () => {
    for (const [objective, workState] of [['Park this task', 'parked'], ['Complete this task', 'completed']] as const) {
      const same = { ...graph, sessions: graph.sessions.map(session => session.id === current
        ? { ...session, workState } : session) }
      expect(contextLifecycleAdvice(same, objective)).toEqual([])
    }
    expect(contextLifecycleAdvice({ ...graph, sessions: [] }, 'Park this task')).toEqual([])
  })
})

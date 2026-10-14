import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  buildContextRouteCandidates, planContextRoute,
  type ScoredContextRouteCandidate,
} from '../src/context-route-policy.ts'
import type { ContextFamilyGraph } from '../src/types.ts'

const prior: ScoredContextRouteCandidate = {
  sessionId: SessionId('writing'), parentSessionId: SessionId('main'), depth: 1, label: 'Paper outline',
  ownedNodeIds: ['outline', 'draft'], offPathNodeIds: ['outline', 'draft'], evidenceNodeIds: ['outline'],
  lexicalScore: 0.4, destinationScore: 0.84, evidenceScore: 0.9, supersededScore: 0.05,
}
const base = { activeSessionId: SessionId('planning'), parentSessionId: SessionId('main'), candidates: [prior] }

describe('context route policy', () => {
  it('keeps navigation distinct from borrowing context', () => {
    expect(planContextRoute({ ...base, intent: 'resume' })).toMatchObject({
      action: 'navigate', targetSessionId: 'writing', needsReview: true,
    })
    expect(planContextRoute({ ...base, intent: 'reference' })).toMatchObject({
      action: 'include', targetSessionId: 'writing', sourceNodeIds: ['outline'], needsReview: true,
    })
  })

  it('returns through native Session ancestry, not a guessed branch match', () => {
    expect(planContextRoute({ ...base, intent: 'return', candidates: [] })).toMatchObject({
      action: 'return', targetSessionId: 'main', needsReview: true,
    })
  })

  it('rejects unsafe or unbounded evidence, even when semantic relevance is high', () => {
    expect(planContextRoute({ ...base, intent: 'reference', candidates: [{
      ...prior, supersededScore: 0.9,
    }] }).action).toBe('continue')
    expect(planContextRoute({ ...base, intent: 'reference', candidates: [{
      ...prior, evidenceNodeIds: ['outline', 'draft', 'x', 'y', 'z'],
    }] }).action).toBe('continue')
    expect(planContextRoute({ ...base, intent: 'reference', candidates: [{
      ...prior, offPathNodeIds: ['draft'],
    }] }).action).toBe('continue')
  })

  it('suggests a new branch only for an explicit new task without a clear destination', () => {
    expect(planContextRoute({ ...base, intent: 'new-task', candidates: [{
      ...prior, destinationScore: 0.3,
    }] }).action).toBe('branch')
    expect(planContextRoute({ ...base, intent: 'unknown', candidates: [] }).action).toBe('continue')
  })

  it('keeps completed branches available as evidence but not casual new-task destinations', () => {
    const completed = { ...prior, workState: 'completed' as const }
    expect(planContextRoute({ ...base, intent: 'new-task', candidates: [completed] }).action)
      .toBe('branch')
    expect(planContextRoute({ ...base, intent: 'resume', candidates: [completed] }).action)
      .toBe('navigate')
    expect(planContextRoute({ ...base, intent: 'reference', candidates: [completed] }).action)
      .toBe('include')
  })

  it('does not silently navigate when candidate destinations are tied', () => {
    expect(planContextRoute({ ...base, intent: 'resume', candidates: [prior, {
      ...prior, sessionId: SessionId('review'), destinationScore: 0.8,
    }] }).action).toBe('continue')
  })

  it('builds branch candidates from owned nodes without duplicating inherited ancestry', () => {
    const graph = {
      activeSessionId: SessionId('planning'),
      sessions: [
        { id: SessionId('main'), depth: 0, tipNodeId: 'root' },
        { id: SessionId('planning'), parentSessionId: SessionId('main'), depth: 1, tipNodeId: 'plan' },
        { id: SessionId('writing'), parentSessionId: SessionId('main'), depth: 1, tipNodeId: 'draft' },
      ],
      nodes: [
        { id: 'root', owner: { sessionId: 'main', seq: 1 }, sessionIds: ['main', 'planning', 'writing'], role: 'user', preview: 'Start paper' },
        { id: 'plan', owner: { sessionId: 'planning', seq: 3 }, sessionIds: ['planning'], role: 'user', preview: 'Plan experiments' },
        { id: 'draft', owner: { sessionId: 'writing', seq: 4 }, sessionIds: ['writing'], role: 'user', preview: 'Write paper outline' },
      ],
    } as unknown as ContextFamilyGraph
    const candidates = buildContextRouteCandidates({
      graph, contents: {}, objective: 'Continue writing the paper outline',
    })
    expect(candidates.find(candidate => candidate.sessionId === 'writing')).toMatchObject({
      label: 'Write paper outline', ownedNodeIds: ['draft'],
    })
    expect(candidates.find(candidate => candidate.sessionId === 'main')?.ownedNodeIds).toEqual(['root'])
    expect(candidates.find(candidate => candidate.sessionId === 'main')?.offPathNodeIds).toEqual([])
    expect(candidates.every(candidate => candidate.sessionId !== 'planning')).toBe(true)
  })
})

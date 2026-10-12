import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  branchFeedbackFromFamily, personalBranchSuggestionFromKeep, personalBranchSuppressionFromMove,
  personalBranchThreshold,
} from '../src/personal-branch-policy.ts'
import type { ContextFamilyGraph, ContextFamilyInspection } from '../src/types.ts'

const query = { candidateInput: 'compare a new warranty region', branchDepth: 2 }
const rejected = {
  candidateInput: 'compare warranty rules in a new region',
  branchDepth: 2,
  confidence: 0.9,
  choice: 'keep' as const,
  uiOrigin: 'contextify-client' as const,
}

describe('personal Branch suggestion calibration', () => {
  it('preserves the generic threshold without UI-confirmed feedback', () => {
    expect(personalBranchThreshold(0.82, query, [])).toBe(0.82)
    expect(personalBranchThreshold(0.82, query, [{
      candidateInput: rejected.candidateInput, branchDepth: rejected.branchDepth,
      confidence: rejected.confidence, choice: rejected.choice,
    }]))
      .toBe(0.82)
  })

  it('raises the suggestion threshold after a similar visible rejection', () => {
    expect(personalBranchThreshold(0.82, query, [rejected])).toBeGreaterThan(0.82)
  })

  it('uses a bounded correction and gives related decisions more weight', () => {
    const related = personalBranchThreshold(0.82, query, [rejected])
    const unrelated = personalBranchThreshold(0.82, query, [{
      ...rejected, candidateInput: 'unrelated weather forecast', branchDepth: 0,
    }])
    expect(related).toBeGreaterThan(unrelated)
    expect(personalBranchThreshold(0.82, query, Array(100).fill(rejected)))
      .toBeLessThanOrEqual(0.87)
  })

  it('learns accepted and rejected Move suggestions with symmetric strength', () => {
    const accepted = { ...rejected, choice: 'move' as const }
    const acceptedThreshold = personalBranchThreshold(0.82, query,
      Array.from({ length: 10 }, () => accepted))
    const rejectedThreshold = personalBranchThreshold(0.82, query,
      Array.from({ length: 10 }, () => rejected))
    expect(acceptedThreshold).toBeCloseTo(0.77)
    expect(rejectedThreshold).toBeCloseTo(0.87)
  })

  it('may surface a low-confidence generic Keep after repeated similar explicit Moves', () => {
    const accepted = { ...rejected, choice: 'move' as const }
    const acceptedHistory = Array.from({ length: 4 }, () => accepted)
    const suggestion = personalBranchSuggestionFromKeep(query, 0.55, acceptedHistory)
    expect(suggestion?.reason).toContain('earlier')
    expect(suggestion?.confidence).toBeGreaterThanOrEqual(0.6)
    expect(personalBranchSuggestionFromKeep(query, 0.8, acceptedHistory)).toBeNull()
    expect(personalBranchSuggestionFromKeep(query, 0.55, Array.from({ length: 4 }, () => ({
      ...accepted, candidateInput: 'unrelated weather forecast', branchDepth: 0,
    })))).toBeNull()
    expect(personalBranchSuggestionFromKeep(query, 0.55, [
      ...acceptedHistory, ...Array.from({ length: 2 }, () => rejected),
    ])).toBeNull()
  })

  it('can transfer repeated explicit Moves across growing native branch depths', () => {
    const accepted = { ...rejected, choice: 'move' as const }
    const deepQuery = { ...query, branchDepth: 4 }
    const history = Array.from({ length: 4 }, (_, branchDepth) => ({ ...accepted, branchDepth }))
    expect(personalBranchSuggestionFromKeep(deepQuery, 0.55, history)).not.toBeNull()
  })

  it('learns a repeated coarse Branch style across different requests without overriding extreme confidence', () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      ...rejected, candidateInput: `different shopping request ${String(index)}`,
    }))
    expect(personalBranchSuppressionFromMove(query, 0.9, history)).toBe(true)
    expect(personalBranchSuppressionFromMove(query, 0.95, history)).toBe(false)
    expect(personalBranchSuppressionFromMove(query, 0.9, history.slice(0, 4))).toBe(false)
    expect(personalBranchSuppressionFromMove(query, 0.9, [
      ...history.slice(0, 4), ...Array.from({ length: 2 }, () => ({ ...rejected, choice: 'move' as const })),
    ])).toBe(false)
  })

  it('uses repeated fine Branch style to surface a reviewable Move despite unrelated wording', () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      ...rejected, candidateInput: `different shopping request ${String(index)}`,
      choice: 'move' as const,
    }))
    expect(personalBranchSuggestionFromKeep(query, 0.8, history)?.reason).toContain('earlier')
    expect(personalBranchSuggestionFromKeep(query, 0.95, history)).toBeNull()
  })

  it('counts one UI choice despite inherited Session events and skips unmarked Remote choices', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('policy-root'))
      const suggestion = {
        id: 'review-1', sourceSessionId: root.id, turn: 1,
        boundaryBefore: 0, boundaryAfter: 3,
        input: { sessionId: root.id, seq: 1 }, output: { sessionId: root.id, seq: 2 },
        inputPreview: rejected.candidateInput, outputPreview: 'answer',
        confidence: 0.9, reason: 'parallel topic', planRevision: 1, graphRevision: 'g',
      }
      root.append('contextify/branch-review', { suggestion, turnEndSeq: 3 })
      root.append('contextify/branch-choice', {
        suggestionId: suggestion.id, choice: 'keep', turnEndSeq: 3, uiOrigin: 'contextify-client',
      })
      root.append('contextify/branch-review', {
        suggestion: { ...suggestion, id: 'review-2' }, turnEndSeq: 4,
      })
      root.append('contextify/branch-choice', {
        suggestionId: 'review-2', choice: 'move', turnEndSeq: 4,
      })
      const events = root.snapshotEvents()
      const childId = SessionId('policy-child')
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: root.id,
        sessions: [
          { id: root.id, seedLength: 0, depth: 2, tipNodeId: null },
          { id: childId, parentSessionId: root.id, seedLength: events.length, depth: 3, tipNodeId: null },
        ],
        nodes: [], edges: [],
      }
      const inspections = new Map<SessionId, ContextFamilyInspection>([
        [root.id, { meta: root.header, events, inheritedEventCount: 0 }],
        [childId, { meta: { ...root.header, id: childId, parentSession: root.id },
          events, inheritedEventCount: events.length }],
      ])
      expect(branchFeedbackFromFamily(graph, inspections)).toEqual([{
        candidateInput: suggestion.inputPreview, branchDepth: 2,
        confidence: 0.9, choice: 'keep', uiOrigin: 'contextify-client',
      }])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the latest 32 explicit Branch cases in event-time order across Sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('case-ledger-root'))
      const child = ctx.sessions.create(SessionId('case-ledger-child'))
      const appendChoice = (session: typeof root, label: string): void => {
        const suggestion = {
          id: label, sourceSessionId: session.id, turn: 1,
          boundaryBefore: 0, boundaryAfter: 0,
          input: { sessionId: session.id, seq: 0 }, output: { sessionId: session.id, seq: 0 },
          inputPreview: label, outputPreview: 'answer',
          confidence: 0.9, reason: 'parallel topic', planRevision: 1, graphRevision: 'g',
        }
        session.append('contextify/branch-review', { suggestion, turnEndSeq: 0 })
        session.append('contextify/branch-choice', {
          suggestionId: label, choice: 'move', turnEndSeq: 0, uiOrigin: 'contextify-client',
        })
      }
      for (let index = 0; index < 35; index += 1) appendChoice(root, `root-${String(index)}`)
      appendChoice(child, 'newer-child')
      const graph: ContextFamilyGraph = {
        rootSessionId: root.id, activeSessionId: child.id,
        sessions: [{ id: root.id, seedLength: 0, depth: 0, tipNodeId: null },
          { id: child.id, parentSessionId: root.id, seedLength: 0, depth: 1, tipNodeId: null }],
        nodes: [], edges: [],
      }
      const inspections = new Map<SessionId, ContextFamilyInspection>([
        [child.id, { meta: { ...child.header, parentSession: root.id },
          events: child.snapshotEvents().map(event => ({ ...event, time: event.time + 1000 })),
          inheritedEventCount: 0 }],
        [root.id, { meta: root.header, events: root.snapshotEvents(), inheritedEventCount: 0 }],
      ])
      const history = branchFeedbackFromFamily(graph, inspections)
      expect(history).toHaveLength(32)
      expect(history[0]?.candidateInput).toBe('root-4')
      expect(history.at(-1)?.candidateInput).toBe('newer-child')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

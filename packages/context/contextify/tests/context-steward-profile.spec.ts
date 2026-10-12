import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { planContextRoute, type ScoredContextRouteCandidate } from '../src/context-route-policy.ts'
import { deriveContextStewardProfile } from '../src/context-steward-profile.ts'
import type { ContextPolicyObservation } from '../src/types.ts'

const candidate: ScoredContextRouteCandidate = {
  sessionId: SessionId('outline'), parentSessionId: SessionId('root'), depth: 1, label: 'Outline',
  ownedNodeIds: ['claim'], offPathNodeIds: ['claim'], evidenceNodeIds: ['claim'], lexicalScore: 0.3,
  destinationScore: 0.2, evidenceScore: 0.69, supersededScore: 0,
}

function history(choice: 'accept' | 'reject'): ContextPolicyObservation[] {
  return Array.from({ length: 8 }, (_, index) => ({
    action: 'include', choice, origin: 'explicit-review',
    activity: 'writing', branchDepth: 1, at: index + 1,
  }))
}

describe('Context Steward policy memory', () => {
  it('backs off to the generic threshold for a cold user', () => {
    const profile = deriveContextStewardProfile([], { activity: 'writing', branchDepth: 1 })
    expect(profile.evidence).toEqual({ acceptRate: 0.5, support: 0 })
    expect(profile.thresholds.evidence).toBe(0.7)
  })

  it('uses reviewed Context choices to personalize the same candidate without auto-applying', () => {
    const permissive = deriveContextStewardProfile(history('accept'), { activity: 'writing', branchDepth: 1 })
    const conservative = deriveContextStewardProfile(history('reject'), { activity: 'writing', branchDepth: 1 })
    const route = (thresholds: typeof permissive.thresholds) => planContextRoute({
      intent: 'reference', activeSessionId: SessionId('current'), candidates: [candidate], thresholds,
    })
    expect(permissive.thresholds.evidence).toBeLessThan(candidate.evidenceScore)
    expect(conservative.thresholds.evidence).toBeGreaterThan(candidate.evidenceScore)
    expect(route(permissive.thresholds)).toMatchObject({ action: 'include', needsReview: true })
    expect(route(conservative.thresholds).action).toBe('continue')
  })

  it('ignores undone choices and backs off from a sparse activity cell', () => {
    const mixed = [...history('accept'), {
      action: 'include', choice: 'reject', origin: 'explicit-review',
      activity: 'planning', branchDepth: 3, at: 10, undone: true,
    }] as ContextPolicyObservation[]
    const profile = deriveContextStewardProfile(mixed, { activity: 'planning', branchDepth: 3 })
    expect(profile.evidence.support).toBe(8)
    expect(profile.evidence.acceptRate).toBeGreaterThan(0.8)
  })

  it('learns source-specific Context preferences without treating one source as a global persona', () => {
    const observations: ContextPolicyObservation[] = [
      ...Array.from({ length: 6 }, (_, at) => ({ action: 'include' as const,
        choice: 'accept' as const, origin: 'explicit-review' as const,
        sourceKind: 'web' as const, branchDepth: 1, at })),
      ...Array.from({ length: 6 }, (_, index) => ({ action: 'include' as const,
        choice: 'reject' as const, origin: 'explicit-review' as const,
        sourceKind: 'chat' as const, branchDepth: 1, at: index + 6 })),
    ]
    const web = deriveContextStewardProfile(observations, { sourceKind: 'web', branchDepth: 1 })
    const chat = deriveContextStewardProfile(observations, { sourceKind: 'chat', branchDepth: 1 })
    const unknown = deriveContextStewardProfile(observations, { sourceKind: 'worker', branchDepth: 1 })
    expect(web.evidence.acceptRate).toBeGreaterThan(chat.evidence.acceptRate)
    expect(web.thresholds.evidence).toBeLessThan(chat.thresholds.evidence)
    expect(unknown.evidence.support).toBe(12)
    expect(web.rules).toContainEqual({
      action: 'include', sourceKind: 'web', tendency: 'favor', support: 6, acceptRate: 0.8,
    })
    expect(web.rules).toContainEqual({
      action: 'include', sourceKind: 'chat', tendency: 'avoid', support: 6, acceptRate: 0.2,
    })
    expect(web.rules.some(rule => rule.action === 'include' && rule.sourceKind === undefined)).toBe(false)
  })

  it('learns different branch granularity at shallow and deep graph positions', () => {
    const observations: ContextPolicyObservation[] = [
      ...Array.from({ length: 6 }, (_, at) => ({ action: 'branch' as const,
        choice: 'accept' as const, origin: 'explicit-review' as const,
        branchDepth: 0, at })),
      ...Array.from({ length: 6 }, (_, index) => ({ action: 'branch' as const,
        choice: 'reject' as const, origin: 'explicit-review' as const,
        branchDepth: 3, at: index + 6 })),
    ]
    const shallow = deriveContextStewardProfile(observations, { branchDepth: 0 })
    const deep = deriveContextStewardProfile(observations, { branchDepth: 3 })
    expect(shallow.branch).toEqual({ acceptRate: 0.8, support: 6 })
    expect(deep.branch).toEqual({ acceptRate: 0.2, support: 6 })
  })

  it('backs off when a Context cell contains many low-weight items from one review', () => {
    const observations: ContextPolicyObservation[] = [
      ...Array.from({ length: 8 }, (_, at) => ({ action: 'include' as const,
        choice: 'reject' as const, origin: 'explicit-review' as const,
        branchDepth: 1, at, weight: 0.125 })),
      ...Array.from({ length: 5 }, (_, index) => ({ action: 'include' as const,
        choice: 'accept' as const, origin: 'explicit-review' as const,
        branchDepth: 4, at: index + 8 })),
    ]
    const shallow = deriveContextStewardProfile(observations, { branchDepth: 1 })
    expect(shallow.evidence.support).toBe(6)
    expect(shallow.evidence.acceptRate).toBeGreaterThan(0.6)
  })
})

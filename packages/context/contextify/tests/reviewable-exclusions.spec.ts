/** Restoration eligibility follows explicit reviewed native choices, never model inference. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { reviewableRecommendationExclusions } from '../src/reviewable-exclusions.ts'

describe('reviewed temporary exclusion restoration', () => {
  it('skips later unrelated edits without losing the latest accepted temporary exclusion', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const root = ctx.sessions.create(SessionId('reviewable-boundary'))
      const choice = { origin: 'recommendation' as const, changed: true, uiOrigin: 'contextify-client' as const,
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g', mutations: [{ nodeId: 'source', mode: 'exclude' as const }] }
      root.append('contextify/node-choice', choice)
      root.append('contextify/recommendation-reviewed', { mode: 'fast',
        base: { activeSessionId: root.id, planRevision: 1, graphRevision: 'g' },
        selection: [{ nodeId: 'source', action: 'exclude' }], acceptedNodeIds: ['source'], declinedNodeIds: [], uiOrigin: 'contextify-client' })
      root.append('contextify/node-choice', { ...choice, origin: 'direct', beforePlanRevision: 2, afterPlanRevision: 3,
        mutations: [{ nodeId: 'unrelated', mode: 'include' }] })
      expect(reviewableRecommendationExclusions(root.snapshotEvents(), ['source'], [])).toEqual(['source'])
      expect(reviewableRecommendationExclusions(root.snapshotEvents(), ['source'], ['source'])).toEqual([])
      root.append('contextify/node-choice', { ...choice, origin: 'direct', beforePlanRevision: 3, afterPlanRevision: 4 })
      expect(reviewableRecommendationExclusions(root.snapshotEvents(), ['source'], [])).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})

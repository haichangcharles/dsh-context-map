/** Public policy boundaries: confirmed native events, no models or private mocks. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ImageBlock } from '@deepseek-ai/dsh-llm'
import { lexicalTokens, jaccardOverlap } from '../src/lexical-tokens.ts'
import { draftRouteAdvice } from '../src/draft-route.ts'
import { buildContextRouteCandidates, planContextRoute, type ScoredContextRouteCandidate } from '../src/context-route-policy.ts'
import { branchFeedbackFromFamily, personalBranchSuggestionFromKeep, personalBranchSuppressionFromMove, type PersonalBranchFeedback } from '../src/personal-branch-policy.ts'
import { calibrateContextRecommendation, contextEditEvidenceFromFamily, contextPlanExamplesFromFamily, declinedContextActionsForObjective, personalContextStyleAdvice, type PersonalContextEdit } from '../src/personal-context-policy.ts'
import { contextPolicyObservationsFromFamily, deriveContextStewardProfile } from '../src/context-steward-profile.ts'
import type { ContextFamilyGraph, ContextFamilyInspection, ContextFamilyGraphNode } from '../src/types.ts'

const rootId = SessionId('policy-boundary-root')
const siblingId = SessionId('policy-boundary-sibling')
const node = (id: string, owner = rootId, preview = id): ContextFamilyGraphNode => ({
  id, owner: { sessionId: owner, seq: 0 }, role: 'user', sourceKind: 'chat', preview,
  time: 1, branchAtSeq: null, sessionIds: [owner], activeEventSeq: owner === rootId ? 0 : null,
})
const graph = (nodes: readonly ContextFamilyGraphNode[] = [node('old'), node('new')]): ContextFamilyGraph => ({
  rootSessionId: rootId, activeSessionId: rootId,
  sessions: [{ id: rootId, seedLength: 0, depth: 0, tipNodeId: null },
    { id: siblingId, parentSessionId: rootId, seedLength: 0, depth: 1, tipNodeId: null }], nodes, edges: [],
})
const inspect = (session: Session): ContextFamilyInspection => ({
  meta: session.header, events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount,
})
async function withStore(run: (root: Session, sibling: Session) => void): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  try { run(ctx.sessions.create(rootId), ctx.sessions.create(siblingId)) }
  finally { await ctx.fiber.dispose() }
}
const objective = (session: Session, text = 'Write the updated plan'): void => {
  session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'image', attachment: { attachmentId: 'policy-image' as ImageBlock['attachment']['attachmentId'],
      mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }, { type: 'text', text }] }), { surfaceOp: 'append' })
}
const selection = [{ nodeId: 'old', action: 'exclude' as const }, { nodeId: 'new', action: 'include' as const }]
function appendPlanExample(session: Session): void {
  session.append('contextify/node-choice', {
    origin: 'recommendation', changed: true, uiOrigin: 'contextify-client',
    beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g',
    mutations: [{ nodeId: 'old', mode: 'exclude' }, { nodeId: 'new', mode: 'include' }],
    proposal: { currentNodeIds: ['old'], proposedNodeIds: ['new'], selection },
  })
}
const inspected = (...sessions: Session[]) => new Map(sessions.map(session => [session.id, inspect(session)]))

describe('public policy boundary contracts', () => {
  it('keeps single CJK symbols useful and abstains on empty lexical content', () => {
    expect(lexicalTokens('山 A !')).toEqual(new Set(['山']))
    expect(jaccardOverlap('', 'camera')).toBe(0)
    expect(jaccardOverlap('camera', '!')).toBe(0)
  })

  it('abstains on an empty draft or an unavailable active Session', () => {
    const input = { graph: graph(), contents: {}, base: { planRevision: 1, graphRevision: 'g', activeSessionId: rootId },
      profile: deriveContextStewardProfile([], { branchDepth: 0 }) }
    expect(draftRouteAdvice({ ...input, objective: '   ' })).toBeUndefined()
    expect(draftRouteAdvice({ ...input, graph: { ...graph(), sessions: [] }, objective: 'New task: planning' })).toBeUndefined()
  })

  it('preserves explicit native destination choices and rejects a missing target', () => {
    const candidate: ScoredContextRouteCandidate = { sessionId: siblingId, depth: 1, label: 'Saved outline',
      ownedNodeIds: ['outline'], offPathNodeIds: ['outline'], lexicalScore: 0,
      destinationScore: 0, evidenceScore: 0, supersededScore: 0 }
    for (const intent of ['resume', 'return'] as const) {
      expect(planContextRoute({ intent, activeSessionId: rootId, explicitTargetSessionId: siblingId,
        candidates: [candidate] })).toMatchObject({ action: intent === 'resume' ? 'navigate' : 'return',
        targetSessionId: siblingId, needsReview: true })
    }
    expect(planContextRoute({ intent: 'unknown', activeSessionId: rootId,
      explicitTargetSessionId: siblingId, candidates: [candidate] }).action).toBe('continue')
    expect(planContextRoute({ intent: 'resume', activeSessionId: rootId,
      explicitTargetSessionId: SessionId('missing'), candidates: [candidate] }).action).toBe('continue')
    const candidates = buildContextRouteCandidates({ graph: graph([node('outline', siblingId)]),
      contents: { outline: 'Full saved outline' }, objective: 'saved outline' })
    expect(candidates[0]?.label).toBe('Full saved outline')
  })

  it('does not infer a branch persona from malformed confidence or insufficient similar Moves', () => {
    const query = { candidateInput: 'warranty region', branchDepth: 9 }
    const accepted: PersonalBranchFeedback = { candidateInput: query.candidateInput, branchDepth: 0,
      confidence: 0.8, choice: 'move', uiOrigin: 'contextify-client' }
    expect(personalBranchSuppressionFromMove(query, Number.NaN, [])).toBe(false)
    expect(personalBranchSuggestionFromKeep(query, Number.NaN, [])).toBeNull()
    expect(personalBranchSuggestionFromKeep(query, 0.49, [])).toBeNull()
    const invalid = [Number.NaN, -1, 2].map(confidence => ({ ...accepted, confidence }))
    expect(personalBranchSuggestionFromKeep(query, 0.55, invalid)).toBeNull()
    expect(personalBranchSuggestionFromKeep(query, 0.6, Array.from({ length: 4 }, () => accepted))).toBeNull()
    expect(personalBranchSuggestionFromKeep(query, 0.55, Array.from({ length: 4 }, () => accepted))?.reason)
      .toContain('similar earlier')
  })

  it('ignores orphaned Branch reviews and choices whose source is outside the available family', async () => withStore((root) => {
    root.append('contextify/branch-choice', { suggestionId: 'missing', turnEndSeq: 0, choice: 'keep', uiOrigin: 'contextify-client' })
    const suggestion = { id: 'outside', sourceSessionId: SessionId('unavailable'), turn: 1,
      boundaryBefore: 0, boundaryAfter: 0, input: { sessionId: root.id, seq: 0 }, output: { sessionId: root.id, seq: 0 },
      inputPreview: 'topic', outputPreview: 'answer', confidence: 0.8, reason: 'topic', planRevision: 1, graphRevision: 'g' }
    root.append('contextify/branch-review', { suggestion, turnEndSeq: 0 })
    root.append('contextify/branch-choice', { suggestionId: suggestion.id, turnEndSeq: 0, choice: 'move', uiOrigin: 'contextify-client' })
    expect(branchFeedbackFromFamily(graph(), inspected(root))).toEqual([])
  }))

  it('backs off for unknown graph features and rejects a mixed recent preference as a reversal', () => {
    const edits: PersonalContextEdit[] = Array.from({ length: 10 }, (_, index) => ({ objective: 'task', content: 'source',
      sourceKind: 'chat', onActiveBranch: true, mode: index === 9 ? 'include' : 'exclude' }))
    expect(personalContextStyleAdvice(edits, {})).toBeNull()
    expect(personalContextStyleAdvice(edits, { sourceKind: 'chat', onActiveBranch: true })?.mode).toBe('exclude')
  })

  it('keeps cold recommendations unchanged and ranks eligible lexical-fallback candidates', () => {
    const empty = { include: [], exclude: [], archive: [] }
    expect(calibrateContextRecommendation(empty, 'task', {}, [])).toBe(empty)
    const edits: PersonalContextEdit[] = Array.from({ length: 6 }, () => ({ objective: 'warranty region',
      content: 'regional repair', mode: 'include', onActiveBranch: false }))
    const candidates = ['first', 'second', 'missing-content'].map((id, index) => ({ id,
      reason: 'off-path-candidate', active: false, included: false,
      ...(index === 2 ? { lexicalScore: 0.4 } : {}) }))
    const result = calibrateContextRecommendation(empty, 'warranty region',
      { first: 'regional repair', second: 'regional repair' }, edits, candidates)
    expect(result.include.map(item => item.nodeId)).toEqual(['missing-content', 'first'])
  })

  it('does not learn a recommendation sheet whose accepted membership is contradictory', async () => withStore((root) => {
    root.append('contextify/recommendation-reviewed', { mode: 'fast', base: { activeSessionId: rootId, planRevision: 1, graphRevision: 'g' },
      objective: 'Write a plan', selection, acceptedNodeIds: ['old', 'new'], declinedNodeIds: ['old'], uiOrigin: 'contextify-client' })
    expect(contextEditEvidenceFromFamily(graph(), inspected(root))).toEqual([])
  }))

  it('skips direct edits with no authored objective, an unavailable node, or a blank node', async () => withStore((root) => {
    const append = (id: string, mode: 'include' | 'natural' = 'include'): void => { root.append('contextify/node-choice', { origin: 'direct', changed: true,
      beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g', mutations: [{ nodeId: id, mode }], uiOrigin: 'contextify-client' }) }
    append('old')
    objective(root)
    append('missing')
    append('missing', 'natural')
    append('blank')
    expect(contextEditEvidenceFromFamily(graph([node('old'), node('blank', rootId, '  ')]), inspected(root))).toEqual([])
  }))

  it('does not remember a complete plan with duplicate before/after membership', async () => withStore((root) => {
    objective(root)
    for (const currentNodeIds of [['old', 'old'], ['old']]) {
      root.append('contextify/node-choice', { origin: 'recommendation', changed: true,
        beforePlanRevision: 1, afterPlanRevision: 2, graphRevision: 'g', mutations: [{ nodeId: 'old', mode: 'exclude' }, { nodeId: 'new', mode: 'include' }],
        proposal: { currentNodeIds, proposedNodeIds: ['new', 'new'], selection }, uiOrigin: 'contextify-client' })
    }
    expect(contextPlanExamplesFromFamily(graph(), inspected(root))).toEqual([])
  }))

  it('rejects complete plan examples without objectives or with missing/blank source nodes', async () => withStore((root, sibling) => {
    appendPlanExample(root)
    expect(contextPlanExamplesFromFamily(graph(), inspected(root))).toEqual([])
    objective(root)
    appendPlanExample(root)
    objective(sibling)
    appendPlanExample(sibling)
    expect(contextPlanExamplesFromFamily(graph([node('old'), node('new', rootId, '')]), inspected(root, sibling))).toEqual([])
    expect(contextPlanExamplesFromFamily(graph([node('old')]), inspected(root, sibling))).toEqual([])
    expect(contextPlanExamplesFromFamily(graph(), inspected(root))).toMatchObject([{ objective: 'Write the updated plan' }])
  }))

  it('forgets an accepted complete plan after its state is explicitly undone', async () => withStore((root) => {
    objective(root)
    const plan = { kind: 'contextify/plan' as const, version: 3 as const, revision: 1, stateRevision: 1,
      history: { past: [] as number[], future: [] as number[] }, excluded: [], included: [], replacements: [] }
    root.append('contextify/plan', plan)
    root.append('contextify/plan', { ...plan, revision: 2, stateRevision: 2, history: { past: [1], future: [] } })
    appendPlanExample(root)
    root.append('contextify/recommendation-reviewed', { mode: 'fast',
      base: { activeSessionId: rootId, planRevision: 1, graphRevision: 'g' },
      objective: 'Write the updated plan', selection, acceptedNodeIds: ['old', 'new'], declinedNodeIds: [], uiOrigin: 'contextify-client' })
    expect(contextPlanExamplesFromFamily(graph(), inspected(root))).toHaveLength(1)
    root.append('contextify/plan', { ...plan, revision: 3, history: { past: [], future: [2] } })
    expect(contextPlanExamplesFromFamily(graph(), inspected(root))).toEqual([])
    expect(contextEditEvidenceFromFamily(graph(), inspected(root))).toEqual([])
    expect(contextPolicyObservationsFromFamily(graph(), inspected(root)).map(item => item.undone)).toEqual([true, true])
  }))

  it('orders simultaneous complete plan cases by Session and then native sequence', async () => withStore((root, sibling) => {
    objective(root, 'Root plan')
    appendPlanExample(root)
    appendPlanExample(root)
    objective(sibling, 'Sibling plan')
    appendPlanExample(sibling)
    const inspections = inspected(sibling, root)
    for (const [id, inspection] of inspections) inspections.set(id, { ...inspection,
      events: inspection.events.map(event => ({ ...event, time: 10 })) })
    expect(contextPlanExamplesFromFamily(graph(), inspections).map(item => item.objective))
      .toEqual(['Root plan', 'Root plan', 'Sibling plan'])
  }))

  it('does not use reviews from absent graph Sessions or invent activity for legacy manual branches', async () => withStore((root, sibling) => {
    root.append('contextify/branch-choice', { suggestionId: 'legacy', turnEndSeq: 0, choice: 'keep', uiOrigin: 'contextify-client' })
    root.append('contextify/node-choice', { origin: 'direct', changed: true, beforePlanRevision: 1, afterPlanRevision: 2,
      graphRevision: 'g', mutations: [{ nodeId: 'old', mode: 'natural' }], uiOrigin: 'contextify-client' })
    for (const text of [undefined, '   ']) root.append('contextify/manual-branch', {
      childSessionId: siblingId, uiOrigin: 'contextify-client',
      ...(text === undefined ? {} : { objective: text }) })
    const profileGraph = { ...graph(), sessions: graph().sessions.filter(session => session.id === rootId) }
    const observations = contextPolicyObservationsFromFamily(profileGraph, inspected(root, sibling))
    expect(observations).toHaveLength(4)
    expect(observations.every(item => item.activity === undefined && item.objective === undefined)).toBe(true)
    expect(observations.map(item => item.action)).toEqual(['branch', 'include', 'branch', 'branch'])
  }))

  it('retains an empty native branch as a destination candidate without inventing owned material', () => {
    expect(buildContextRouteCandidates({ graph: graph([]), contents: {}, objective: 'resume outline' }))
      .toEqual([{ sessionId: siblingId, parentSessionId: rootId, depth: 1, label: 'Branch at depth 1',
        ownedNodeIds: [], offPathNodeIds: [], lexicalScore: 0 }])
  })

  it('does not mistake a stable Include or Exclude preference for a five-event reversal', () => {
    for (const mode of ['include', 'exclude'] as const) {
      const edits: PersonalContextEdit[] = Array.from({ length: 10 }, () => ({ objective: 'task', content: 'source',
        sourceKind: 'chat', onActiveBranch: true, mode }))
      expect(personalContextStyleAdvice(edits, { sourceKind: 'chat', onActiveBranch: true }))
        .toMatchObject({ mode, support: 10 })
    }
  })

  it('ignores no-op direct choices and empty reviewed batches as style evidence', async () => withStore((root) => {
    objective(root)
    root.append('contextify/node-choice', { origin: 'direct', changed: false,
      beforePlanRevision: 1, afterPlanRevision: 1, graphRevision: 'g', mutations: [{ nodeId: 'old', mode: 'include' }], uiOrigin: 'contextify-client' })
    root.append('contextify/node-choice', { origin: 'recommendation', changed: false,
      beforePlanRevision: 1, afterPlanRevision: 1, graphRevision: 'g', mutations: [],
      proposal: { currentNodeIds: [], proposedNodeIds: [], selection: [] }, uiOrigin: 'contextify-client' })
    expect(contextEditEvidenceFromFamily(graph(), inspected(root))).toEqual([])
    expect(declinedContextActionsForObjective(undefined, 'task').size).toBe(0)
  }))

  it('retains source-bound Web action metadata in an accepted complete plan', async () => withStore((root) => {
    objective(root)
    appendPlanExample(root)
    const webNodes = [node('old'), node('new')].map(item => ({ ...item, role: 'tool' as const,
      sourceKind: 'web' as const, webAction: 'web_fetch' as const }))
    const examples = contextPlanExamplesFromFamily(graph(webNodes), inspected(root))
    expect(examples[0]?.choices.map(choice => ({ sourceKind: choice.sourceKind, webAction: choice.webAction })))
      .toEqual([{ sourceKind: 'web', webAction: 'web_fetch' }, { sourceKind: 'web', webAction: 'web_fetch' }])
  }))

  it('requires retrieval support for a Web Include and does not import absent chat content', () => {
    const empty = { include: [], exclude: [], archive: [] }
    const common = { id: 'source', reason: 'off-path-candidate', active: false, included: false }
    const webEdits: PersonalContextEdit[] = Array.from({ length: 6 }, () => ({ objective: 'warranty region',
      content: 'regional repair', mode: 'include', onActiveBranch: false, sourceKind: 'web', webAction: 'web_fetch' }))
    expect(calibrateContextRecommendation(empty, 'warranty region', { source: 'regional repair' }, webEdits,
      [{ ...common, sourceKind: 'web', webAction: 'web_fetch' }])).toEqual(empty)
    const chatEdits = webEdits.map(({ sourceKind: _source, webAction: _action, ...edit }) => edit)
    expect(calibrateContextRecommendation(empty, 'warranty region', {}, chatEdits, [common])).toEqual(empty)
  })

  it('recovers branch task activity from the authored multimodal turn and keeps lifecycle reviews explicit', async () => withStore((root) => {
    objective(root)
    root.append('contextify/branch-choice', { suggestionId: 'review', turnEndSeq: 1, choice: 'move', uiOrigin: 'contextify-client' })
    for (const state of ['open', 'parked', 'completed'] as const) root.append('contextify/work-state-choice', {
      targetSessionId: siblingId, state, choice: 'reject', objective: 'Write an outline',
      base: { activeSessionId: rootId, graphRevision: 'g', planRevision: 1 }, uiOrigin: 'contextify-client' })
    const observations = contextPolicyObservationsFromFamily(graph(), inspected(root))
    expect(observations.map(item => item.action)).toEqual(['branch', 'reopen', 'park', 'complete'])
    expect(observations.map(item => item.choice)).toEqual(['accept', 'reject', 'reject', 'reject'])
    expect(observations.every(item => item.activity === 'writing')).toBe(true)
    expect(graph().sessions.every(session => session.workState === undefined)).toBe(true)
  }))
})

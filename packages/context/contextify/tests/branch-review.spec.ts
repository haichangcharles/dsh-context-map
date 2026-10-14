import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import {
  BRANCH_MAX_TEXT_CHARS,
  BRANCH_RECENT_TURNS,
  BRANCH_REVIEW_MAX_TOKENS,
  BRANCH_SIBLING_INTENTS,
  branchSuggestionThreshold,
  buildBranchReviewInput,
  branchRelocationKey,
  completedTurnCandidate,
  parseBranchDecisionText,
  validateBranchDecision,
} from '../src/branch-review.ts'
import type { ContextFamilyGraph } from '../src/types.ts'

describe('post-Turn Branch review', () => {
  it('builds a bounded topology-aware packet without serializing the full tree', () => {
    const root = SessionId('root')
    const parent = SessionId('parent')
    const active = SessionId('active')
    const sibling = SessionId('sibling')
    const graph: ContextFamilyGraph = {
      rootSessionId: root,
      activeSessionId: active,
      sessions: [
        { id: root, seedLength: 0, depth: 0, tipNodeId: 'root:2' },
        { id: parent, parentSessionId: root, seedLength: 3, depth: 1, tipNodeId: 'parent:4' },
        { id: active, parentSessionId: parent, seedLength: 5, depth: 2, tipNodeId: 'active:9' },
        { id: sibling, parentSessionId: parent, seedLength: 5, depth: 2, tipNodeId: 'sibling:7' },
      ],
      nodes: [
        { id: 'root:1', owner: { sessionId: root, seq: 1 }, role: 'user', preview: 'root product goal', time: 1, branchAtSeq: 2, sessionIds: [root, parent, active, sibling], activeEventSeq: 1 },
        { id: 'root:2', owner: { sessionId: root, seq: 2 }, role: 'assistant', preview: 'root answer', time: 2, branchAtSeq: 2, sessionIds: [root, parent, active, sibling], activeEventSeq: 2 },
        { id: 'parent:3', owner: { sessionId: parent, seq: 3 }, role: 'user', preview: 'parent architecture goal', time: 3, branchAtSeq: 4, sessionIds: [parent, active, sibling], activeEventSeq: 3 },
        { id: 'parent:4', owner: { sessionId: parent, seq: 4 }, role: 'assistant', preview: 'parent answer', time: 4, branchAtSeq: 4, sessionIds: [parent, active, sibling], activeEventSeq: 4 },
        { id: 'active:5', owner: { sessionId: active, seq: 5 }, role: 'user', preview: 'local observability design', time: 5, branchAtSeq: 6, sessionIds: [active], activeEventSeq: 5 },
        { id: 'active:6', owner: { sessionId: active, seq: 6 }, role: 'assistant', preview: 'local answer', time: 6, branchAtSeq: 6, sessionIds: [active], activeEventSeq: 6 },
        { id: 'active:9', owner: { sessionId: active, seq: 9 }, role: 'user', preview: 'weather in Shanghai', time: 9, branchAtSeq: null, sessionIds: [active], activeEventSeq: 9 },
        { id: 'sibling:7', owner: { sessionId: sibling, seq: 7 }, role: 'user', preview: 'sibling tracing approach', time: 7, branchAtSeq: null, sessionIds: [sibling], activeEventSeq: null },
      ],
      edges: [],
    }

    const input = buildBranchReviewInput({ graph, candidateNodeId: 'active:9' })

    expect(input.candidateInput).toBe('weather in Shanghai')
    expect(input.currentObjective).toBe('local observability design')
    expect(input.ancestorObjectives).toEqual(['root product goal', 'parent architecture goal'])
    expect(input.recentTurns).toEqual([{ input: 'local observability design', output: 'local answer' }])
    expect(input.branchDepth).toBe(2)
    expect(input.activeBranchCount).toBe(2)
    expect(input.siblingIntents).toEqual(['sibling tracing approach'])
    expect(input.recentTurns.length).toBeLessThanOrEqual(BRANCH_RECENT_TURNS)
    expect(input.siblingIntents.length).toBeLessThanOrEqual(BRANCH_SIBLING_INTENTS)
    expect(JSON.stringify(input).length).toBeLessThan(5_000)
    expect(BRANCH_MAX_TEXT_CHARS).toBe(800)
    expect(BRANCH_REVIEW_MAX_TOKENS).toBe(200)
    expect(branchSuggestionThreshold(2, 2)).toBeCloseTo(0.88)
  })

  it('extracts only the first human input and final completed assistant output', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('branch-review'))
    session.append('contextify/plan', { kind: 'contextify/plan', version: 3, revision: 1, stateRevision: 1, history: { past: [], future: [] }, excluded: [], included: [], replacements: [] })
    session.append('turn/start', { turn: 4 })
    const input = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'side topic' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', { stream: [], turn: 4, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'intermediate' }], source: { provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
    const output = session.append('assistant/message', { stream: [], turn: 4, step: 2, message: createAssistantMessage({ content: [{ type: 'text', text: 'final answer' }], source: { provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

    expect(completedTurnCandidate(session.snapshotEvents(), end.seq, session.id)).toMatchObject({
      turn: 4,
      boundaryBefore: 0,
      boundaryAfter: end.seq,
      input: { seq: input.seq },
      output: { seq: output.seq },
      inputPreview: 'side topic',
      outputPreview: 'final answer',
    })
  })

  it('validates one decision and derives a stable relocation key', () => {
    expect(validateBranchDecision({ action: 'suggest_branch', confidence: 0.88, reason: ' Parallel topic ' }))
      .toEqual({ action: 'suggest_branch', confidence: 0.88, reason: 'Parallel topic' })
    expect(branchRelocationKey(SessionId('source'), 8)).toBe(branchRelocationKey(SessionId('source'), 8))
    expect(parseBranchDecisionText('```json\n{"action":"keep","confidence":0.9,"reason":"same topic"}\n```'))
      .toEqual({ action: 'keep', confidence: 0.9, reason: 'same topic' })
    expect(() => validateBranchDecision({ action: 'suggest_branch', confidence: 2, reason: 'bad' })).toThrow(/confidence/)
  })
  it('abstains on incomplete boundaries and turns without a visible output', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('incomplete-review'))
      expect(completedTurnCandidate([], 0, session.id)).toBeNull()
      const orphan = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(completedTurnCandidate(session.snapshotEvents(), orphan.seq, session.id)).toBeNull()
      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'question' }],
        source: { kind: 'user' } }), { surfaceOp: 'append' })
      const failed = session.append('turn/end', { turn: 2,
        reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } })
      expect(completedTurnCandidate(session.snapshotEvents(), failed.seq, session.id)).toBeNull()
      session.append('turn/start', { turn: 3 })
      const empty = session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
      expect(completedTurnCandidate(session.snapshotEvents(), empty.seq, session.id)).toBeNull()
    } finally { await ctx.fiber.dispose() }
  })

  it('retains visible images while omitting reasoning in relocation previews', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(SessionId('image-review'))
      session.append('turn/start', { turn: 1 })
      const attachment = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
        mediaType: 'image/png' as const, bytes: 4, width: 1, height: 1 }
      session.append('user/message', createUserMessage({ content: [{ type: 'image', attachment }],
        source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('assistant/message', { stream: [], turn: 1, step: 1,
        message: createAssistantMessage({ source: { provider: 'mock', model: 'mock' }, content: [
          { type: 'reasoning', text: 'private' }, { type: 'text', text: 'visible' },
          { type: 'image', attachment },
        ] }) }, { surfaceOp: 'append' })
      const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(completedTurnCandidate(session.snapshotEvents(), end.seq, session.id)).toMatchObject({
        inputPreview: '[Image]', outputPreview: 'visible\n[Image]',
      })
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    [null, /object/], [[], /object/], [{ action: 'navigate', confidence: 1, reason: 'x' }, /action/],
    [{ action: 'keep', confidence: NaN, reason: 'x' }, /confidence/],
    [{ action: 'keep', confidence: 'high', reason: 'x' }, /confidence/],
    [{ action: 'keep', confidence: 0.5, reason: '' }, /reason/],
    [{ action: 'keep', confidence: 0.5, reason: 1 }, /reason/],
    [{ action: 'keep', confidence: 0.5, reason: 'x'.repeat(501) }, /reason/],
  ])('rejects a malformed branch decision %j', (value, error) => {
    expect(() => validateBranchDecision(value)).toThrow(error)
  })

  it('rejects prose without a branch decision JSON object', () => {
    expect(() => parseBranchDecisionText('keep this topic')).toThrow(/JSON object/)
  })

  it('handles a partial family and inherited objective without inventing sibling goals', () => {
    const active = SessionId('partial-active')
    const missing = SessionId('missing-parent')
    const sibling = SessionId('empty-sibling')
    const graph: ContextFamilyGraph = { rootSessionId: missing, activeSessionId: active,
      sessions: [
        { id: active, parentSessionId: missing, seedLength: 2, depth: 1, tipNodeId: 'candidate' },
        { id: sibling, parentSessionId: missing, seedLength: 2, depth: 1, tipNodeId: null },
      ], nodes: [
        { id: 'inherited', owner: { sessionId: missing, seq: 1 }, role: 'user', preview: 'parent goal',
          time: 1, branchAtSeq: null, sessionIds: [active], activeEventSeq: null },
        { id: 'unanswered', owner: { sessionId: active, seq: 2 }, role: 'user', preview: 'unfinished goal',
          time: 2, branchAtSeq: null, sessionIds: [active], activeEventSeq: null },
        { id: 'candidate', owner: { sessionId: active, seq: 3 }, role: 'user', preview: 'new request',
          time: 3, branchAtSeq: null, sessionIds: [active], activeEventSeq: null },
      ], edges: [] }
    const input = buildBranchReviewInput({ graph, candidateNodeId: 'candidate', contents: {
      unanswered: 'exact unfinished goal', candidate: 'exact new request',
    } })
    expect(input.currentObjective).toBe('exact unfinished goal')
    expect(input.candidateInput).toBe('exact new request')
    expect(input.recentTurns).toEqual([])
    expect(input.siblingIntents).toEqual([])
    expect(() => buildBranchReviewInput({ graph, candidateNodeId: 'absent' })).toThrow(/candidate/)
    expect(() => buildBranchReviewInput({ graph: { ...graph, sessions: [] },
      candidateNodeId: 'candidate' })).toThrow(/active Branch/)
    const first = buildBranchReviewInput({ graph: { ...graph, nodes: [graph.nodes[2]!] },
      candidateNodeId: 'candidate' })
    expect(first.currentObjective).toBe('')
    const inherited = buildBranchReviewInput({ graph: { ...graph,
      nodes: [graph.nodes[0]!, graph.nodes[2]!] }, candidateNodeId: 'candidate' })
    expect(inherited.currentObjective).toBe('parent goal')
    const typedGraph = { ...graph, nodes: graph.nodes.map(item => ({ ...item, sourceKind: 'chat' as const })) }
    expect(buildBranchReviewInput({ graph: typedGraph, candidateNodeId: 'candidate' }).currentObjective)
      .toBe('unfinished goal')
    const workerGraph = { ...typedGraph, nodes: typedGraph.nodes.map(item => item.id === 'unanswered'
      ? { ...item, sourceKind: 'worker' as const } : item) }
    expect(buildBranchReviewInput({ graph: workerGraph, candidateNodeId: 'candidate' }).currentObjective)
      .toBe('parent goal')
    expect(() => buildBranchReviewInput({ graph: { ...typedGraph, nodes: typedGraph.nodes.map(item =>
      item.id === 'candidate' ? { ...item, sourceKind: 'worker' as const } : item) },
    candidateNodeId: 'candidate' })).toThrow(/candidate/)
  })
})

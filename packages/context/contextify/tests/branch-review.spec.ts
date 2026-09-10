import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
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
})

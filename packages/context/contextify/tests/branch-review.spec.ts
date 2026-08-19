import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { Context } from '@deepseek-ai/cordis'
import {
  branchRelocationKey,
  completedTurnCandidate,
  parseBranchDecisionText,
  validateBranchDecision,
} from '../src/branch-review.ts'

describe('post-Turn Branch review', () => {
  it('extracts only the first human input and final completed assistant output', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('branch-review'))
    session.append('contextify/plan', { kind: 'contextify/plan', version: 3, revision: 1, stateRevision: 1, history: { past: [], future: [] }, excluded: [], included: [], replacements: [] })
    session.append('turn/start', { turn: 4 })
    const input = session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'side topic' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 4, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'intermediate' }], source: { provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
    const output = session.append('assistant/message', { turn: 4, step: 2, message: createAssistantMessage({ content: [{ type: 'text', text: 'final answer' }], source: { provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

    expect(completedTurnCandidate(session.events, end.seq, session.id)).toMatchObject({
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

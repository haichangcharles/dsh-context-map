import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  ContextPathId,
  apply,
  compileContextify,
  createInitialContextPlan,
  type ContextPlanSnapshot,
} from '../src/index.ts'

function text(message: ReturnType<Session['deriveMessages']>[number]): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

function appendUser(session: Session, value: string): number {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: value }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function appendAssistant(session: Session, turn: number, value: string): number {
  return session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: value }],
      source: { provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' }).seq
}

describe('Contextify compiler', () => {
  it('models a lightweight branch inside one Session and protects the current turn', () => {
    const session = Session.create(SessionId('contextify-branch-mock'))
    const root = ContextPathId('root')
    session.append('contextify/plan', createInitialContextPlan())

    session.append('turn/start', { turn: 1 })
    session.append('contextify/route', {
      kind: 'contextify/route', version: 1, turn: 1, pathId: root, parentSeq: null, planRevision: 1,
    })
    session.append('step/start', { turn: 1, step: 1 })
    const requirementSeq = appendUser(session, 'root requirement')
    const draftSeq = appendAssistant(session, 1, 'assistant draft to leave behind')
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const branch = ContextPathId('branch-1')
    const branchedPlan: ContextPlanSnapshot = {
      kind: 'contextify/plan', version: 1, revision: 2,
      mainlinePathId: root,
      activePathId: branch,
      paths: [
        { id: root, parentPathId: null, anchorSeq: null, label: 'Main', status: 'active' },
        { id: branch, parentPathId: root, anchorSeq: requirementSeq, label: 'Alternative', status: 'active' },
      ],
      overrides: [],
    }
    session.append('contextify/plan', branchedPlan)
    session.append('turn/start', { turn: 2 })
    session.append('contextify/route', {
      kind: 'contextify/route', version: 1, turn: 2, pathId: branch,
      parentSeq: requirementSeq, planRevision: 2,
    })
    session.append('step/start', { turn: 2, step: 1 })
    const branchPromptSeq = appendUser(session, 'branch follow-up')

    expect(compileContextify({ session, turn: 2, step: 1 }).eventSeqs).toEqual([
      requirementSeq,
      branchPromptSeq,
    ])
    expect(compileContextify({ session, turn: 2, step: 1 }).messages.map(text)).toEqual([
      'root requirement',
      'branch follow-up',
    ])

    session.append('contextify/plan', {
      ...branchedPlan,
      revision: 3,
      overrides: [
        { seq: draftSeq, mode: 'include' },
        { seq: branchPromptSeq, mode: 'exclude' },
      ],
    })
    expect(compileContextify({ session, turn: 2, step: 1 }).eventSeqs).toEqual([
      requirementSeq,
      draftSeq,
      branchPromptSeq,
    ])
  })

  it('keeps the root-only default equivalent to the Harness surface', () => {
    const session = Session.create(SessionId('contextify-root-compatibility'))
    session.append('contextify/plan', createInitialContextPlan())
    appendUser(session, 'one')
    appendUser(session, 'two')

    expect(compileContextify({ session, turn: 1, step: 1 }).messages)
      .toEqual(session.deriveMessages())
  })

  it('registers as the real Harness compiler provider', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextCompilerRegistry)
    apply(ctx)
    const session = Session.create(SessionId('contextify-provider'))
    session.append('contextify/plan', createInitialContextPlan())
    appendUser(session, 'compiled by registry')

    ctx.contextCompiler.select(session, 'contextify')
    expect(ctx.contextCompiler.compile({ session, turn: 1, step: 1 })).toMatchObject({
      id: 'contextify',
      version: 1,
      eventSeqs: [1],
    })
  })
})

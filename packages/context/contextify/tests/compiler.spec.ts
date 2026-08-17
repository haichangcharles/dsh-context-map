import { describe, expect, it } from 'vitest'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  compileContextify,
  createInitialContextPlan,
  nextPlan,
  redoPlan,
  resetPlan,
  undoPlan,
} from '../src/plan.ts'

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

describe('native Contextify plan compiler', () => {
  it('keeps the Natural default equivalent to the Harness surface', () => {
    const session = Session.create(SessionId('contextify-natural'))
    session.append('contextify/plan', createInitialContextPlan())
    appendUser(session, 'one')
    appendUser(session, 'two')

    expect(compileContextify({ session, turn: 1, step: 1 }).messages)
      .toEqual(session.deriveMessages())
  })

  it('excludes Natural history, inserts a sibling snapshot, and protects the current turn', () => {
    const session = Session.create(SessionId('contextify-native-selection'))
    const initial = createInitialContextPlan()
    session.append('contextify/plan', initial)
    session.append('turn/start', { turn: 1 })
    const requirementSeq = appendUser(session, 'root requirement')
    const obsoleteSeq = appendAssistant(session, 1, 'obsolete answer')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const currentSeq = appendUser(session, 'current question')
    const snapshot = session.append('context/compiler-snapshot', {
      id: 'sibling:8',
      message: createUserMessage({
        content: [{ type: 'text', text: 'sibling discovery' }],
        source: { kind: 'runtime-context', provenance: 'contextify:sibling:8' },
      }),
    })
    session.append('contextify/plan', nextPlan(initial, {
      excluded: [
        { nodeId: 'root:2', eventSeq: obsoleteSeq },
        { nodeId: 'active:5', eventSeq: currentSeq },
      ],
      included: [{ nodeId: 'sibling:8', snapshotSeq: snapshot.seq, position: 1 }],
    }))

    const compilation = compileContextify({ session, turn: 2, step: 1 })
    expect(compilation.eventSeqs).toEqual([requirementSeq, snapshot.seq, currentSeq])
    expect(compilation.messages.map(text)).toEqual([
      'root requirement',
      'sibling discovery',
      'current question',
    ])
  })

  it('appends immutable Reset, Undo, and Redo revisions without rewriting state history', () => {
    const session = Session.create(SessionId('contextify-history'))
    const initial = createInitialContextPlan()
    session.append('contextify/plan', initial)
    const excluded = nextPlan(initial, {
      excluded: [{ nodeId: 'root:1', eventSeq: 1 }],
      included: [],
    })
    session.append('contextify/plan', excluded)
    const included = nextPlan(excluded, {
      excluded: excluded.excluded,
      included: [{ nodeId: 'sibling:4', snapshotSeq: 9, position: 1 }],
    })
    session.append('contextify/plan', included)

    const undone = undoPlan(session, included)
    expect(undone).toMatchObject({
      revision: 4,
      stateRevision: excluded.stateRevision,
      excluded: excluded.excluded,
      included: [],
      history: { future: [included.stateRevision] },
    })
    session.append('contextify/plan', undone!)
    const redone = redoPlan(session, undone!)
    expect(redone).toMatchObject({
      revision: 5,
      stateRevision: included.stateRevision,
      included: included.included,
      history: { future: [] },
    })
    session.append('contextify/plan', redone!)
    expect(resetPlan(redone!)).toMatchObject({
      revision: 6,
      excluded: [],
      included: [],
    })
    expect(initial).toMatchObject({ revision: 1, excluded: [], included: [] })
  })

  it('keeps a multi-call tool exchange closed when one member is excluded', () => {
    const session = Session.create(SessionId('contextify-tool-closure'))
    const initial = createInitialContextPlan()
    session.append('contextify/plan', initial)
    session.append('turn/start', { turn: 1 })
    const promptSeq = appendUser(session, 'inspect both files')
    const first = CallId('call-first')
    const second = CallId('call-second')
    const assistantSeq = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [
          { type: 'tool-call', id: first, name: 'read', arguments: '{"path":"a"}' },
          { type: 'tool-call', id: second, name: 'read', arguments: '{"path":"b"}' },
        ],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' }).seq
    const firstResultSeq = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: first,
        content: [{ type: 'text', text: 'a' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq
    const secondResultSeq = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: second,
        content: [{ type: 'text', text: 'b' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' }).seq
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('contextify/plan', nextPlan(initial, {
      excluded: [{ nodeId: 'root:result', eventSeq: firstResultSeq }],
      included: [],
    }))

    expect(compileContextify({ session, turn: 2, step: 1 }).eventSeqs).toEqual([promptSeq])
    expect([assistantSeq, firstResultSeq, secondResultSeq]).not.toContain(promptSeq)
  })
})

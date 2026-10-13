/** Corrupt persisted state, checkpoint expansion and deterministic insertion contracts. */
import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ContextPlanState, ContextReplacementNode } from '../src/types.ts'
import {
  compileContextify, contextPlanFeedbackStates, createInitialContextPlan, isContextPlanSnapshot,
  nextPlan, normalizeContextPlanSnapshot, redoPlan, undoPlan,
} from '../src/plan.ts'

const empty: ContextPlanState = { excluded: [], included: [], replacements: [] }
const placeholder: ContextReplacementNode = {
  nodeId: 'source', snapshotSeq: 1, originalEventSeq: 0, role: 'user', kind: 'placeholder', reason: 'obsolete',
}
const user = (text: string) => createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' } })
const session = () => Session.create(SessionId('plan-validation'))
const compile = (value: Session) => compileContextify({ session: value, turn: -1, step: -1 })

/** Store untrusted Plan-shaped persisted data without invoking the mutation validator. */
function store(value: Session, patch: Partial<ContextPlanState>): void {
  value.append('contextify/plan', { ...createInitialContextPlan(), ...patch })
}

describe('Plan input validation and durable history', () => {
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe initial revision %s', (revision) => {
    expect(() => createInitialContextPlan(revision)).toThrow(/positive safe integer/)
  })
  it('rejects increment overflow instead of publishing an unsafe revision', () => {
    expect(() => nextPlan(createInitialContextPlan(Number.MAX_SAFE_INTEGER), empty)).toThrow(/positive safe integer/)
  })
  it.each<ContextPlanState>([
    { ...empty, excluded: [{ nodeId: '', eventSeq: 0 }] },
    { ...empty, excluded: [{ nodeId: 'same', eventSeq: 0 }, { nodeId: 'same', eventSeq: 1 }] },
    { ...empty, excluded: [{ nodeId: 'x', eventSeq: -1 }] },
    { ...empty, excluded: [{ nodeId: 'x', eventSeq: 0.5 }] },
    { ...empty, excluded: [{ nodeId: 'x', eventSeq: 0 }, { nodeId: 'y', eventSeq: 0 }] },
    { ...empty, included: [{ nodeId: '', snapshotSeq: 0, position: 0 }] },
    { ...empty, excluded: [{ nodeId: 'same', eventSeq: 0 }], included: [{ nodeId: 'same', snapshotSeq: 1, position: 0 }] },
    { ...empty, included: [{ nodeId: 'x', snapshotSeq: -1, position: 0 }] },
    { ...empty, included: [{ nodeId: 'x', snapshotSeq: 0, position: -1 }] },
    { ...empty, replacements: [{ ...placeholder, nodeId: '' }] },
    { ...empty, replacements: [placeholder, { ...placeholder, snapshotSeq: 2 }] },
    { ...empty, replacements: [{ ...placeholder, snapshotSeq: -1 }] },
    { ...empty, replacements: [placeholder, { ...placeholder, nodeId: 'other' }] },
    { ...empty, replacements: [{ ...placeholder, originalEventSeq: -1 }] },
    { ...empty, replacements: [{ ...placeholder, reason: '  ' }] },
  ])('rejects invalid overlay metadata before creating a revision %#', (state) => {
    expect(() => nextPlan(createInitialContextPlan(), state)).toThrow(/Contextify/)
  })
  it('rejects unsupported and malformed persistence while normalizing v2 without mutation', () => {
    const initial = createInitialContextPlan()
    const malformed: unknown[] = [null, [], {}, { ...initial, version: 1 }, { ...initial, revision: 0 },
      { ...initial, stateRevision: 0 }, { ...initial, history: null }, { ...initial, history: { past: [0], future: [] } },
      { ...initial, history: { past: [], future: [-1] } }, { ...initial, excluded: [{ nodeId: 'x', eventSeq: -1 }] },
      { ...initial, included: [{ nodeId: 'x', snapshotSeq: -1, position: 0 }] },
      { ...initial, included: [{ nodeId: 'x', snapshotSeq: 0, position: -1 }] },
      { ...initial, replacements: [{ ...placeholder, role: 'tool' }] },
      { ...initial, replacements: [{ ...placeholder, kind: 'excerpt', start: 1, end: 1 }] },
      { ...initial, replacements: [{ ...placeholder, kind: 'excerpt', start: 0, end: 1, originalEventSeq: null }] }]
    for (const value of malformed) {
      expect(isContextPlanSnapshot(value)).toBe(false)
      expect(normalizeContextPlanSnapshot(value)).toBeNull()
    }
    expect(normalizeContextPlanSnapshot({ ...initial, version: 2, replacements: undefined })).toEqual(initial)
  })
  it('marks an undone choice as inactive feedback and reactivates it after Redo', () => {
    const value = session()
    value.append('user/message', user('source'), { surfaceOp: 'append' })
    const initial = createInitialContextPlan()
    value.append('contextify/plan', initial)
    const changed = nextPlan(initial, { ...empty, excluded: [{ nodeId: 'source', eventSeq: 0 }] })
    value.append('contextify/plan', changed)
    const undone = undoPlan(value, changed)!
    value.append('contextify/plan', undone)
    expect(contextPlanFeedbackStates(value.snapshotEvents()).undoneStates.has(changed.stateRevision)).toBe(true)
    value.append('contextify/plan', redoPlan(value, undone)!)
    expect(contextPlanFeedbackStates(value.snapshotEvents()).undoneStates.size).toBe(0)
  })
  it('returns null at empty Undo/Redo boundaries and rejects missing or corrupt history', () => {
    const value = session()
    const initial = createInitialContextPlan()
    expect(undoPlan(value, initial)).toBeNull()
    expect(redoPlan(value, initial)).toBeNull()
    const dangling = { ...initial, history: { past: [9], future: [9] } }
    expect(() => undoPlan(value, dangling)).toThrow(/unavailable/)
    expect(() => redoPlan(value, dangling)).toThrow(/unavailable/)
    value.append('contextify/plan', { ...initial, excluded: [{ nodeId: 'bad', eventSeq: -1 }] })
    expect(() => undoPlan(value, { ...initial, history: { past: [1], future: [] } })).toThrow(/invalid/)
    expect(contextPlanFeedbackStates(value.snapshotEvents()).stateByPlanRevision.size).toBe(0)
  })
})

describe('compiler evidence closure and snapshot integrity', () => {
  it('rejects self, future and duplicate provenance before a checkpoint can enter the native log', () => {
    const value = session()
    const source = value.append('user/message', user('evidence'), { surfaceOp: 'append' }).seq
    const before = value.snapshotEvents()
    const checkpoint = createUserMessage({ content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'compact' } })
    for (const sourceEventSeqs of [[SessionSeq(value.seq)], [SessionSeq(value.seq + 10)], [source, source]]) {
      expect(() => value.append('user/message', checkpoint, { surfaceOp: 'append', sourceEventSeqs }))
        .toThrow(/earlier events|duplicates/)
      expect(value.snapshotEvents()).toEqual(before)
    }
  })

  it('retains pending calls and protects a current-turn tool exchange from a historical exclusion', () => {
    const value = session()
    value.append('turn/start', { turn: 1 })
    const callId = ToolCallId('pending-exchange')
    const call = value.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' }).seq
    expect(compile(value).eventSeqs).toEqual([call])
    const result = value.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'result' }], isError: false }),
    }, { surfaceOp: 'append' }).seq
    store(value, { excluded: [{ nodeId: 'result', eventSeq: result }] })
    expect(compileContextify({ session: value, turn: 1, step: 1 }).eventSeqs).toEqual([call, result])
    expect(compile(value).eventSeqs).toEqual([])
  })
  it.each(['source', 'snapshot'] as const)('rejects excerpts with multimodal %s content', (multimodal) => {
    const value = session()
    const image: ImageBlock = { type: 'image', attachment: { attachmentId: AttachmentId('plan-coverage-image'),
      mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }
    const original = value.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: 'abc' }, ...(multimodal === 'source' ? [image] : [])],
    }), { surfaceOp: 'append' }).seq
    const snapshot = value.append('context/compiler-snapshot', { id: 'excerpt',
      message: createUserMessage({ source: { kind: 'plugin', plugin: 'contextify' },
        content: [{ type: 'text', text: 'a' }, ...(multimodal === 'snapshot' ? [image] : [])],
      }),
    }).seq
    store(value, { replacements: [{ nodeId: 'excerpt', snapshotSeq: snapshot, originalEventSeq: original,
      role: 'user', kind: 'excerpt', start: 0, end: 1, reason: 'focus' }] })
    expect(() => compile(value)).toThrow(/does not match its source/)
  })

  it('expands nested compaction checkpoints after an explicit exclusion, deduplicating shared sources', () => {
    const value = session()
    const first = value.append('user/message', user('retained source'), { surfaceOp: 'append' }).seq
    const obsolete = value.append('user/message', user('obsolete source'), { surfaceOp: 'append' }).seq
    const metadata = value.append('contextify/plan', createInitialContextPlan()).seq
    const checkpoint = value.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'compact' } }), {
      surfaceOp: { op: 'replace', startSeq: first, endSeq: obsolete }, sourceEventSeqs: [first, obsolete, metadata],
    }).seq
    value.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'nested summary' }],
      source: { kind: 'plugin', plugin: 'compact' } }), {
      surfaceOp: { op: 'replace', startSeq: checkpoint, endSeq: checkpoint }, sourceEventSeqs: [first, checkpoint],
    })
    store(value, { excluded: [{ nodeId: 'obsolete', eventSeq: obsolete }] })
    expect(compile(value).eventSeqs).toEqual([first])
    store(value, { excluded: [{ nodeId: 'unrelated', eventSeq: metadata }] })
    expect(compile(value).messages[0]?.content).toEqual([{ type: 'text', text: 'nested summary' }])
  })
  it('inserts equal-position snapshots in sequence order and handles a system-only surface', () => {
    const value = session()
    value.append('system/message', { turn: 1, step: 1, message: createSystemMessage('rules', 'system-prompt') }, { surfaceOp: 'append' })
    const first = value.append('context/compiler-snapshot', { id: 'first', message: user('first') }).seq
    const second = value.append('context/compiler-snapshot', { id: 'second', message: user('second') }).seq
    store(value, { included: [{ nodeId: 'second', snapshotSeq: second, position: 0 },
      { nodeId: 'first', snapshotSeq: first, position: 0 }] })
    expect(compile(value).messages.map(message => message.content)).toEqual([
      [{ type: 'text', text: 'rules' }], [{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }],
    ])
  })
  it('uses Unicode code-point excerpt bounds and rejects an exact but whitespace-only excerpt', () => {
    for (const [source, copied, start, end, accepted] of [
      ['a😀b', '😀', 1, 2, true], [' a', ' ', 0, 1, false],
    ] as const) {
      const value = session()
      const original = value.append('user/message', user(source), { surfaceOp: 'append' }).seq
      const snapshot = value.append('context/compiler-snapshot', { id: 'excerpt', message: user(copied) }).seq
      store(value, { replacements: [{ nodeId: 'excerpt', snapshotSeq: snapshot, originalEventSeq: original,
        role: 'user', kind: 'excerpt', start, end, reason: 'focus' }] })
      if (accepted) expect(compile(value).messages[0]?.content).toEqual([{ type: 'text', text: copied }])
      else expect(() => compile(value)).toThrow(/does not match its source/)
    }
  })
  it('rejects missing and duplicate imported snapshots instead of admitting forged context', () => {
    const value = session()
    store(value, { included: [{ nodeId: 'missing', snapshotSeq: 99, position: 0 }] })
    expect(() => compile(value)).toThrow(/included snapshot event.*unavailable/)
    const snapshot = value.append('context/compiler-snapshot', { id: 'same', message: user('copied') }).seq
    store(value, { included: [{ nodeId: 'a', snapshotSeq: snapshot, position: 0 },
      { nodeId: 'b', snapshotSeq: snapshot, position: 0 }] })
    expect(() => compile(value)).toThrow(/included snapshot is duplicated/)
  })
  it('rejects wrong-role originals and replacements, and shared replacement snapshots', () => {
    const value = session()
    const original = value.append('user/message', user('one'), { surfaceOp: 'append' }).seq
    const second = value.append('user/message', user('two'), { surfaceOp: 'append' }).seq
    const snapshot = value.append('context/compiler-snapshot', { id: 'user', message: user('placeholder') }).seq
    const base = { ...placeholder, snapshotSeq: snapshot, originalEventSeq: original }
    store(value, { replacements: [{ ...base, snapshotSeq: 99 }] })
    expect(() => compile(value)).toThrow(/replacement snapshot.*unavailable/)
    store(value, { replacements: [{ ...base, role: 'assistant' }] })
    expect(() => compile(value)).toThrow(/wrong role/)
    store(value, { replacements: [{ ...base, originalEventSeq: 99 }] })
    expect(() => compile(value)).toThrow(/replacement original.*unavailable/)
    const answer = value.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' }).seq
    store(value, { replacements: [{ ...base, originalEventSeq: answer }] })
    expect(() => compile(value)).toThrow(/replacement original.*wrong role/)
    store(value, { replacements: [base, { ...base, nodeId: 'two', originalEventSeq: second }] })
    expect(() => compile(value)).toThrow(/replacement snapshot is duplicated/)
  })
})

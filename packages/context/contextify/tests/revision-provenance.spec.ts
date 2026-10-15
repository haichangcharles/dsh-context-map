/** Explicit provenance must not re-admit an invalid model-derived ancestor. */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createInitialContextPlan, currentContextPlan, nextPlan } from '../src/plan.ts'
import { recordDelegationSlice, recordRequestReadSet, revisionLineageSelection } from '../src/revision-lineage.ts'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const selected = (value: Session) => revisionLineageSelection({ session: value, turn: -1, step: -1 }).eventSeqs
function fresh() {
  const value = Session.create(SessionId('revision-provenance'))
  value.append('contextify/plan', createInitialContextPlan())
  return value
}
function assistant(value: Session) {
  return value.append('assistant/message', { turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'text', text: 'derived green fact' }],
      source: { provider: 'fixture', model: 'fixed' } }),
  }, { surfaceOp: 'append' }).seq
}
function summary(value: Session, sources: number[]) {
  return value.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'derived summary' }],
    source: { kind: 'plugin', plugin: 'summary-fixture' } }),
  { surfaceOp: 'append', sourceEventSeqs: sources.map(SessionSeq) }).seq
}
function exclude(value: Session, seq: number) {
  value.append('contextify/plan', nextPlan(currentContextPlan(value), {
    excluded: [{ nodeId: 'withdrawn-source', eventSeq: seq }], included: [], replacements: [],
  }))
}

describe('transitive model provenance admission', () => {
  it('preserves a valid compacted answer while still checking its hidden dependencies', () => {
    const value = fresh()
    const source = value.append('user/message', user('independent evidence'), { surfaceOp: 'append' }).seq
    recordRequestReadSet(value, 1, 1, [])
    const answer = assistant(value)
    const checkpoint = value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'valid compacted answer' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: source, endSeq: answer }, sourceEventSeqs: [source, answer] }).seq
    expect(selected(value)).toEqual([checkpoint])
    exclude(value, source)
    expect(selected(value)).toEqual([])
  })

  it('revokes hidden ancestors when their compact checkpoint is itself excluded', () => {
    const value = fresh()
    const source = value.append('user/message', user('compacted source'), { surfaceOp: 'append' }).seq
    recordRequestReadSet(value, 1, 1, [])
    const answer = assistant(value)
    const checkpoint = value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compact answer' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: source, endSeq: answer }, sourceEventSeqs: [source, answer] }).seq
    const derived = summary(value, [answer])
    expect(selected(value)).toEqual([checkpoint, derived])
    exclude(value, checkpoint)
    expect(selected(value)).toEqual([])
  })

  it('does not authorize a tool result removed with its excluded call group', () => {
    const value = fresh()
    const source = value.append('user/message', user('independent source'), { surfaceOp: 'append' }).seq
    recordRequestReadSet(value, 1, 1, [])
    const callId = ToolCallId('withdrawn-tool-group')
    const answer = value.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name: 'fixture', arguments: '{}' }],
        source: { provider: 'fixture', model: 'fixed' } }),
    }, { surfaceOp: 'append' }).seq
    const call = value.append('tool/call', { turn: 1, step: 1, callId, name: 'fixture', arguments: '{}' }).seq
    const result = value.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'withdrawn observation' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call] }).seq
    const derived = summary(value, [result])
    expect(selected(value)).toEqual([source, answer, result, derived])
    exclude(value, answer)
    expect(selected(value)).toEqual([source])
  })

  it('retains nested active compaction but does not authorize through an excluded checkpoint', () => {
    const value = fresh()
    const source = value.append('user/message', user('compacted evidence'), { surfaceOp: 'append' }).seq
    recordRequestReadSet(value, 1, 1, [])
    const answer = assistant(value)
    const compact = (sources: ReturnType<typeof SessionSeq>[], start: ReturnType<typeof SessionSeq>, end: ReturnType<typeof SessionSeq>) =>
      value.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact' } }), {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end }, sourceEventSeqs: sources,
      }).seq
    const first = compact([source, answer], source, answer)
    const second = compact([source, first], first, first)
    const derived = summary(value, [answer])
    expect(selected(value)).toEqual([second, derived])
    exclude(value, first)
    expect(selected(value)).toEqual([])
  })

  it('checks recorded inputs of a failed assistant attempt referenced by a summary', () => {
    const value = fresh()
    const source = value.append('user/message', user('withdrawn evidence'), { surfaceOp: 'append' }).seq
    recordRequestReadSet(value, 1, 1, [])
    const attempt = value.append('assistant/attempt', { turn: 1, step: 1, stream: [] }).seq
    const derived = summary(value, [attempt])
    expect(selected(value)).toEqual([source, derived])
    exclude(value, source)
    expect(selected(value)).toEqual([])
  })

  it('does not let current-turn protection reauthorize an explicitly excluded checkpoint', () => {
    const value = fresh()
    value.append('turn/start', { turn: 1 })
    const source = value.append('user/message', user('hidden evidence'), { surfaceOp: 'append' }).seq
    const checkpoint = value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: source, endSeq: source }, sourceEventSeqs: [source] }).seq
    summary(value, [source])
    exclude(value, checkpoint)
    expect(revisionLineageSelection({ session: value, turn: 1, step: 2 }).eventSeqs).toEqual([])
  })

  it('does not let an invalid compact checkpoint authorize hidden sources', () => {
    const value = fresh()
    const source = value.append('user/message', user('hidden evidence'), { surfaceOp: 'append' }).seq
    const worker = value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'uncertified worker' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('uncertified') },
    }), { surfaceOp: 'append' }).seq
    value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'mixed checkpoint' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: source, endSeq: worker }, sourceEventSeqs: [source, worker] })
    summary(value, [source])
    expect(selected(value)).toEqual([])
  })

  it('retains an independent valid checkpoint when another authorization root fails', () => {
    const value = fresh()
    const good = value.append('user/message', user('valid evidence'), { surfaceOp: 'append' }).seq
    const checkpoint = value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'valid checkpoint' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: good, endSeq: good }, sourceEventSeqs: [good] }).seq
    const bad = value.append('user/message', user('hidden evidence'), { surfaceOp: 'append' }).seq
    const worker = value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'uncertified worker' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('uncertified') },
    }), { surfaceOp: 'append' }).seq
    value.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'invalid checkpoint' }], source: { kind: 'plugin', plugin: 'compact' },
    }), { surfaceOp: { op: 'replace', startSeq: bad, endSeq: worker }, sourceEventSeqs: [bad, worker] })
    const validSummary = summary(value, [good])
    summary(value, [bad])
    const independent = value.append('user/message', user('independent evidence'), { surfaceOp: 'append' }).seq
    expect(selected(value)).toEqual([checkpoint, validSummary, independent])
  })

  it('revokes a summary of an invalid answer and restores it with its source', () => {
    const value = fresh()
    const red = value.append('user/message', user('independent yellow fact'), { surfaceOp: 'append' }).seq
    const green = value.append('user/message', user('withdrawable green fact'), { surfaceOp: 'append' }).seq
    recordRequestReadSet(value, 1, 1, [])
    const answer = assistant(value)
    const first = summary(value, [answer])
    const second = summary(value, [first])
    expect(selected(value)).toEqual([red, green, answer, first, second])
    exclude(value, green)
    expect(selected(value)).toEqual([red])
    value.append('contextify/plan', nextPlan(currentContextPlan(value), { excluded: [], included: [], replacements: [] }))
    expect(selected(value)).toEqual([red, green, answer, first, second])
  })

  it('preserves transparent structural provenance whose event is not a visible message', () => {
    const value = fresh()
    const source = value.append('user/message', user('independent evidence'), { surfaceOp: 'append' }).seq
    const marker = value.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('structural-origin'),
      name: 'local_fixture', arguments: '{}' }).seq
    const derived = summary(value, [marker])
    expect(selected(value)).toEqual([source, derived])
    exclude(value, source)
    expect(selected(value)).toEqual([derived])
  })

  it('revokes a derived summary when its borrowed snapshot is released', () => {
    const value = fresh()
    const independent = value.append('user/message', user('independent fact'), { surfaceOp: 'append' }).seq
    const snapshot = value.append('context/compiler-snapshot', { id: 'borrowed-fact', message: user('imported green fact') }).seq
    const included = [{ nodeId: 'borrowed-fact', snapshotSeq: snapshot, position: 0 }]
    value.append('contextify/plan', nextPlan(currentContextPlan(value), { excluded: [], included, replacements: [] }))
    const derived = summary(value, [snapshot])
    expect(selected(value)).toEqual([snapshot, independent, derived])
    value.append('contextify/plan', nextPlan(currentContextPlan(value), { excluded: [], included: [], replacements: [] }))
    expect(selected(value)).toEqual([independent])
    value.append('contextify/plan', nextPlan(currentContextPlan(value), { excluded: [], included, replacements: [] }))
    expect(selected(value)).toEqual([snapshot, independent, derived])
  })

  it('rejects a mixed read-set and native-provenance cycle without recursion failure', () => {
    const value = fresh()
    const source = value.append('user/message', user('valid source'), { surfaceOp: 'append' }).seq
    const answer = assistant(value)
    const derived = summary(value, [answer])
    value.append('contextify/request-read-set', { turn: 1, step: 1, planRevision: 1,
      historyEventSeqs: [derived], acceptedMessageIds: [] })
    expect(selected(value)).toEqual([source])
  })

  it('revokes summaries of uncertified or stale worker messages', () => {
    for (const kind of ['agent-message', 'subagent-settled'] as const) {
      const value = fresh()
      const source = value.append('user/message', user('worker evidence'), { surfaceOp: 'append' }).seq
      const child = SessionId('summary-worker')
      recordDelegationSlice(value, child, [source])
      const message = kind === 'agent-message'
        ? createUserMessage({ content: [{ type: 'text', text: 'worker answer' }],
          source: { kind, form: 'relay', senderSessionId: child } })
        : createUserMessage({ content: [{ type: 'text', text: 'worker answer' }],
          source: { kind, form: 'notice', summary: 'worker settled', senderSessionId: child } })
      const report = value.append('user/message', message, { surfaceOp: 'append' }).seq
      const derived = summary(value, [report])
      expect(selected(value)).toEqual([source, report, derived])
      exclude(value, source)
      expect(selected(value)).toEqual([])
    }
  })
})

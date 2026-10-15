/** Explicit provenance must not re-admit an invalid model-derived ancestor. */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
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

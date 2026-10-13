/** Source admission, corruption rejection and worker revocation through public APIs. */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  childMessageAdmissible, guardDelegatedToolCalls, recordDelegationSlice, recordRequestReadSet,
  revisionLineageSelection, sourceBoundDelegationCandidates, startSourceBoundContinuable,
} from '../src/revision-lineage.ts'
import { createInitialContextPlan } from '../src/plan.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'

const child = SessionId('source-child')
const user = (text: string) => createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' } })
const session = () => Session.create(SessionId('lineage-evidence'))
const selected = (value: Session) => revisionLineageSelection({ session: value, turn: -1, step: -1 }).eventSeqs

/** One visible Web result with the immutable call-event link. */
function web(value: Session, name = 'web_fetch', linked = true) {
  const turn = value.seq + 1
  const callId = ToolCallId(`web-${String(value.seq)}`)
  const args = name === 'web_search' ? { queries: ['publisher policy'] }
    : name === 'read' ? { path: 'policy.txt' } : { url: 'https://example.org' }
  value.append('turn/start', { turn })
  recordRequestReadSet(value, turn, 1, [])
  value.append('assistant/message', { turn, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
      source: { provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  const call = value.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args) }).seq
  const result = value.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId,
    content: [{ type: 'text', text: 'published evidence' }], isError: false }) }, {
    surfaceOp: 'append', ...(linked ? { sourceEventSeqs: [call] } : {}),
  }).seq
  value.append('turn/end', { turn, reason: { kind: 'completed' } })
  return result
}

describe('revision-consistent evidence admission', () => {
  it('rejects empty, duplicate, excluded and already-reserved delegation slices', () => {
    const value = session()
    const source = value.append('user/message', user('source'), { surfaceOp: 'append' }).seq
    for (const seqs of [[], [source, source], [99]]) {
      expect(() => recordDelegationSlice(value, child, seqs)).toThrow(/distinct currently selected/)
    }
    expect(recordDelegationSlice(value, child, [source]).sourceEventSeqs).toEqual([source])
    expect(() => recordDelegationSlice(value, child, [source])).toThrow(/already exists/)
    value.append('contextify/plan', { ...createInitialContextPlan(), excluded: [{ nodeId: 'source', eventSeq: source }] })
    expect(childMessageAdmissible(value, child)).toBe(false)
    expect(childMessageAdmissible(value, SessionId('unrecorded-child'))).toBe(false)
  })
  it('rejects uncertified worker reports and answers with missing, stale or cyclic read sets', () => {
    const value = session()
    const report = createUserMessage({ content: [{ type: 'text', text: 'worker report' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: child } })
    const settled = createUserMessage({ content: [{ type: 'text', text: 'worker settled' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Source-bound worker completed.', senderSessionId: child } })
    expect(() => recordRequestReadSet(value, 1, 1, [report])).toThrow(/uncertified or stale/)
    value.append('user/message', report, { surfaceOp: 'append' })
    value.append('user/message', settled, { surfaceOp: 'append' })
    const answer = value.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' }).seq
    expect(selected(value)).toEqual([])
    value.append('contextify/request-read-set', { turn: 1, step: 1, planRevision: 1,
      historyEventSeqs: [answer], acceptedMessageIds: [] })
    expect(selected(value)).toEqual([])
    value.append('contextify/request-read-set', { turn: 1, step: 1, planRevision: 1,
      historyEventSeqs: [], acceptedMessageIds: ['missing-message-id'] })
    expect(selected(value)).toEqual([])
    value.append('contextify/request-read-set', { turn: 1, step: 1, planRevision: 1,
      historyEventSeqs: [99], acceptedMessageIds: [] })
    expect(selected(value)).toEqual([])
  })
  it('records admitted worker IDs, prevents duplicate step records and follows transitive source revocation', () => {
    const value = session()
    const source = value.append('user/message', user('original evidence'), { surfaceOp: 'append' }).seq
    const derived = value.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'derived evidence' }],
      source: { kind: 'plugin', plugin: 'extract' } }), { surfaceOp: 'append', sourceEventSeqs: [source] }).seq
    recordDelegationSlice(value, child, [derived])
    const report = createUserMessage({ content: [{ type: 'text', text: 'certified report' }],
      source: { kind: 'subagent-settled', form: 'notice', summary: 'Source-bound worker completed.', senderSessionId: child } })
    const admitted = recordRequestReadSet(value, 1, 1, [report])
    expect(admitted.acceptedMessageIds).toEqual([report.id])
    expect(() => recordRequestReadSet(value, 1, 1, [])).toThrow(/already exists/)
    const reportSeq = value.append('user/message', report, { surfaceOp: 'append' }).seq
    value.append('assistant/message', { turn: 1, step: 1, stream: [],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'answer from report' }],
        source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    expect(selected(value)).toContain(reportSeq)
    expect(childMessageAdmissible(value, child)).toBe(true)
    value.append('contextify/plan', { ...createInitialContextPlan(), excluded: [{ nodeId: 'original', eventSeq: source }] })
    expect(selected(value)).toEqual([])
    expect(childMessageAdmissible(value, child)).toBe(false)
  })
  it('pages source previews without admitting whitespace, images, unlinked Web or non-Web observations', () => {
    const value = session()
    for (let i = 0; i < 20; i += 1) value.append('user/message', user(`source ${String(i)}`), { surfaceOp: 'append' })
    value.append('user/message', user('  '), { surfaceOp: 'append' })
    value.append('user/message', createUserMessage({ content: [{ type: 'image',
      attachment: { attachmentId: AttachmentId('lineage-coverage-image'),
        mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    web(value, 'read')
    web(value, 'web_search', false)
    const validWeb = web(value)
    for (const cursor of [-1, 1.2, NaN]) expect(() => sourceBoundDelegationCandidates(value, cursor)).toThrow(/beforeSeq/)
    const first = sourceBoundDelegationCandidates(value)
    expect(first.sources).toHaveLength(16)
    expect(first.sources[0]).toMatchObject({ seq: validWeb, kind: 'web', preview: 'published evidence' })
    expect(first.nextBeforeSeq).not.toBeNull()
    const older = sourceBoundDelegationCandidates(value, first.nextBeforeSeq!)
    expect(older.sources).toHaveLength(5)
    expect(older.nextBeforeSeq).toBeNull()
    expect(sourceBoundDelegationCandidates(value, 0).sources).toEqual([])
  })
  it('revokes a source slice when an original is replaced, while retaining an unrelated imported placeholder', () => {
    const value = session()
    const source = value.append('user/message', user('original'), { surfaceOp: 'append' }).seq
    recordDelegationSlice(value, child, [source])
    const snapshot = value.append('context/compiler-snapshot', { id: 'replacement', message: user('placeholder') }).seq
    const imported = value.append('context/compiler-snapshot', { id: 'unrelated', message: user('other placeholder') }).seq
    value.append('contextify/plan', { ...createInitialContextPlan(),
      included: [{ nodeId: 'offpath', snapshotSeq: imported, position: 1 }], replacements: [
        { nodeId: 'source', snapshotSeq: snapshot, originalEventSeq: source, role: 'user', kind: 'placeholder', reason: 'obsolete' },
        { nodeId: 'offpath', snapshotSeq: imported, originalEventSeq: null, role: 'user', kind: 'placeholder', reason: 'unrelated' },
      ] })
    expect(childMessageAdmissible(value, child)).toBe(false)
    expect(selected(value)).toEqual([snapshot, imported])
  })
  it('admits only authentic imported Web recall snapshots', () => {
    const value = session()
    const message = createUserMessage({ content: [{ type: 'text', text: 'Imported Web evidence. Verified policy text.' }],
      source: { kind: 'plugin', plugin: 'contextify', form: 'recall' } })
    const provenance = { provider: 'contextify', sourceId: 'external-sibling', sourceSeq: 3,
      contentHash: createHash('sha256').update(JSON.stringify(message)).digest('hex') }
    const valid = value.append('context/compiler-snapshot', { id: 'recall-valid', message, provenance }).seq
    const invalid = value.append('context/compiler-snapshot', { id: 'recall-invalid', message,
      provenance: { ...provenance, contentHash: 'forged' } }).seq
    value.append('contextify/plan', { ...createInitialContextPlan(), included: [
      { nodeId: 'valid', snapshotSeq: valid, position: 0 }, { nodeId: 'invalid', snapshotSeq: invalid, position: 1 },
    ] })
    expect(sourceBoundDelegationCandidates(value).sources).toEqual([
      { seq: valid, kind: 'web-recall', preview: 'Imported Web evidence. Verified policy text.' },
    ])
  })
})

it('renders exactly admitted Web evidence into a real spawned child with no global tools', async () => {
  const b = await lineageHarness()
  try {
    const source = b.parent.session.append('user/message', user('compare source policies'), { surfaceOp: 'append' }).seq
    const observation = web(b.parent.session)
    const search = web(b.parent.session, 'web_search')
    const started = await startSourceBoundContinuable(b.ctx, b.parent, child, [source, observation, search], new AbortController().signal)
    await vi.waitFor(() => { expect(b.adapter.requests.some(request => request.sessionId === started.childId)).toBe(true) })
    const request = b.adapter.requests.find(candidate => candidate.sessionId === started.childId)!
    expect(JSON.stringify(request.messages)).toContain('published evidence')
    expect(request.tools ?? []).toHaveLength(0)
    await expect(startSourceBoundContinuable(b.ctx, b.parent, SessionId('bad'), [99], new AbortController().signal))
      .rejects.toThrow(/source-bound/)
  } finally { await b.close() }
})

it('revokes delegated tools after an exclusion or parent disposal and leaves unrelated callers alone', async () => {
  const b = await lineageHarness()
  try {
    const source = b.parent.session.append('user/message', user('source'), { surfaceOp: 'append' }).seq
    const handle = await b.ctx.agents.create({ sessionId: child })
    const outsider = await b.ctx.agents.create({ sessionId: SessionId('outsider') })
    recordDelegationSlice(b.parent.session, child, [source])
    b.ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'fixture effect', parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'effect allowed' }]) }))
    const dispose = guardDelegatedToolCalls(b.ctx, b.parent, new Set([child]))
    const execute = (agent?: typeof b.parent) => b.ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('guard-probe'), name: 'probe', arguments: {}, ...(agent === undefined ? {} : { agent }) })
    expect((await execute()).isError).toBe(false)
    expect((await execute(outsider.agent)).isError).toBe(false)
    expect((await execute(handle.agent)).isError).toBe(false)
    b.parent.session.append('contextify/plan', { ...createInitialContextPlan(), excluded: [{ nodeId: 'source', eventSeq: source }] })
    expect((await execute(handle.agent)).error?.message).toContain('delegated source')
    b.parent.session.append('contextify/plan', createInitialContextPlan())
    expect((await execute(handle.agent)).isError).toBe(false)
    await b.disposeParent()
    expect(b.ctx.agents.get(b.parent.id)).toBeUndefined()
    expect((await execute(handle.agent)).error?.message).toContain('delegated source')
    dispose()
    expect((await execute(handle.agent)).isError).toBe(false)
  } finally { await b.close() }
})

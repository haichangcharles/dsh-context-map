/** Public source admission and persisted replacement integrity, using real Harness services. */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createInitialContextPlan, compileContextify } from '../src/plan.ts'
import { lineageHarness } from './lineage-coverage-harness.ts'

const user = (text: string) => createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' } })

/** A closed native turn gives the sibling a legitimate fork boundary. */
function closedTurn(session: Session, turn: number, text: string) {
  session.append('turn/start', { turn })
  const seq = session.append('user/message', user(text), { surfaceOp: 'append' }).seq
  session.append('assistant/message', { turn, step: 1, stream: [],
    message: createAssistantMessage({ content: [{ type: 'text', text: `Answer: ${text}` }],
      source: { provider: 'mock', model: 'mock' } }),
  }, { surfaceOp: 'append' })
  const boundary = session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq
  return { seq, boundary }
}

describe('public Contextify source boundaries', () => {
  it('rejects a reasoning-only persisted user source without changing the active plan or log', async () => {
    const b = await lineageHarness()
    try {
      const prefix = closedTurn(b.parent.session, 1, 'Shared planning brief')
      const sibling = b.ctx.sessions.fork(b.parent.session, prefix.boundary, SessionId('reasoning-source'))
      sibling.append('turn/start', { turn: 2 })
      const seq = sibling.append('user/message', createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'reasoning', text: 'No portable visible context.' }],
      }), { surfaceOp: 'append' }).seq
      sibling.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const page = await b.ctx.contextify.familyPage(b.parent)
      expect(page.records.find(node => node.owner.sessionId === sibling.id && node.owner.seq === seq))
        .toMatchObject({ role: 'user', sourceKind: 'chat', activeEventSeq: null })
      const before = b.parent.session.snapshotEvents()
      const view = b.ctx.contextify.get(b.parent)
      await expect(b.ctx.contextify.setNodeMode(b.parent, { revision: view.plan.revision },
        { sessionId: sibling.id, seq }, 'include')).rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      expect(b.parent.session.snapshotEvents()).toEqual(before)
      expect(b.ctx.contextify.get(b.parent).plan).toEqual(view.plan)
      expect(b.adapter.requests).toHaveLength(0)
    } finally { await b.close() }
  })

  it('rejects a completed tool exchange as a standalone assistant import without copying its call', async () => {
    const b = await lineageHarness()
    try {
      const prefix = closedTurn(b.parent.session, 1, 'Shared planning brief')
      const sibling = b.ctx.sessions.fork(b.parent.session, prefix.boundary, SessionId('tool-source'))
      const callId = ToolCallId('source-read')
      sibling.append('turn/start', { turn: 2 })
      sibling.append('user/message', user('Read the research notes'), { surfaceOp: 'append' })
      const seq = sibling.append('assistant/message', { turn: 2, step: 1, stream: [],
        message: createAssistantMessage({ source: { provider: 'mock', model: 'mock' }, content: [
          { type: 'text', text: 'I will read the notes.' },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"notes.md"}' },
        ] }),
      }, { surfaceOp: 'append' }).seq
      sibling.append('tool/call', { turn: 2, step: 1, callId, name: 'read', arguments: '{"path":"notes.md"}' })
      sibling.append('tool/result', { turn: 2, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Research notes' }], isError: false }),
      }, { surfaceOp: 'append' })
      // A provider may stop with no final visible text after a closed exchange.
      // The graph still exposes the preceding visible assistant step.
      sibling.append('assistant/message', { turn: 2, step: 2, stream: [],
        message: createAssistantMessage({ source: { provider: 'mock', model: 'mock' }, content: [] }),
      }, { surfaceOp: 'append' })
      sibling.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const page = await b.ctx.contextify.familyPage(b.parent)
      expect(page.records.find(node => node.owner.sessionId === sibling.id && node.owner.seq === seq))
        .toMatchObject({ role: 'assistant', sourceKind: 'chat' })
      const before = b.parent.session.snapshotEvents()
      await expect(b.ctx.contextify.setNodeMode(b.parent,
        { revision: b.ctx.contextify.get(b.parent).plan.revision }, { sessionId: sibling.id, seq }, 'include'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      expect(b.parent.session.snapshotEvents()).toEqual(before)
      expect(b.adapter.requests).toHaveLength(0)
    } finally { await b.close() }
  })

  it.each(['missing', 'wrong-event'] as const)('keeps the original graph readable when a replacement snapshot is %s', async (kind) => {
    const b = await lineageHarness()
    try {
      const source = closedTurn(b.parent.session, 1, 'Original inspectable brief')
      const page = await b.ctx.contextify.familyPage(b.parent)
      const node = page.records.find(item => item.owner.seq === source.seq)
      expect(node).toBeDefined()
      if (node === undefined) throw new Error('native user node is absent')
      b.parent.session.append('contextify/plan', { ...createInitialContextPlan(), replacements: [{
        nodeId: node.id, snapshotSeq: kind === 'missing' ? 99 : source.seq,
        originalEventSeq: source.seq, role: 'user', kind: 'placeholder', reason: 'Persisted overlay',
      }] })
      const decorated = await b.ctx.contextify.familyPage(b.parent, 0, 1)
      expect(decorated.records).toEqual([node])
      expect(decorated.records[0]?.replacement).toBeUndefined()
      expect(decorated.nextAfter).toBe(1)
      expect(() => b.ctx.contextify.get(b.parent)).toThrow(/snapshot|unavailable/)
      expect(b.adapter.requests).toHaveLength(0)
    } finally { await b.close() }
  })

  it('restores an included sibling placeholder while preserving a second imported source and both originals', async () => {
    const b = await lineageHarness()
    try {
      const prefix = closedTurn(b.parent.session, 1, 'Shared planning brief')
      const sibling = b.ctx.sessions.fork(b.parent.session, prefix.boundary, SessionId('restorable-source'))
      const first = closedTurn(sibling, 2, 'First sibling evidence')
      const second = closedTurn(sibling, 3, 'Second sibling evidence')
      const originalEvents = sibling.snapshotEvents()
      const firstRef = { sessionId: sibling.id, seq: first.seq }
      const secondRef = { sessionId: sibling.id, seq: second.seq }
      const archived = await b.ctx.contextify.archiveNode(b.parent,
        { revision: b.ctx.contextify.get(b.parent).plan.revision }, firstRef, 'Park old detail')
      const replacement = archived.plan.replacements[0]
      expect(replacement).toBeDefined()
      const included = await b.ctx.contextify.setNodeModes(b.parent, { revision: archived.plan.revision }, [
        { node: firstRef, mode: 'include' }, { node: secondRef, mode: 'include' },
      ])
      expect(included.plan.included[0]?.snapshotSeq).toBe(replacement?.snapshotSeq)
      const unchanged = included.plan.included[1]
      const restored = await b.ctx.contextify.restoreNode(b.parent, { revision: included.plan.revision }, firstRef)
      expect(restored.plan.replacements).toEqual([])
      expect(restored.plan.included[0]?.snapshotSeq).not.toBe(replacement?.snapshotSeq)
      expect(restored.plan.included[1]).toEqual(unchanged)
      const selected = compileContextify({ session: b.parent.session, turn: -1, step: -1 })
      expect(JSON.stringify(selected.messages)).toContain('First sibling evidence')
      expect(JSON.stringify(selected.messages)).toContain('Second sibling evidence')
      expect(sibling.snapshotEvents()).toEqual(originalEvents)
      expect(b.adapter.requests).toHaveLength(0)
    } finally { await b.close() }
  })
})

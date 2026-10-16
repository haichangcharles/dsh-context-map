/** Historical route decisions retain past task evidence without future leakage. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ImageBlock } from '@deepseek-ai/dsh-llm'
import { contextPolicyObservationsFromFamily } from '../src/context-steward-profile.ts'
import type { ContextFamilyGraph, ContextFamilyInspection } from '../src/types.ts'

const main = SessionId('history-main')
const side = SessionId('history-side')
const graph = { rootSessionId: main, activeSessionId: side, nodes: [], edges: [],
  sessions: [{ id: main, depth: 0 }, { id: side, parentSessionId: main, depth: 1 }],
} as unknown as ContextFamilyGraph
function message(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
}
const inspection = (session: Session): ContextFamilyInspection => ({ meta: session.header,
  events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount })

describe('route learning episodes', () => {
  it('retains the chosen fork parent and only its task text preceding the choice', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      const source = ctx.sessions.create(side), parent = ctx.sessions.create(main)
      message(source, 'First alternative')
      message(parent, 'Plan the community event')
      clock.mockReturnValue(200)
      source.append('contextify/route-choice', { routeKey: 'sibling', action: 'branch', choice: 'accept',
        base: { activeSessionId: side, graphRevision: 'g', planRevision: 1 },
        objective: 'Explore another alternative', forkParentSessionId: main, uiOrigin: 'contextify-client' })
      clock.mockReturnValue(300)
      message(parent, 'Future parent task')
      const samples = contextPolicyObservationsFromFamily(graph,
        new Map([[side, inspection(source)], [main, inspection(parent)]]))
      expect(samples[0]).toMatchObject({ action: 'branch', forkParentSessionId: main,
        routeContext: { source: 'First alternative', parent: 'Plan the community event' } })
      expect(JSON.stringify(samples)).not.toContain('Future parent')
    } finally { clock.mockRestore(); await ctx.fiber.dispose() }
  })

  it('retains branch-review input and the task preceding that input', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const session = ctx.sessions.create(side)
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [
        { type: 'image', attachment: { attachmentId: 'route-image' as ImageBlock['attachment']['attachmentId'],
          mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        { type: 'text', text: 'Plan a community event' },
      ] }), { surfaceOp: 'append' })
      const draft = message(session, 'Write a separate invitation')
      session.append('contextify/branch-choice', { suggestionId: 'reviewed', turnEndSeq: draft.seq,
        choice: 'move', uiOrigin: 'contextify-client' })
      message(session, 'Future confidential task')
      const [sample] = contextPolicyObservationsFromFamily(graph, new Map([[side, inspection(session)]]))
      expect(sample).toMatchObject({ action: 'branch', choice: 'accept',
        objective: 'Write a separate invitation', routeContext: { source: 'Plan a community event' } })
      expect(JSON.stringify(sample)).not.toContain('Future confidential')
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps rejected navigation and only strictly earlier foreign task text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
    try {
      const source = ctx.sessions.create(side)
      const target = ctx.sessions.create(main)
      message(source, 'Draft the invitation')
      message(target, 'Plan a community event')
      clock.mockReturnValue(200)
      source.append('contextify/route-choice', { routeKey: 'r', action: 'return', choice: 'reject',
        base: { activeSessionId: side, graphRevision: 'g', planRevision: 1 },
        objective: 'Discuss the venue', targetSessionId: main, uiOrigin: 'contextify-client' })
      message(target, 'Same millisecond later message')
      clock.mockReturnValue(300)
      message(source, 'Future source message')
      message(target, 'Future target message')
      const samples = contextPolicyObservationsFromFamily(graph,
        new Map([[side, inspection(source)], [main, inspection(target)]]))
      expect(samples).toHaveLength(1)
      expect(samples[0]).toMatchObject({ action: 'return', choice: 'reject',
        routeContext: { source: 'Draft the invitation', target: 'Plan a community event' } })
      expect(JSON.stringify(samples)).not.toMatch(/Future|Same millisecond/)
    } finally { clock.mockRestore(); await ctx.fiber.dispose() }
  })
})

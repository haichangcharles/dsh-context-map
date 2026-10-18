import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildContextActionPacket } from '../src/semantic-route.ts'
import type { ContextFamilyGraph } from '../src/types.ts'

it('routes with task-owned history even when the evidence slate omits its relevant old message', () => {
  const main = SessionId('main'), child = SessionId('child')
  const graph = { activeSessionId: child, sessions: [{ id: main, depth: 0 }, { id: child, depth: 1, parentSessionId: main }],
    nodes: Array.from({ length: 20 }, (_, i) => ({ id: `main:${String(i)}`, role: 'user',
      owner: { sessionId: main, seq: i }, sessionIds: [main, child],
      preview: i === 0 ? 'Um,' : i === 2 ? 'Cancellation must unregister resources atomically.' : 'Discuss another implementation detail.' })),
  } as unknown as ContextFamilyGraph
  const packet = buildContextActionPacket({ graph, contents: {}, objective: 'What happens to resources on cancellation?',
    base: { activeSessionId: child, planRevision: 0, graphRevision: 'g' }, visibleNodeIds: ['main:19'] })
  expect(packet.candidates[0]?.label).not.toBe('Um,')
  expect(packet.candidates[0]?.nodes.map(node => node.id)).toContain('main:2')
  expect(packet.candidates[0]?.nodes.length).toBeLessThanOrEqual(4)
  expect(packet.activeTask?.sessionId).toBe(child)
})

it('handles an unavailable active task without inventing one', () => {
  const active = SessionId('absent')
  const packet = buildContextActionPacket({ graph: { sessions: [], nodes: [], activeSessionId: active } as unknown as ContextFamilyGraph,
    contents: {}, objective: '', base: { activeSessionId: active, planRevision: 0, graphRevision: 'g' } })
  expect(packet.activeTask).toBeUndefined()
})

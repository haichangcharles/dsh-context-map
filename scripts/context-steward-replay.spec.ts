import { describe, expect, it } from 'vitest'
import { contextStewardReplay } from './context-steward-replay.ts'

describe('constructed Context Steward packet export', () => {
  it('retains native lineage and uses only prior choices in each frozen packet', async () => {
    const result = await contextStewardReplay()
    expect(result.apiCalls).toBe(0)
    expect(result.checks).toMatchObject({ completedTurns: 30, uniqueMessageNodes: 60,
      reviewedRouteCases: 6, completedEvidenceRetained: true, reentryReopensBranch: true })
    for (const [index, packet] of result.visible.packets.entries()) {
      expect(packet.confirmedHistory.map(item => item.packetId))
        .toEqual(result.visible.packets.slice(0, index).map(item => item.packetId))
      expect(packet).not.toHaveProperty('expectedAction')
      expect(packet).not.toHaveProperty('intent')
      expect(packet.candidates.every(candidate => candidate.sessionId !== packet.graph.activeSessionId)).toBe(true)
      expect(packet.actionPacket.candidates.length).toBeLessThanOrEqual(8)
      expect(packet.actionPacket.candidates.every(candidate => candidate.nodes.length <= 12
        && candidate.nodes.every(node => Array.from(node.content).length <= 1200))).toBe(true)
      expect(packet.graph.nodes.length).toBe(packet.completedTurns * 2)
    }
  })

  it('exports identical packet identities across independent fixture construction', async () => {
    const first = await contextStewardReplay()
    const second = await contextStewardReplay()
    expect(second.visible).toEqual(first.visible)
    expect(second.gold).toEqual(first.gold)
  })
})

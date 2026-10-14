/** Keyless structural replay and prefix-only packet exporter; this is a test tool. */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { projectSessionFamily } from '../packages/context/contextify/src/family.ts'
import { buildContextRouteCandidates, planContextRoute,
  type ContextRouteAction, type ContextRouteIntent } from '../packages/context/contextify/src/context-route-policy.ts'
import type { ContextFamilyGraph } from '../packages/context/contextify/src/types.ts'
import { buildContextActionPacket } from '../packages/context/contextify/src/semantic-route.ts'

interface VisiblePacket {
  readonly packetId: string
  readonly completedTurns: number
  readonly objective: string
  readonly graph: ContextFamilyGraph
  readonly candidates: ReturnType<typeof buildContextRouteCandidates>
  readonly actionPacket: ReturnType<typeof buildContextActionPacket>
  readonly confirmedHistory: readonly { readonly packetId: string; readonly action: ContextRouteAction }[]
}

/**
 * Exercise native lineage, re-entry and completed evidence without a provider.
 * @returns Constructed visible packets, separately held fixture expectations, and structural check counts.
 */
export async function contextStewardReplay() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const root = ctx.sessions.create(SessionId('replay-main'))
  const sessions: Session[] = [root]
  let completedTurns = 0
  const append = (session: Session, topic: string, count: number) => {
    for (let index = 0; index < count; index++) {
      const turn = ++completedTurns
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${topic}: task ${String(turn)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('assistant/message', { turn, step: 1, stream: [],
        message: createAssistantMessage({
          content: [{ type: 'text', text: `${topic}: reviewed result ${String(turn)}` }],
          source: { provider: 'fixture', model: 'keyless' },
        }),
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  const fork = (id: string) => {
    const boundary = root.snapshotEvents().at(-1)
    assert(boundary !== undefined)
    const child = ctx.sessions.fork(root, boundary.seq, SessionId(id))
    sessions.push(child)
    return child
  }
  const graphAt = (active: Session): ContextFamilyGraph => {
    const graph = projectSessionFamily({ activeSessionId: active.id,
      sessions: sessions.map(session => ({ meta: session.header,
        inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() })),
    })
    // Fixture time is not part of the scorer input, so repeated exports are byte-stable.
    return { ...graph, nodes: graph.nodes.map(node => ({ ...node, time: 0 })) }
  }
  const packets: VisiblePacket[] = []
  const gold: { packetId: string; expectedAction: ContextRouteAction }[] = []
  const history: { packetId: string; action: ContextRouteAction }[] = []
  let legalEvidenceChecks = 0
  const review = (active: Session, objective: string, intent: ContextRouteIntent,
    expectedAction: ContextRouteAction, target?: Session) => {
    const graph = graphAt(active)
    const candidates = buildContextRouteCandidates({ graph, contents: {}, objective })
    const actionPacket = buildContextActionPacket({ graph, contents: {}, objective,
      base: { planRevision: 0, activeSessionId: active.id,
        graphRevision: createHash('sha256').update(JSON.stringify(graph)).digest('hex') },
    })
    const body = { completedTurns, objective, graph, candidates, actionPacket,
      confirmedHistory: history.map(item => ({ ...item })) }
    const packetId = createHash('sha256').update(JSON.stringify(body)).digest('hex')
    packets.push({ packetId, ...body })
    // Scores are fixture controls, held out of visible packets; they are not model predictions.
    const parentSessionId = graph.sessions.find(session => session.id === active.id)?.parentSessionId
    const proposal = planContextRoute({ intent, activeSessionId: active.id,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      candidates: candidates.map(candidate => ({ ...candidate,
        destinationScore: candidate.sessionId === target?.id ? 0.9 : 0.1,
        evidenceScore: candidate.sessionId === target?.id ? 0.9 : 0.1,
        supersededScore: 0,
        evidenceNodeIds: candidate.offPathNodeIds.slice(-1),
      })),
    })
    assert.equal(proposal.action, expectedAction)
    if (expectedAction === 'include') {
      assert.equal(proposal.targetSessionId, target?.id)
      assert(proposal.sourceNodeIds?.every(id => graph.nodes.some(node => node.id === id
        && node.owner.sessionId === target?.id && !node.sessionIds.includes(active.id))))
      legalEvidenceChecks++
    }
    gold.push({ packetId, expectedAction })
    history.push({ packetId, action: expectedAction })
  }
  append(root, 'Plan a community website launch', 10)
  review(root, 'New task: verify website launch evidence', 'new-task', 'branch')
  const research = fork('replay-evidence')
  append(research, 'Verify published launch facts', 6)
  review(research, 'Return to main plan', 'return', 'return')
  root.append('contextify/work-state', { targetSessionId: research.id,
    state: 'completed', targetEventSeq: research.seq - 1, uiOrigin: 'contextify-client' })
  const writing = fork('replay-writing')
  append(writing, 'Write the community website launch page', 6)
  review(writing, 'Use published launch facts in this draft', 'reference', 'include', research)
  assert.equal(graphAt(writing).sessions.find(session => session.id === research.id)?.workState, 'completed')
  const brainstorming = fork('replay-brainstorming')
  append(brainstorming, 'Brainstorm community website themes', 4)
  review(brainstorming, 'Resume writing the launch page', 'resume', 'navigate', writing)
  append(research, 'Recheck the published launch date', 2)
  assert.equal(graphAt(research).sessions.find(session => session.id === research.id)?.workState, 'open')
  review(research, 'Return to the main website plan', 'return', 'return')
  append(root, 'Finalize the community website plan', 2)
  review(root, 'Continue', 'unknown', 'continue')
  const finalGraph = graphAt(root)
  assert.equal(completedTurns, 30)
  assert.equal(finalGraph.nodes.length, 60)
  assert.equal(new Set(finalGraph.nodes.map(node => node.id)).size, 60)
  assert.equal(finalGraph.sessions.length, 4)
  assert.deepEqual(packets.map(packet => packet.confirmedHistory.length), [0, 1, 2, 3, 4, 5])
  return {
    protocol: 'constructed-context-steward-structural-replay-v1',
    apiCalls: 0,
    checks: { completedTurns, sessions: 4, uniqueMessageNodes: 60, reviewedRouteCases: 6,
      legalEvidenceChecks, completedEvidenceRetained: true, reentryReopensBranch: true },
    caveats: ['Constructed fixture expectations, not external or human action gold.',
      'Scores are fixed test controls; these checks do not measure semantic routing accuracy.',
      'This pure replay does not measure compiled requests, UI operations, latency or personalization gains.'],
    visible: { version: 'context-steward-prefix-packets-v1', packets },
    gold: { version: 'context-steward-fixture-expectations-v1', rows: gold },
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [outputPrefix] = process.argv.slice(2)
  if (outputPrefix === undefined) throw new Error('usage: context-steward-replay.ts output-prefix')
  const result = await contextStewardReplay()
  writeFileSync(`${outputPrefix}.visible.json`, JSON.stringify(result.visible, null, 2) + '\n')
  writeFileSync(`${outputPrefix}.gold.json`, JSON.stringify(result.gold, null, 2) + '\n')
  const { visible: _visible, gold: _gold, ...summary } = result
  writeFileSync(`${outputPrefix}.summary.json`, JSON.stringify(summary, null, 2) + '\n')
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
}

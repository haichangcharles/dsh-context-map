import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import SubagentRuntime, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import ContextifyService from '../src/index.ts'

function stubAgent(session: Session): { agent: Agent; setStatus: (status: AgentStatus) => void } {
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send() {}, followup() {}, steer() {}, inject(input) { inbox.append('next-step', input) }, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, setStatus: (value) => { status = value } }
}

function appendClosedTurn(session: Session, turn: number, user: string, assistant?: string): {
  userSeq: number
  boundary: number
} {
  session.append('turn/start', { turn })
  const userSeq = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: user }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
  if (assistant !== undefined) {
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: assistant }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
  }
  const boundary = session.append('turn/end', { turn, reason: { kind: 'completed' } }).seq
  return { userSeq, boundary }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ContextCompilerRegistry)
  await ctx.plugin(SubagentRuntime)
  ctx.provide('sessionPersistence', {
    list: async () => ctx.sessions.list().map(session => session.header),
    inspect: async (id: string): Promise<SessionInspection> => {
      const session = ctx.sessions.get(SessionId(id))
      if (session === undefined) throw new Error(`missing Session ${id}`)
      return { meta: session.header, events: session.events }
    },
  } as never)
  await ctx.plugin(ContextifyService)
  const start = (session: Session) => {
    const stub = stubAgent(session)
    ctx.agents.register(stub.agent)
    agentEvents(ctx, stub.agent).emit('agent/session-start', { source: 'startup' })
    return stub
  }
  return { ctx, start }
}

describe('ContextifyService native Session family', () => {
  it('generates review-only recommendations through an isolated Harness subagent', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('recommendation'))
    const active = start(session)
    const turn = appendClosedTurn(session, 1, 'old requirement', 'new answer')
    let captured: SubagentStartRequest | undefined
    let disposed = false
    ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      inheritsParentContext: false,
      start: async (request) => {
        captured = request
        return {
          id: SessionId('review-child'),
          localAgent: undefined,
          result: Promise.resolve({
            output: [],
            stopReason: 'completed',
            structured: {
              selection: [{
                nodeId: `${session.id}:${String(turn.userSeq)}`, action: 'exclude', reason: 'Superseded', confidence: 'high',
              }],
              cleanup: [],
            },
          }),
          dispose: async () => { disposed = true },
        }
      },
    })
    const view = ctx.contextify.get(active.agent)
    const before = session.seq

    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphAsOfSeq: view.graphAsOfSeq,
      activeSessionId: session.id,
    })

    expect(proposal.selection).toMatchObject([{ action: 'exclude', reason: 'Superseded' }])
    expect(captured?.parent.id).toBe(active.agent.id)
    expect(captured?.toolFilter).toEqual({ allow: [] })
    expect(captured?.agentOptions).toEqual({ maxTokens: 4_000 })
    expect(captured?.outputSchema).toMatchObject({ type: 'object' })
    expect(disposed).toBe(true)
    expect(session.seq).toBe(before)
  })

  it('migrates a legacy same-Session plan to v2 Natural before compilation', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('legacy-plan'))
    session.append('contextify/plan', {
      kind: 'contextify/plan',
      version: 1,
      revision: 1,
      mainlinePathId: 'root',
      activePathId: 'root',
      paths: [{
        id: 'root', parentPathId: null, anchorSeq: null, label: 'Main', status: 'active',
      }],
      overrides: [],
    } as never)
    appendClosedTurn(session, 1, 'legacy prompt', 'legacy reply')

    const active = start(session)
    const view = ctx.contextify.get(active.agent)

    expect(view.plan).toMatchObject({ version: 2, revision: 2, excluded: [], included: [] })
    expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages)
      .toEqual(session.deriveMessages())
  })

  it('pages a de-duplicated family and imports only a same-family message snapshot', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('root'))
    start(root)
    const rootTurn = appendClosedTurn(root, 1, 'root requirement', 'root answer')
    const activeSession = ctx.sessions.fork(root, rootTurn.boundary, SessionId('active-child'))
    const active = start(activeSession)
    const activeTurn = appendClosedTurn(activeSession, 2, 'active question')
    const sibling = ctx.sessions.fork(root, rootTurn.boundary, SessionId('sibling-child'))
    start(sibling)
    const siblingTurn = appendClosedTurn(sibling, 2, 'sibling discovery')
    const unrelated = ctx.sessions.create(SessionId('unrelated'))
    start(unrelated)
    const unrelatedTurn = appendClosedTurn(unrelated, 1, 'unrelated fact')

    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    expect(page.records.map(node => node.preview)).toEqual([
      'root requirement', 'root answer', 'active question', 'sibling discovery',
    ])
    expect(page.records.filter(node => node.preview === 'root requirement')).toHaveLength(1)
    expect(page.sessions.map(session => session.id)).toEqual([root.id, activeSession.id, sibling.id])

    const initial = ctx.contextify.get(active.agent)
    expect(initial.plan).toMatchObject({ revision: 2, excluded: [], included: [] })
    const before = activeSession.seq
    const included = await ctx.contextify.setNodeMode(
      active.agent,
      { revision: initial.plan.revision },
      { sessionId: sibling.id, seq: siblingTurn.userSeq },
      'include',
    )
    expect(activeSession.events.slice(before).map(event => event.type))
      .toEqual(['context/compiler-snapshot', 'contextify/plan'])
    expect(included.plan.included).toMatchObject([{
      nodeId: `${sibling.id}:${String(siblingTurn.userSeq)}`,
      snapshotSeq: before,
    }])
    expect(ctx.contextCompiler.compile({ session: activeSession, turn: 3, step: 1 }).messages)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ content: [{ type: 'text', text: 'sibling discovery' }] }),
      ]))

    const afterInclude = activeSession.seq
    await expect(ctx.contextify.setNodeMode(
      active.agent,
      { revision: included.plan.revision },
      { sessionId: unrelated.id, seq: unrelatedTurn.userSeq },
      'include',
    )).rejects.toMatchObject({ code: 'CONTEXTIFY_CROSS_FAMILY' })
    expect(activeSession.seq).toBe(afterInclude)

    await expect(ctx.contextify.setNodeMode(
      active.agent,
      { revision: initial.plan.revision },
      { sessionId: activeSession.id, seq: activeTurn.userSeq },
      'exclude',
    )).rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_REVISION' })
    expect(activeSession.seq).toBe(afterInclude)
  })

  it('resets inherited choices when a native fork child starts', async () => {
    const { ctx, start } = await harness()
    const parent = ctx.sessions.create(SessionId('reset-parent'))
    const parentAgent = start(parent)
    const turn = appendClosedTurn(parent, 1, 'keep the prefix')
    const selected = await ctx.contextify.setNodeMode(
      parentAgent.agent,
      { revision: 1 },
      { sessionId: parent.id, seq: turn.userSeq },
      'exclude',
    )
    expect(selected.plan.excluded).toHaveLength(1)

    const child = ctx.sessions.fork(parent, parent.events.at(-1)!.seq, SessionId('reset-child'))
    const childAgent = start(child)
    const view = ctx.contextify.get(childAgent.agent)

    expect(view.plan.revision).toBe(selected.plan.revision + 1)
    expect(view.plan.excluded).toEqual([])
    expect(view.plan.included).toEqual([])
    expect(child.events.findLast(event => event.type === 'contextify/plan')!.seq)
      .toBeGreaterThanOrEqual(child.header.seedLength ?? 0)
  })

  it('rejects mutations while the Agent is running without appending', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('busy'))
    const active = start(session)
    const turn = appendClosedTurn(session, 1, 'busy question')
    active.setStatus('running')
    const before = session.seq

    await expect(ctx.contextify.setNodeMode(
      active.agent,
      { revision: 1 },
      { sessionId: session.id, seq: turn.userSeq },
      'exclude',
    )).rejects.toMatchObject({ code: 'CONTEXTIFY_AGENT_BUSY' })
    expect(session.seq).toBe(before)
  })
})

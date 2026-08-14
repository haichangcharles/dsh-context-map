import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent, type AgentStatus } from '@deepseek-ai/dsh-agent'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ContextifyService, { ContextPathId } from '../src/index.ts'

function stubAgent(rawId: string): { agent: Agent; session: Session; setStatus: (status: AgentStatus) => void } {
  const session = Session.create(SessionId(rawId))
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
  return { agent, session, setStatus: (value) => { status = value } }
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ContextCompilerRegistry)
  await ctx.plugin(ContextifyService)
  const stub = stubAgent(`contextify-service-${Math.random()}`)
  ctx.agents.register(stub.agent)
  agentEvents(ctx, stub.agent).emit('agent/session-start', { source: 'startup' })
  return { ctx, ...stub }
}

describe('ContextifyService', () => {
  it('initializes once and mutates branches with revision CAS', async () => {
    const { ctx, agent, session } = await harness()
    const anchorSeq = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'anchor' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
    expect(ctx.contextify.graphPage(agent).records).toMatchObject([
      { seq: anchorSeq, preview: 'anchor' },
    ])

    expect(ctx.contextCompiler.descriptor(session)).toEqual({ id: 'contextify', version: 1 })
    expect(ctx.contextify.get(agent).plan.revision).toBe(1)

    const branched = ctx.contextify.createBranch(agent, { revision: 1 }, anchorSeq, 'Alternative')
    expect(branched.plan.activePathId).toMatch(/^path-/)
    expect(branched.plan).toMatchObject({
      revision: 2,
      paths: [{ id: ContextPathId('root') }, { label: 'Alternative', anchorSeq }],
    })
    expect(() => ctx.contextify.createBranch(agent, { revision: 1 }, anchorSeq))
      .toThrow(expect.objectContaining({ code: 'CONTEXTIFY_STALE_REVISION' }))

    const selected = ctx.contextify.setNodeMode(agent, { revision: 2 }, anchorSeq, 'exclude')
    expect(selected.plan).toMatchObject({
      revision: 3,
      overrides: [{ seq: anchorSeq, mode: 'exclude' }],
    })
    expect(session.events.filter(event => event.type === 'contextify/plan')).toHaveLength(3)
  })

  it('rejects mutations while the Agent is running without appending', async () => {
    const { ctx, agent, session, setStatus } = await harness()
    setStatus('running')
    const before = session.seq

    expect(() => ctx.contextify.returnToMainline(agent, { revision: 1 }))
      .toThrow(expect.objectContaining({ code: 'CONTEXTIFY_AGENT_BUSY' }))
    expect(session.seq).toBe(before)
  })
})

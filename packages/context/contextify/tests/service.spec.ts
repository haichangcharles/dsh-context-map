import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent, type AgentOptions, type AgentStatus } from '@deepseek-ai/dsh-agent'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import LlmRuntime, {
  createAssistantMessage,
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import ContextifyService from '../src/index.ts'
import {
  CONTEXTIFY_DEFAULT_SETTINGS,
  CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT,
  type ContextifyPromptSettings,
} from '../src/types.ts'

function stubAgent(session: Session, options: AgentOptions = {}): {
  agent: Agent
  setStatus: (status: AgentStatus) => void
  maintenanceCalls: () => number
} {
  const inbox = new Inbox(session, { inserted() {}, discarded() {}, claimed() {} })
  let status: AgentStatus = 'idle'
  let maintenanceCalls = 0
  const agent: Agent = {
    id: session.id,
    options,
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send() {}, followup() {}, steer() {}, inject(input) { inbox.append('next-step', input) }, cancel() {},
    runMaintenance: (task) => {
      maintenanceCalls += 1
      return task(new AbortController().signal)
    },
    whenIdle: () => Promise.resolve(),
  }
  return {
    agent,
    setStatus: (value) => { status = value },
    maintenanceCalls: () => maintenanceCalls,
  }
}

function appendClosedTurn(
  session: Session,
  turn: number,
  user: string,
  assistant?: string,
  source: { provider: string; model: string } = { provider: 'mock', model: 'mock' },
): {
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
        source,
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
  await ctx.plugin(LlmRuntime)
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
  const start = (session: Session, options?: AgentOptions) => {
    const stub = stubAgent(session, options)
    ctx.agents.register(stub.agent)
    agentEvents(ctx, stub.agent).emit('agent/session-start', { source: 'startup' })
    return stub
  }
  return { ctx, start }
}

abstract class OffReasoningAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] },
    })
  }
}

describe('ContextifyService native Session family', () => {
  it('reviews a completed Turn asynchronously and relocates the Q&A idempotently', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-source'))
    const active = start(session)
    for (let turn = 1; turn <= 5; turn += 1) {
      appendClosedTurn(session, turn, `history-${String(turn)}`, `answer-${String(turn)}`)
    }
    let captured: GenerateOptions | undefined
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        captured = options
        const text = '{"action":"suggest_branch","confidence":0.91,"reason":"Parallel topic"}'
        // Some reasoning-capable routes return the requested classifier JSON
        // in the reasoning channel even when the selected effort is Off.
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const service = ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
    }
    service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
    const target = appendClosedTurn(session, 6, 'temporary side topic', 'side answer')

    await vi.waitFor(() => { expect(captured).toBeDefined() })
    await vi.waitFor(() => {
      expect(session.events.some(event => event.type === 'contextify/branch-review'
        && event.data.turnEndSeq === target.boundary)).toBe(true)
    })
    expect(captured?.maxTokens).toBe(200)
    expect(captured?.reasoningEffort).toBe(ReasoningEffortId('off'))
    expect(captured?.tools).toBeUndefined()
    expect(JSON.stringify(captured?.messages)).not.toContain('history-1')
    expect(JSON.stringify(captured?.messages)).toContain('history-5')
    expect(active.maintenanceCalls()).toBe(0)
    const suggestion = ctx.contextify.get(active.agent).branchSuggestion
    expect(suggestion).toMatchObject({ reason: 'Parallel topic', confidence: 0.91 })

    const first = await ctx.contextify.acceptBranchSuggestion(active.agent, suggestion!.id)
    const second = await ctx.contextify.acceptBranchSuggestion(active.agent, suggestion!.id)
    expect(second).toEqual(first)
    const child = ctx.sessions.get(first.childSessionId)!
    expect(child.header.parentSession).toBe(session.id)
    expect(child.events.filter(event => event.type === 'user/message')
      .filter(event => event.data.source.kind === 'user').at(-1)?.data.content)
      .toEqual([{ type: 'text', text: 'temporary side topic' }])
    expect(child.events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content)
      .toEqual([{ type: 'text', text: 'side answer' }])
    expect(ctx.contextify.get(active.agent).plan.replacements).toHaveLength(2)
  })

  it('drops an asynchronous Branch suggestion when the conversation advances before it returns', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-review-stale'))
    const active = start(session)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let captured = false
    let finished!: () => void
    const settled = new Promise<void>((resolve) => { finished = resolve })
    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        captured = true
        await gate
        const text = '{"action":"suggest_branch","confidence":0.91,"reason":"Parallel topic"}'
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        finished()
      }
    }())
    const service = ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
    }
    service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
    const target = appendClosedTurn(session, 1, 'temporary side topic', 'side answer')
    await vi.waitFor(() => { expect(captured).toBe(true) })

    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'continue in the original thread' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    release()
    await settled
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(session.events.some(event => event.type === 'contextify/branch-review'
      && event.data.turnEndSeq === target.boundary)).toBe(false)
    expect(ctx.contextify.get(active.agent).branchSuggestion).toBeUndefined()
  })

  it('generates review-only recommendations through one direct tool-free LLM call', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('recommendation'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    const turn = appendClosedTurn(session, 1, 'old requirement', 'new answer', {
      provider: 'walkthrough', model: 'seeded-demo',
    })
    let captured: GenerateOptions | undefined
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        captured = options
        const text = JSON.stringify({
          exclude: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, reason: 'Superseded' }],
          include: [], archive: [],
        })
        yield { type: 'block-start', index: 0, blockType: 'reasoning' }
        yield { type: 'reasoning-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'reasoning', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const view = ctx.contextify.get(active.agent)
    const before = session.seq

    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphRevision: page.revision,
      activeSessionId: session.id,
    }, 'x'.repeat(200_000))

    expect(proposal.selection).toMatchObject([{ action: 'exclude', reason: 'Superseded' }])
    expect(captured?.tools).toBeUndefined()
    expect(captured?.maxTokens).toBeLessThanOrEqual(800)
    expect(captured?.temperature).toBe(0)
    expect(captured?.reasoningEffort).toBe(ReasoningEffortId('off'))
    expect(JSON.stringify(captured?.messages).length).toBeLessThan(102_000)
    expect(proposal.mode).toBe('fast')
    expect(JSON.stringify(captured?.messages)).toContain('recent-active')
    expect(ctx.sessions.list()).toHaveLength(1)
    expect(session.seq).toBe(before)
  })

  it('rejects a recommendation when any Session in the reviewed family changes during the run', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('recommend-stale-root'))
    start(root)
    const prefix = appendClosedTurn(root, 1, 'prefix', 'answer')
    const activeSession = ctx.sessions.fork(root, prefix.boundary, SessionId('recommend-stale-active'))
    const active = start(activeSession)
    const sibling = ctx.sessions.fork(root, prefix.boundary, SessionId('recommend-stale-sibling'))
    start(sibling)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        await gate
        const text = '{"exclude":[],"include":[],"archive":[]}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const view = ctx.contextify.get(active.agent)
    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const pending = ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphRevision: page.revision,
      activeSessionId: activeSession.id,
    })
    appendClosedTurn(sibling, 2, 'new sibling fact')
    release()

    await expect(pending).rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_GRAPH' })
  })

  it('migrates a legacy same-Session plan to v3 Natural before compilation', async () => {
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

    expect(view.plan).toMatchObject({ version: 3, revision: 2, excluded: [], included: [], replacements: [] })
    expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages)
      .toEqual(session.deriveMessages())
  })

  it('normalizes a v2 plan in memory and writes v3 only on the next mutation', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('v2-plan'))
    session.append('contextify/plan', {
      kind: 'contextify/plan', version: 2, revision: 8, stateRevision: 8,
      history: { past: [7], future: [] }, excluded: [], included: [],
    } as never)
    const turn = appendClosedTurn(session, 1, 'v2 prompt')
    const planEventsBefore = session.events.filter(event => event.type === 'contextify/plan').length
    const active = start(session)

    expect(session.events.filter(event => event.type === 'contextify/plan')).toHaveLength(planEventsBefore)
    expect(ctx.contextify.get(active.agent).plan).toMatchObject({
      version: 3, revision: 8, stateRevision: 8, replacements: [],
    })
    const changed = await ctx.contextify.setNodeMode(
      active.agent, { revision: 8 }, { sessionId: session.id, seq: turn.userSeq }, 'exclude',
    )
    expect(changed.plan).toMatchObject({ version: 3, revision: 9 })
    expect(session.events.findLast(event => event.type === 'contextify/plan')?.data.version).toBe(3)
  })

  it('archives and restores one message without changing the graph node or its edges', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('placeholder'))
    const active = start(session)
    const turn = appendClosedTurn(session, 1, 'private requirement', 'public answer')
    const initial = ctx.contextify.get(active.agent)
    const graphBefore = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const nodeBefore = graphBefore.records.find(node => node.owner.seq === turn.userSeq)!

    const replaced = await ctx.contextify.archiveNode(
      active.agent,
      { revision: initial.plan.revision },
      nodeBefore.owner,
      'Obsolete requirement',
    )
    expect(replaced.plan.replacements).toMatchObject([{
      nodeId: nodeBefore.id, role: 'user', kind: 'placeholder', reason: 'Obsolete requirement',
    }])
    expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages
      .map(message => message.content)).toEqual(expect.arrayContaining([
      [{ type: 'text', text: CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT }],
    ]))
    expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text))
      .not.toContain('private requirement')

    const graphAfter = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const nodeAfter = graphAfter.records.find(node => node.id === nodeBefore.id)!
    expect(nodeAfter).toMatchObject({
      id: nodeBefore.id,
      owner: nodeBefore.owner,
      branchAtSeq: nodeBefore.branchAtSeq,
      replacement: {
        preview: CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT, original: 'private requirement',
        originalAvailable: true, role: 'user',
      },
    })
    expect(graphAfter.edges).toEqual(graphBefore.edges)

    const restored = await ctx.contextify.restoreNode(
      active.agent, { revision: replaced.plan.revision }, nodeBefore.owner,
    )
    expect(restored.plan.replacements).toEqual([])
    expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text))
      .toContain('private requirement')
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

  it('restores original semantics after an off-path placeholder is included', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('restore-off-path-root'))
    start(root)
    const prefix = appendClosedTurn(root, 1, 'prefix', 'answer')
    const activeSession = ctx.sessions.fork(root, prefix.boundary, SessionId('restore-off-path-active'))
    const active = start(activeSession)
    const sibling = ctx.sessions.fork(root, prefix.boundary, SessionId('restore-off-path-sibling'))
    start(sibling)
    const siblingTurn = appendClosedTurn(sibling, 2, 'original sibling semantics')
    const initial = ctx.contextify.get(active.agent)
    const replaced = await ctx.contextify.archiveNode(
      active.agent, { revision: initial.plan.revision },
      { sessionId: sibling.id, seq: siblingTurn.userSeq }, 'obsolete',
    )
    const included = await ctx.contextify.setNodeMode(
      active.agent, { revision: replaced.plan.revision },
      { sessionId: sibling.id, seq: siblingTurn.userSeq }, 'include',
    )
    expect(ctx.contextCompiler.compile({ session: activeSession, turn: 2, step: 1 }).messages
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text))
      .toContain(CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT)

    await ctx.contextify.restoreNode(
      active.agent, { revision: included.plan.revision },
      { sessionId: sibling.id, seq: siblingTurn.userSeq },
    )
    const compiledText = ctx.contextCompiler.compile({ session: activeSession, turn: 2, step: 1 }).messages
      .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text)
    expect(compiledText).toContain('original sibling semantics')
    expect(compiledText).not.toContain(CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT)
  })

  it('rejects accepted recommendations after a sibling changes', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('accept-stale-root'))
    start(root)
    const prefix = appendClosedTurn(root, 1, 'prefix')
    const activeSession = ctx.sessions.fork(root, prefix.boundary, SessionId('accept-stale-active'))
    const active = start(activeSession)
    const sibling = ctx.sessions.fork(root, prefix.boundary, SessionId('accept-stale-sibling'))
    start(sibling)
    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const view = ctx.contextify.get(active.agent)
    appendClosedTurn(sibling, 2, 'late sibling change')

    await expect(ctx.contextify.setNodeModes(
      active.agent,
      { revision: view.plan.revision },
      [{ node: { sessionId: activeSession.id, seq: prefix.userSeq }, mode: 'exclude' }],
      page.revision,
    )).rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_GRAPH' })
    expect(ctx.contextify.get(active.agent).plan.revision).toBe(view.plan.revision)
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

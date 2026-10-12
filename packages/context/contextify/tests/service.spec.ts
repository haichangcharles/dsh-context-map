import { SessionSeq } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm/brand'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type AgentOptions, type AgentStatus } from '@deepseek-ai/dsh-agent'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import LlmRuntime, {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import ContextifyService from '../src/index.ts'
import { childMessageAdmissible, startSourceBoundContinuable } from '../src/revision-lineage.ts'
import { projectSessionFamily } from '../src/family.ts'
import type { FastRecommendationInput } from '../src/fast-recommendation.ts'
import { contextEditsFromFamily } from '../src/personal-context-policy.ts'
import { compileContextify } from '../src/plan.ts'
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
  const inbox = createInboxStub()
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
    session.append('assistant/message', { stream: [],
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
  const stored = new Map<SessionId, { readonly inspection: SessionInspection; readonly revision: string }>()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ContextCompilerRegistry)
  await ctx.plugin(SubagentRuntime)
  ctx.provide('sessionPersistence', {
    list: async () => [
      ...ctx.sessions.list().map(session => ({ header: session.header })),
      ...[...stored.values()].map(({ inspection, revision }) => ({ header: inspection.meta, revision })),
    ],
    open: async (id: SessionId) => {
      const item = stored.get(id)
      if (item === undefined) throw new Error(`missing stored Session ${id}`)
      return { header: item.inspection.meta, inheritedEventCount: item.inspection.inheritedEventCount,
        read: async () => ({ events: item.inspection.events, eventState: 'detached' }),
        close: async () => {},
      }
    },
    inspect: async (id: string): Promise<SessionInspection> => {
      const session = ctx.sessions.get(SessionId(id))
      if (session === undefined) throw new Error(`missing Session ${id}`)
      return { meta: session.header, inheritedEventCount: session.inheritedEventCount, events: session.snapshotEvents() }
    },
  } as never)
  await ctx.plugin(ContextifyService)
  const contextify = ctx.contextify as unknown as {
    promptSettings: () => ContextifyPromptSettings
  }
  // Branch-focused cases explicitly enable the fresh-Profile default. Keep
  // unrelated service cases free from background classifier traffic.
  contextify.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false })
  const start = (session: Session, options?: AgentOptions) => {
    const stub = stubAgent(session, options)
    ctx.agents.register(stub.agent)
    agentEvents(ctx, stub.agent).emit('agent/session-start', { source: 'startup' })
    return stub
  }
  return { ctx, start, stored }
}

abstract class OffReasoningAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider, id: model, name: model,
      reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] },
    })
  }
}

function branchDecisionAdapter(text: string): LlmAdapter {
  return new class extends OffReasoningAdapter {
    override async * stream(): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }()
}

describe('ContextifyService native Session family', () => {
  it('learns one positive Branch preference from a successful manual Context Map fork', async () => {
    const { ctx, start } = await harness()
    try {
      const source = ctx.sessions.create(SessionId('manual-branch-source'))
      const turn = appendClosedTurn(source, 1, 'Plan a long report', 'Start with the outline')
      const child = ctx.sessions.fork(source, SessionSeq(turn.boundary), SessionId('manual-branch-child'))
      const { agent } = start(source)
      await ctx.contextify.recordManualBranch(agent, child.id, 'contextify-client')
      await ctx.contextify.recordManualBranch(agent, child.id, 'contextify-client')
      expect(source.snapshotEvents().filter(event => event.type === 'contextify/manual-branch')).toHaveLength(1)
      expect((await ctx.contextify.stewardProfile(agent)).branch).toEqual({ acceptRate: 0.6, support: 1 })
      await expect(ctx.contextify.recordManualBranch(agent, SessionId('missing-child'),
        'contextify-client')).rejects.toThrow(/unavailable/)
    } finally { await ctx.fiber.dispose() }
  })

  it('carries confirmed Context policy across unrelated Sessions in one Profile', async () => {
    const { ctx, start, stored } = await harness()
    try {
      const archivalCtx = new Context()
      await archivalCtx.plugin(SessionStore)
      const archived = archivalCtx.sessions.create(SessionId('policy-archived-project'))
      appendClosedTurn(archived, 1, 'Finish the archived project', 'Done')
      archived.append('contextify/route-choice', {
        routeKey: 'archived-return', action: 'return', choice: 'accept',
        base: { activeSessionId: archived.id, graphRevision: 'archived', planRevision: 0 },
        targetSessionId: archived.id, uiOrigin: 'contextify-client',
      })
      stored.set(archived.id, { inspection: { meta: archived.header,
        inheritedEventCount: archived.inheritedEventCount, events: archived.snapshotEvents() },
      revision: 'archived-v1' })
      await archivalCtx.fiber.dispose()
      const earlier = ctx.sessions.create(SessionId('policy-earlier-project'))
      appendClosedTurn(earlier, 1, 'Plan the first project', 'Start with an outline')
      const current = ctx.sessions.create(SessionId('policy-current-project'))
      appendClosedTurn(current, 1, 'Plan the second project', 'Start with an outline')
      const { agent } = start(current)
      const record = (index: number) => earlier.append('contextify/route-choice', {
        routeKey: `prior-branch-${String(index)}`, action: 'branch', choice: 'reject',
        base: { activeSessionId: earlier.id, graphRevision: 'earlier', planRevision: 0 },
        uiOrigin: 'contextify-client',
      })
      for (let index = 0; index < 3; index += 1) record(index)
      const first = await ctx.contextify.stewardProfile(agent)
      expect(first.branch.support).toBe(3)
      expect(first.return.support).toBe(1)
      record(3)
      const updated = await ctx.contextify.stewardProfile(agent)
      expect(updated.branch).toEqual({ acceptRate: 0.25, support: 4 })
      expect(updated.rules).toContainEqual(expect.objectContaining({
        action: 'branch', tendency: 'avoid', support: 4,
      }))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('transfers confirmed Web Context selection across unrelated Sessions', async () => {
    const { ctx, start } = await harness()
    try {
      const earlier = ctx.sessions.create(SessionId('personal-web-earlier-project'))
      const { agent: earlierAgent } = start(earlier)
      const appendWeb = (session: Session, turn: number, action: 'web_fetch' | 'web_search') => {
        const callId = CallId(`${session.id}-${String(turn)}-${action}`)
        session.append('turn/start', { turn })
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `Compare warranty sources ${String(turn)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        session.append('assistant/message', { stream: [], turn, step: 1,
          message: createAssistantMessage({
            content: [{ type: 'tool-call', id: callId, name: action,
              arguments: '{"query":"warranty terms"}' }],
            source: { provider: 'mock', model: 'mock' },
          }),
        }, { surfaceOp: 'append' })
        const call = session.append('tool/call', { turn, step: 1, callId,
          name: action, arguments: '{"query":"warranty terms"}' })
        const result = session.append('tool/result', { turn, step: 1,
          message: createToolResultMessage({ callId,
            content: [{ type: 'text', text: `${action} warranty evidence ${String(turn)}` }],
            isError: false }),
        }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
        return result.seq
      }
      for (let turn = 1; turn <= 5; turn += 1) {
        const seq = appendWeb(earlier, turn, 'web_fetch')
        const view = ctx.contextify.get(earlierAgent)
        await ctx.contextify.setNodeMode(earlierAgent, { revision: view.plan.revision },
          { sessionId: earlier.id, seq }, 'exclude', 'contextify-client')
      }
      const current = ctx.sessions.create(SessionId('personal-web-current-project'))
      const fetchSeq = appendWeb(current, 1, 'web_fetch')
      const searchSeq = appendWeb(current, 2, 'web_search')
      const { agent } = start(current, { provider: 'mock', model: 'mock' })
      let packet: { preferenceExamples: unknown[] } | undefined
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          const block = options.messages[0]?.content.find(item => item.type === 'text')
          if (block?.type === 'text') packet = JSON.parse(block.text.split('Conversation graph JSON:\n')[1] ?? '{}')
          const text = '{"exclude":[],"include":[],"archive":[]}'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const view = ctx.contextify.get(agent)
      const page = await ctx.contextify.familyPage(agent, undefined, 100)
      const proposal = await ctx.contextify.recommend(agent, {
        planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: current.id,
      }, 'Compare warranty sources')
      expect(proposal.selection).toContainEqual(expect.objectContaining({
        nodeId: `${current.id}:${String(fetchSeq)}`, action: 'exclude',
      }))
      expect(proposal.selection).not.toContainEqual(expect.objectContaining({
        nodeId: `${current.id}:${String(searchSeq)}`, action: 'exclude',
      }))
      expect(packet?.preferenceExamples).toEqual([])
      for (let index = 0; index < 3; index += 1) {
        const oldView = ctx.contextify.get(earlierAgent)
        ctx.contextify.undo(earlierAgent, { revision: oldView.plan.revision })
      }
      const afterUndo = await ctx.contextify.recommend(agent, {
        planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: current.id,
      }, 'Compare warranty sources')
      expect(afterUndo.selection).not.toContainEqual(expect.objectContaining({
        nodeId: `${current.id}:${String(fetchSeq)}`, action: 'exclude',
      }))
    } finally { await ctx.fiber.dispose() }
  })

  it('adapts active Web exclusion advice after five confirmed reversals in native Session history', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('web-context-reversal'))
      const { agent } = start(session, { provider: 'mock', model: 'mock' })
      const webResults: number[] = []
      for (let turn = 1; turn <= 14; turn += 1) {
        const callId = CallId(`web-context-reversal-${String(turn)}`)
        session.append('turn/start', { turn })
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: `Compare warranty terms ${String(turn)}` }],
          source: { kind: 'user' },
        }), { surfaceOp: 'append' })
        session.append('assistant/message', { stream: [], turn, step: 1,
          message: createAssistantMessage({
            content: [{ type: 'tool-call', id: callId, name: 'web_fetch',
              arguments: `{"url":"https://example.org/terms/${String(turn)}"}` }],
            source: { provider: 'mock', model: 'mock' },
          }),
        }, { surfaceOp: 'append' })
        const call = session.append('tool/call', { turn, step: 1, callId,
          name: 'web_fetch', arguments: `{"url":"https://example.org/terms/${String(turn)}"}` })
        const result = session.append('tool/result', { turn, step: 1,
          message: createToolResultMessage({ callId,
            content: [{ type: 'text', text: `Warranty terms source ${String(turn)}` }], isError: false }),
        }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
        webResults.push(result.seq)
      }
      // Earlier agent-side exclusions are not user preference evidence. The
      // Client restores eight sources, then excludes five later sources.
      for (const seq of webResults.slice(0, 8)) {
        const view = ctx.contextify.get(agent)
        await ctx.contextify.setNodeMode(agent, { revision: view.plan.revision },
          { sessionId: session.id, seq }, 'exclude')
      }
      for (const seq of webResults.slice(0, 8)) {
        const view = ctx.contextify.get(agent)
        await ctx.contextify.setNodeMode(agent, { revision: view.plan.revision },
          { sessionId: session.id, seq }, 'natural', 'contextify-client')
      }
      for (const seq of webResults.slice(8, 13)) {
        const view = ctx.contextify.get(agent)
        await ctx.contextify.setNodeMode(agent, { revision: view.plan.revision },
          { sessionId: session.id, seq }, 'exclude', 'contextify-client')
      }
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          const text = '{"exclude":[],"include":[],"archive":[]}'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const view = ctx.contextify.get(agent)
      const page = await ctx.contextify.familyPage(agent, undefined, 100)
      const proposal = await ctx.contextify.recommend(agent, {
        planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: session.id,
      }, 'Compare warranty terms')
      const target = `${session.id}:${String(webResults[13])}`
      expect(proposal.selection).toContainEqual(expect.objectContaining({
        nodeId: target, action: 'exclude',
      }))
      expect(view.plan.excluded.map(item => item.nodeId)).not.toContain(target)
      const accepted = await ctx.contextify.setNodeModes(agent,
        { revision: view.plan.revision },
        [{ node: { sessionId: session.id, seq: webResults[13]! }, mode: 'exclude' }],
        page.revision, 'contextify-client')
      expect(accepted.plan.excluded.map(item => item.nodeId)).toContain(target)
      expect(ctx.contextCompiler.compile({ session, turn: 15, step: 1 }).messages
        .flatMap(message => message.content).some(block => block.type === 'tool-result'
          && block.content.some(item => item.type === 'text'
            && item.text.includes('Warranty terms source 14')))).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('learns an explicit Web restore as a positive Context choice', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('web-restore-positive'))
      const { agent } = start(session)
      const callId = CallId('web-restore-fetch')
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Compare these pages' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('assistant/message', { stream: [], turn: 1, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'web_fetch', arguments: '{"url":"https://example.org"}' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      const call = session.append('tool/call', { turn: 1, step: 1, callId,
        name: 'web_fetch', arguments: '{"url":"https://example.org"}' })
      const result = session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId,
          content: [{ type: 'text', text: 'Official terms' }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const ref = { sessionId: session.id, seq: result.seq }
      const initial = ctx.contextify.get(agent)
      const excluded = await ctx.contextify.setNodeMode(agent,
        { revision: initial.plan.revision }, ref, 'exclude', 'contextify-client')
      await ctx.contextify.setNodeMode(agent,
        { revision: excluded.plan.revision }, ref, 'natural', 'contextify-client')
      const inspection = { meta: session.header, events: session.snapshotEvents(),
        inheritedEventCount: session.inheritedEventCount }
      const graph = projectSessionFamily({ activeSessionId: session.id, sessions: [inspection] })
      expect(contextEditsFromFamily(graph, new Map([[session.id, inspection]]))
        .map(edit => [edit.mode, edit.webAction])).toEqual([
        ['exclude', 'web_fetch'], ['include', 'web_fetch'],
      ])
      expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages
        .flatMap(message => message.content).some(block => block.type === 'tool-result')).toBe(true)
    } finally { await ctx.fiber.dispose() }
  })

  it('reads cold family members through a handle and closes it even when reading fails', async () => {
    const { ctx, start } = await harness()
    try {
      const cold = ctx.sessions.prepare(SessionId('cold-family-root'))
      const turn = appendClosedTurn(cold, 1, 'retained parent', 'parent answer')
      const detach = ctx.sessions.enter(cold)
      ctx.effect(() => detach)
      const active = ctx.sessions.fork(cold, SessionSeq(turn.boundary), SessionId('live-family-child'))
      detach()
      const { agent } = start(active)
      const close = vi.fn(async () => {})
      const read = vi.fn(async () => ({ events: cold.snapshotEvents() }))
      const persistence = ctx.sessionPersistence as unknown as {
        list: () => Promise<unknown[]>
        open: (id: SessionId, mode: string) => Promise<unknown>
      }
      persistence.list = async () => [{ header: cold.header }, ...ctx.sessions.list().map(session => ({ header: session.header }))]
      persistence.open = async (id, mode) => {
        expect(id).toBe(cold.id)
        expect(mode).toBe('read')
        return { header: cold.header, inheritedEventCount: cold.inheritedEventCount, read, close }
      }
      const page = await ctx.contextify.familyPage(agent)
      expect(page.rootSessionId).toBe(cold.id)
      expect(page.totalNodeCount).toBe(2)
      expect(read).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
      read.mockRejectedValueOnce(new Error('cold read failed'))
      await expect(ctx.contextify.familyPage(agent)).rejects.toThrow('cold read failed')
      expect(close).toHaveBeenCalledTimes(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not launch Branch classification when the Profile setting is disabled', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-disabled'))
    start(session, { provider: 'mock', model: 'mock' })
    let calls = 0
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        calls += 1
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())

    appendClosedTurn(session, 1, 'unrelated question', 'answer')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(calls).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'contextify/branch-review')).toBe(false)
  })

  it('records a silent Keep result when the Branch classifier returns malformed output', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-malformed'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'not-json' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'not-json' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const service = ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
    }
    service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })

    const turn = appendClosedTurn(session, 1, 'unrelated question', 'answer')

    await vi.waitFor(() => {
      const review = session.snapshotEvents().find(event => event.type === 'contextify/branch-review')
      expect(review?.type === 'contextify/branch-review' && review.data).toEqual({
        suggestion: null, turnEndSeq: turn.boundary,
      })
    })
    expect(ctx.contextify.get(active.agent).branchSuggestion).toBeUndefined()
  })

  it('starts Branch classification from the first human input before the main answer completes', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-concurrent'))
    start(session, { provider: 'mock', model: 'mock' })
    appendClosedTurn(session, 1, 'design the observability layer', 'use structured traces')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let classifierStarted = false
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        classifierStarted = true
        await gate
        const text = '{"action":"suggest_branch","confidence":0.95,"reason":"Unrelated weather topic"}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const service = ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
    }
    service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })

    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'what is the weather in Shanghai?' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await vi.waitFor(() => { expect(classifierStarted).toBe(true) })
    expect(session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.turn === 2)).toBe(false)

    session.append('assistant/message', { stream: [],
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'It is sunny.' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    release()

    await vi.waitFor(() => {
      expect(session.snapshotEvents().some(event => event.type === 'contextify/branch-review'
        && event.data.turnEndSeq === end.seq && event.data.suggestion !== null)).toBe(true)
    })
  })

  it('uses a prior UI Keep choice to suppress a similar marginal Branch suggestion', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('personal-branch-threshold'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    const prior = appendClosedTurn(session, 1, 'compare warranty rules in a new region', 'prior answer')
    const priorSuggestion = {
      id: 'prior-suggestion', sourceSessionId: session.id, turn: 1,
      boundaryBefore: 0, boundaryAfter: prior.boundary,
      input: { sessionId: session.id, seq: prior.userSeq },
      output: { sessionId: session.id, seq: prior.boundary - 1 },
      inputPreview: 'compare warranty rules in a new region', outputPreview: 'prior answer',
      confidence: 0.9, reason: 'parallel topic',
      planRevision: ctx.contextify.get(active.agent).plan.revision, graphRevision: 'prior',
    }
    session.append('contextify/branch-review', { suggestion: priorSuggestion, turnEndSeq: prior.boundary })
    session.append('contextify/branch-choice', {
      suggestionId: priorSuggestion.id, choice: 'keep', turnEndSeq: prior.boundary,
      uiOrigin: 'contextify-client',
    })
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = '{"action":"suggest_branch","confidence":0.82,"reason":"New region"}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const service = ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
    const next = appendClosedTurn(session, 2, 'compare a new warranty region', 'new answer')

    await vi.waitFor(() => {
      const review = session.snapshotEvents().find(event => event.type === 'contextify/branch-review'
        && event.data.turnEndSeq === next.boundary)
      expect(review?.type === 'contextify/branch-review' && review.data.suggestion).toBe(null)
    })
  })

  it('uses a reviewed Keep from another Session family for a new project Branch suggestion', async () => {
    const { ctx, start } = await harness()
    try {
      const earlier = ctx.sessions.create(SessionId('branch-style-earlier-project'))
      const prior = appendClosedTurn(earlier, 1, 'compare warranty rules in a new region',
        'private earlier project answer')
      const suggestion = {
        id: 'cross-family-prior-suggestion', sourceSessionId: earlier.id, turn: 1,
        boundaryBefore: 0, boundaryAfter: prior.boundary,
        input: { sessionId: earlier.id, seq: prior.userSeq },
        output: { sessionId: earlier.id, seq: prior.boundary - 1 },
        inputPreview: 'compare warranty rules in a new region', outputPreview: 'private earlier project answer',
        confidence: 0.9, reason: 'parallel topic', planRevision: 0, graphRevision: 'prior',
      }
      earlier.append('contextify/branch-review', { suggestion, turnEndSeq: prior.boundary })
      earlier.append('contextify/branch-choice', {
        suggestionId: suggestion.id, choice: 'keep', turnEndSeq: prior.boundary,
        uiOrigin: 'contextify-client',
      })
      const current = ctx.sessions.create(SessionId('branch-style-new-project'))
      start(current, { provider: 'mock', model: 'mock' })
      let modelRequest: GenerateOptions | undefined
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          modelRequest = options
          const text = '{"action":"suggest_branch","confidence":0.82,"reason":"New region"}'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const service = ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
      service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
      const next = appendClosedTurn(current, 1, 'compare a new warranty region', 'new answer')

      await vi.waitFor(() => {
        const review = current.snapshotEvents().find(event => event.type === 'contextify/branch-review'
          && event.data.turnEndSeq === next.boundary)
        expect(review?.type === 'contextify/branch-review' && review.data.suggestion).toBe(null)
      })
      expect(JSON.stringify(modelRequest?.messages)).not.toContain('private earlier project answer')
    } finally { await ctx.fiber.dispose() }
  })

  it('uses reviewed Moves from another Session family to surface a weak generic Keep', async () => {
    const { ctx, start } = await harness()
    try {
      const earlier = ctx.sessions.create(SessionId('branch-style-fine-earlier-project'))
      for (let turn = 1; turn <= 4; turn += 1) {
        const prior = appendClosedTurn(earlier, turn,
          'compare warranty rules in a new region', 'prior answer')
        const suggestion = {
          id: `cross-family-move-${String(turn)}`, sourceSessionId: earlier.id, turn,
          boundaryBefore: prior.userSeq - 2, boundaryAfter: prior.boundary,
          input: { sessionId: earlier.id, seq: prior.userSeq },
          output: { sessionId: earlier.id, seq: prior.boundary - 1 },
          inputPreview: 'compare warranty rules in a new region', outputPreview: 'prior answer',
          confidence: 0.9, reason: 'parallel topic', planRevision: 0, graphRevision: 'prior',
        }
        earlier.append('contextify/branch-review', { suggestion, turnEndSeq: prior.boundary })
        earlier.append('contextify/branch-choice', {
          suggestionId: suggestion.id, choice: 'move', turnEndSeq: prior.boundary,
          uiOrigin: 'contextify-client',
        })
      }
      const current = ctx.sessions.create(SessionId('branch-style-fine-new-project'))
      start(current, { provider: 'mock', model: 'mock' })
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(
        '{"action":"keep","confidence":0.55,"reason":"Probably one topic"}'))
      const service = ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
      service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
      const next = appendClosedTurn(current, 1, 'compare a new warranty region', 'new answer')

      await vi.waitFor(() => {
        const review = current.snapshotEvents().find(event => event.type === 'contextify/branch-review'
          && event.data.turnEndSeq === next.boundary)
        const suggestion = review?.type === 'contextify/branch-review' ? review.data.suggestion : null
        expect(suggestion?.reason).toContain('earlier')
      })
    } finally { await ctx.fiber.dispose() }
  })

  it('surfaces a reviewable Branch card after similar direct Moves despite a weak generic Keep', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('personal-branch-keep-override'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    for (let turn = 1; turn <= 4; turn += 1) {
      const prior = appendClosedTurn(session, turn, 'compare warranty rules in a new region', 'prior answer')
      const suggestion = {
        id: `prior-move-${String(turn)}`, sourceSessionId: session.id, turn,
        boundaryBefore: prior.userSeq - 2, boundaryAfter: prior.boundary,
        input: { sessionId: session.id, seq: prior.userSeq },
        output: { sessionId: session.id, seq: prior.boundary - 1 },
        inputPreview: 'compare warranty rules in a new region', outputPreview: 'prior answer',
        confidence: 0.9, reason: 'parallel topic',
        planRevision: ctx.contextify.get(active.agent).plan.revision, graphRevision: `prior-${String(turn)}`,
      }
      session.append('contextify/branch-review', { suggestion, turnEndSeq: prior.boundary })
      session.append('contextify/branch-choice', {
        suggestionId: suggestion.id, choice: 'move', turnEndSeq: prior.boundary,
        uiOrigin: 'contextify-client',
      })
    }
    ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(
      '{"action":"keep","confidence":0.55,"reason":"Probably one topic"}'))
    const service = ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
    const next = appendClosedTurn(session, 5, 'compare a new warranty region', 'new answer')

    await vi.waitFor(() => {
      const review = session.snapshotEvents().find(event => event.type === 'contextify/branch-review'
        && event.data.turnEndSeq === next.boundary)
      const suggestion = review?.type === 'contextify/branch-review' ? review.data.suggestion : null
      expect(suggestion?.reason).toContain('earlier')
    })
    expect(ctx.contextify.get(active.agent).branchSuggestion).toBeDefined()
  })

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
      expect(session.snapshotEvents().some(event => event.type === 'contextify/branch-review'
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

    const preparation = ctx.contextify.prepareBranchSuggestion(active.agent, suggestion!.id)
    expect(preparation).toEqual({ sourceSessionId: session.id, beforeSeq: target.boundary - 3 })
    // Contextify asks the Host for the prefix immediately before the reviewed
    // Turn. The core primitive takes an inclusive boundary, hence -1 here.
    const nativeChild = ctx.sessions.fork(
      session,
      SessionSeq(preparation.beforeSeq - 1),
      SessionId('native-branch-child'),
    )
    start(nativeChild)
    const first = await ctx.contextify.acceptBranchSuggestion(
      active.agent, suggestion!.id, nativeChild.id, 'contextify-client')
    const second = await ctx.contextify.acceptBranchSuggestion(active.agent, suggestion!.id, nativeChild.id)
    expect(second).toEqual(first)
    expect(session.snapshotEvents().filter(event => event.type === 'contextify/branch-choice'
      && event.data.suggestionId === suggestion!.id)).toHaveLength(1)
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-choice')?.data)
      .toMatchObject({ choice: 'move', turnEndSeq: target.boundary, uiOrigin: 'contextify-client' })
    expect(() => { ctx.contextify.keepBranchSuggestion(active.agent, suggestion!.id) })
      .toThrow(/already moved/)
    const child = ctx.sessions.get(first.childSessionId)!
    expect(child.header.parentSession).toBe(session.id)
    expect(child.snapshotEvents().filter(event => event.type === 'user/message')
      .filter(event => event.data.source.kind === 'user').at(-1)?.data.content)
      .toEqual([{ type: 'text', text: 'temporary side topic' }])
    expect(child.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1)?.data.message.content)
      .toEqual([{ type: 'text', text: 'side answer' }])
    expect(ctx.contextify.get(active.agent).plan.replacements).toHaveLength(2)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(child.snapshotEvents().some(event => event.type === 'contextify/branch-review')).toBe(false)
  })

  it('rejects relocation into a bare live Session without a native Agent', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-native-agent-source'))
    const active = start(session)
    const service = ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
    }
    service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = '{"action":"suggest_branch","confidence":0.99,"reason":"Parallel topic"}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    appendClosedTurn(session, 1, 'main topic', 'main answer')
    const target = appendClosedTurn(session, 2, 'side topic', 'side answer')
    await vi.waitFor(() => { expect(ctx.contextify.get(active.agent).branchSuggestion).toBeDefined() })
    const suggestion = ctx.contextify.get(active.agent).branchSuggestion!
    const bare = ctx.sessions.fork(session, SessionSeq(target.boundary - 4), SessionId('bare-branch-child'))

    await expect(ctx.contextify.acceptBranchSuggestion(active.agent, suggestion.id, bare.id))
      .rejects.toThrow(/native Agent/)
  })

  it('exposes an explicit Branch request tool even when automatic review is disabled', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-explicit-tool'))
    const active = start(session)
    appendClosedTurn(session, 1, 'main topic', 'main answer')
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Please move this Q&A to a new branch' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(ctx.tools.schemas(active.agent).map(tool => tool.name)).toContain('request_context_branch')
    const result = await ctx.tools.execute({
      agent: active.agent,
      signal: new AbortController().signal,
      callId: CallId('request-branch'),
      name: 'request_context_branch',
      arguments: { reason: 'The user explicitly requested a branch.' },
    })
    expect(result.isError).toBe(false)
    session.append('assistant/message', { stream: [],
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'I will offer a branch confirmation.' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    const end = session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    await vi.waitFor(() => {
      expect(ctx.contextify.get(active.agent).branchSuggestion).toMatchObject({
        boundaryAfter: end.seq,
        confidence: 1,
        reason: 'The user explicitly requested a branch.',
      })
    })
    const suggestion = ctx.contextify.get(active.agent).branchSuggestion!
    ctx.contextify.keepBranchSuggestion(active.agent, suggestion.id, 'contextify-client')
    ctx.contextify.keepBranchSuggestion(active.agent, suggestion.id)
    expect(session.snapshotEvents().filter(event => event.type === 'contextify/branch-choice'
      && event.data.suggestionId === suggestion.id)).toHaveLength(1)
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-choice')?.data)
      .toEqual({ suggestionId: suggestion.id, choice: 'keep', turnEndSeq: end.seq,
        uiOrigin: 'contextify-client' })
    expect(ctx.contextify.get(active.agent).branchSuggestion).toBeUndefined()
    expect(() => ctx.contextify.prepareBranchSuggestion(active.agent, suggestion.id))
      .toThrow(/already decided/)
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

    expect(session.snapshotEvents().some(event => event.type === 'contextify/branch-review'
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

    await ctx.contextify.presentRecommendation(active.agent, { ...proposal, selection: [] }, 'contextify-client')
    expect(session.seq).toBe(before)
    await ctx.contextify.presentRecommendation(active.agent, proposal, 'contextify-client')
    await ctx.contextify.presentRecommendation(active.agent, proposal, 'contextify-client')
    expect(session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-presented'))
      .toHaveLength(1)
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-presented')?.data)
      .toMatchObject({ mode: 'fast', base: proposal.base, uiOrigin: 'contextify-client',
        selection: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, action: 'exclude' }],
        archiveNodeIds: [] })
    const afterPresentation = await ctx.contextify.familyPage(active.agent, undefined, 100)
    expect(afterPresentation.revision).toBe(page.revision)

    await expect(ctx.contextify.dismissRecommendation(active.agent, {
      ...proposal, selection: [],
    }, 'contextify-client')).rejects.toThrow('unavailable')
    expect(session.seq).toBe(before + 1)
    await ctx.contextify.dismissRecommendation(active.agent, proposal, 'contextify-client')
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-dismissed')?.data)
      .toMatchObject({ mode: 'fast', base: proposal.base, uiOrigin: 'contextify-client',
        selection: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, action: 'exclude' }],
        archiveNodeIds: [] })
    expect(ctx.contextify.get(active.agent).plan.revision).toBe(view.plan.revision)
    await expect(ctx.contextify.dismissRecommendation(active.agent, proposal, 'contextify-client'))
      .rejects.toThrow('unavailable')
    const afterDismiss = await ctx.contextify.familyPage(active.agent, undefined, 100)
    await ctx.contextify.recommend(active.agent, { ...proposal.base, graphRevision: afterDismiss.revision })

    const accepted = await ctx.contextify.setNodeModes(active.agent,
      { revision: view.plan.revision },
      [{ node: { sessionId: session.id, seq: turn.userSeq }, mode: 'exclude' }],
      afterDismiss.revision, 'contextify-client')
    expect(accepted.plan.excluded).toHaveLength(1)
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')?.data)
      .toMatchObject({ origin: 'recommendation', uiOrigin: 'contextify-client',
        beforePlanRevision: view.plan.revision,
        afterPlanRevision: accepted.plan.revision,
        mutations: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, mode: 'exclude' }],
        proposal: { selection: [{ nodeId: `${session.id}:${String(turn.userSeq)}`,
          action: 'exclude' }] } })
  })

  it('does not learn a negative choice when a reviewed proposal became stale', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('stale-dismissal'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    const turn = appendClosedTurn(session, 1, 'first request', 'first answer', {
      provider: 'walkthrough', model: 'seeded-demo',
    })
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({
          exclude: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, reason: 'Old request' }],
          include: [], archive: [],
        })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const view = ctx.contextify.get(active.agent)
    const graph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphRevision: graph.revision,
      activeSessionId: session.id,
    })
    appendClosedTurn(session, 2, 'new request')
    await ctx.contextify.presentRecommendation(active.agent, proposal, 'contextify-client')
    expect(session.snapshotEvents().some(event => event.type === 'contextify/recommendation-presented'))
      .toBe(false)
    await ctx.contextify.dismissRecommendation(active.agent, proposal, 'contextify-client')
    expect(session.snapshotEvents().some(event => event.type === 'contextify/recommendation-dismissed'))
      .toBe(false)
    expect(ctx.contextify.get(active.agent).plan.revision).toBe(view.plan.revision)
  })

  it('records item-level Keep-current choices without fabricating opposite style edits', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('selective-review'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    const first = appendClosedTurn(session, 1, 'old preference', 'first answer')
    const second = appendClosedTurn(session, 2, 'current preference', 'second answer')
    const firstId = String(session.id) + ':' + String(first.userSeq)
    const secondId = String(session.id) + ':' + String(second.userSeq)
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({
          exclude: [
            { nodeId: firstId, reason: 'May be obsolete' },
            { nodeId: secondId, reason: 'May be obsolete' },
          ],
          include: [], archive: [],
        })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const before = ctx.contextify.get(active.agent)
    const graph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: before.plan.revision, graphRevision: graph.revision, activeSessionId: session.id,
    }, 'Draft the new regional comparison', 'fast', true)
    expect(proposal.selection.map(item => item.nodeId)).toEqual([firstId, secondId])
    await expect(ctx.contextify.setNodeModes(active.agent, { revision: before.plan.revision }, [],
      graph.revision, 'contextify-client', ['foreign'])).rejects.toThrow('declined items')
    expect(session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-reviewed'))
      .toHaveLength(0)

    const unchanged = await ctx.contextify.setNodeModes(active.agent,
      { revision: before.plan.revision }, [], graph.revision, 'contextify-client', [firstId, secondId])
    expect(unchanged.plan.revision).toBe(before.plan.revision)
    expect(unchanged.plan.excluded).toEqual([])
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-reviewed')?.data)
      .toMatchObject({ objective: 'Draft the new regional comparison',
        acceptedNodeIds: [], declinedNodeIds: [firstId, secondId] })
    const inspectionAfterKeep = { meta: session.header, events: session.snapshotEvents(),
      inheritedEventCount: session.inheritedEventCount }
    const editsAfterKeep = contextEditsFromFamily(projectSessionFamily({
      activeSessionId: session.id, sessions: [inspectionAfterKeep],
    }), new Map([[session.id, inspectionAfterKeep]]))
    expect(editsAfterKeep).toEqual([])

    const nextGraph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const next = await ctx.contextify.recommend(active.agent, {
      planRevision: before.plan.revision, graphRevision: nextGraph.revision, activeSessionId: session.id,
    }, 'Draft the new regional comparison')
    expect(next.selection).toEqual([])
  })

  it('applies only accepted items from a two-item Context review', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('partial-review'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    const first = appendClosedTurn(session, 1, 'old preference', 'first answer')
    const second = appendClosedTurn(session, 2, 'current preference', 'second answer')
    const firstId = String(session.id) + ':' + String(first.userSeq)
    const secondId = String(session.id) + ':' + String(second.userSeq)
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({
          exclude: [{ nodeId: firstId, reason: 'May be obsolete' },
            { nodeId: secondId, reason: 'May be obsolete' }],
          include: [], archive: [],
        })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const before = ctx.contextify.get(active.agent)
    const graph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: before.plan.revision, graphRevision: graph.revision, activeSessionId: session.id,
    })
    expect(proposal.selection.map(item => item.nodeId)).toEqual([firstId, secondId])
    const partial = await ctx.contextify.setNodeModes(active.agent,
      { revision: before.plan.revision },
      [{ node: { sessionId: session.id, seq: first.userSeq }, mode: 'exclude' }],
      graph.revision, 'contextify-client', [secondId])
    expect(partial.plan.excluded.map(item => item.nodeId)).toEqual([firstId])
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-reviewed')?.data)
      .toMatchObject({ acceptedNodeIds: [firstId], declinedNodeIds: [secondId] })
    const inspection = { meta: session.header, events: session.snapshotEvents(),
      inheritedEventCount: session.inheritedEventCount }
    const edits = contextEditsFromFamily(projectSessionFamily({
      activeSessionId: session.id, sessions: [inspection],
    }), new Map([[session.id, inspection]]))
    expect(edits.map(edit => [edit.mode, edit.weight]))
      .toEqual([['exclude', 0.5]])
  })

  it('suppresses a Fast Include suggestion opposed by a related direct UI Exclude', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('personal-context-root'))
    const prefix = appendClosedTurn(root, 1, 'compare products', 'initial comparison')
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('personal-context-active'))
    const active = start(activeSession, { provider: 'mock', model: 'mock' })
    const prior = appendClosedTurn(activeSession, 2, 'vendor regional repair terms', 'old source', {
      provider: 'mock', model: 'mock',
    })
    const sibling = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('personal-context-sibling'))
    start(sibling)
    const candidate = appendClosedTurn(sibling, 2, 'vendor regional repair terms', 'fresh source')
    const initial = ctx.contextify.get(active.agent)
    await ctx.contextify.setNodeMode(active.agent, { revision: initial.plan.revision },
      { sessionId: activeSession.id, seq: prior.userSeq }, 'exclude', 'contextify-client')
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({ exclude: [], include: [{
          nodeId: `${sibling.id}:${String(candidate.userSeq)}`, reason: 'Generic relevance',
        }], archive: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const view = ctx.contextify.get(active.agent)
    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphRevision: page.revision,
      activeSessionId: activeSession.id,
    }, 'vendor regional repair terms')
    expect(proposal.mode).toBe('fast')
    expect(proposal.selection).toEqual([])
    expect(proposal.proposedNodeIds).not.toContain(`${sibling.id}:${String(candidate.userSeq)}`)
  })

  it('proposes a matching off-path Include after a direct UI Include when the generic review is silent', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('personal-include-root'))
    const prefix = appendClosedTurn(root, 1, 'compare products', 'initial comparison')
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('personal-include-active'))
    const active = start(activeSession, { provider: 'mock', model: 'mock' })
    appendClosedTurn(activeSession, 2, 'vendor regional repair terms', 'current comparison', {
      provider: 'mock', model: 'mock',
    })
    const first = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('personal-include-first'))
    start(first)
    const old = appendClosedTurn(first, 2, 'vendor regional repair terms', 'earlier source')
    const second = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('personal-include-second'))
    start(second)
    const matching = appendClosedTurn(second, 2, 'vendor regional repair terms', 'another source')
    const initial = ctx.contextify.get(active.agent)
    await ctx.contextify.setNodeMode(active.agent, { revision: initial.plan.revision },
      { sessionId: first.id, seq: old.userSeq }, 'include', 'contextify-client')
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({ exclude: [], include: [], archive: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const view = ctx.contextify.get(active.agent)
    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphRevision: page.revision,
      activeSessionId: activeSession.id,
    }, 'vendor regional repair terms')
    expect(proposal.selection).toMatchObject([{
      nodeId: `${second.id}:${String(matching.userSeq)}`, action: 'include',
    }])
    expect(proposal.addedNodeIds).toContain(`${second.id}:${String(matching.userSeq)}`)
  })

  it('reuses a sibling source across turns without making it permanently active', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('cross-turn-root'))
    const prefix = appendClosedTurn(root, 1, 'Plan a product launch', 'Initial plan')
    const evidence = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('cross-turn-evidence'))
    start(evidence)
    const source = appendClosedTurn(evidence, 2, 'The supplier lead time is six weeks', 'Lead time recorded')
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('cross-turn-active'))
    const active = start(activeSession)
    appendClosedTurn(activeSession, 2, 'Draft the launch page', 'Page draft')
    const sourceRef = { sessionId: evidence.id, seq: source.userSeq }
    const sourceId = `${evidence.id}:${String(source.userSeq)}`
    const compiledTexts = (turn: number) => compileContextify({ session: activeSession, turn, step: 1 })
      .messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))

    expect(compiledTexts(3)).not.toContain('The supplier lead time is six weeks')
    const first = ctx.contextify.get(active.agent)
    await ctx.contextify.setNodeMode(active.agent, { revision: first.plan.revision }, sourceRef,
      'include', 'contextify-client')
    expect(ctx.contextify.get(active.agent).plan.included.map(item => item.nodeId)).toContain(sourceId)
    appendClosedTurn(activeSession, 3, 'Set the launch schedule', 'Schedule draft')
    expect(compiledTexts(4)).toContain('The supplier lead time is six weeks')

    const second = ctx.contextify.get(active.agent)
    await ctx.contextify.setNodeMode(active.agent, { revision: second.plan.revision }, sourceRef,
      'natural', 'contextify-client')
    expect(ctx.contextify.get(active.agent).plan.included.map(item => item.nodeId)).not.toContain(sourceId)
    appendClosedTurn(activeSession, 4, 'Review the website copy only', 'Copy review')
    expect(compiledTexts(5)).not.toContain('The supplier lead time is six weeks')

    const third = ctx.contextify.get(active.agent)
    await ctx.contextify.setNodeMode(active.agent, { revision: third.plan.revision }, sourceRef,
      'include', 'contextify-client')
    appendClosedTurn(activeSession, 5, 'Return to the launch schedule', 'Schedule revision')
    expect(compiledTexts(6)).toContain('The supplier lead time is six weeks')
    expect(evidence.snapshotEvents().filter(event => event.type === 'contextify/plan')).toHaveLength(1)
    expect(activeSession.snapshotEvents().filter(event => event.type === 'contextify/node-choice'))
      .toMatchObject([{ data: { mutations: [{ nodeId: sourceId, mode: 'include' }] } },
        { data: { mutations: [{ nodeId: sourceId, mode: 'natural' }] } },
        { data: { mutations: [{ nodeId: sourceId, mode: 'include' }] } }])
  })

  it('uses an accepted UI recommendation to inform the next Fast review', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('accepted-context-root'))
    const prefix = appendClosedTurn(root, 1, 'compare products', 'initial comparison')
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('accepted-context-active'))
    const active = start(activeSession, { provider: 'mock', model: 'mock' })
    appendClosedTurn(activeSession, 2, 'vendor regional repair terms', 'current comparison', {
      provider: 'mock', model: 'mock',
    })
    const first = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('accepted-context-first'))
    start(first)
    const old = appendClosedTurn(first, 2, 'vendor regional repair terms.', 'earlier source')
    const second = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('accepted-context-second'))
    start(second)
    const matching = appendClosedTurn(second, 2, 'vendor regional repair terms!', 'another source')
    let reviewCount = 0
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({ exclude: [], include: reviewCount++ === 0 ? [{
          nodeId: `${first.id}:${String(old.userSeq)}`, reason: 'Generic relevance',
        }] : [], archive: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const firstView = ctx.contextify.get(active.agent)
    const firstPage = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const firstProposal = await ctx.contextify.recommend(active.agent, {
      planRevision: firstView.plan.revision,
      graphRevision: firstPage.revision,
      activeSessionId: activeSession.id,
    }, 'vendor regional repair terms')
    expect(firstProposal.selection).toMatchObject([{
      nodeId: `${first.id}:${String(old.userSeq)}`, action: 'include',
    }])
    await ctx.contextify.setNodeModes(active.agent,
      { revision: firstView.plan.revision },
      [{ node: { sessionId: first.id, seq: old.userSeq }, mode: 'include' }],
      firstPage.revision, 'contextify-client')

    const nextView = ctx.contextify.get(active.agent)
    const nextPage = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const nextProposal = await ctx.contextify.recommend(active.agent, {
      planRevision: nextView.plan.revision,
      graphRevision: nextPage.revision,
      activeSessionId: activeSession.id,
    }, 'vendor regional repair terms')
    expect(reviewCount).toBe(2)
    expect(nextProposal.selection).toMatchObject([{
      nodeId: `${second.id}:${String(matching.userSeq)}`, action: 'include',
    }])
    expect(nextView.plan.included.map(item => item.nodeId))
      .toContain(`${first.id}:${String(old.userSeq)}`)
    const compiled = compileContextify({ session: activeSession, turn: 3, step: 1 })
      .messages.flatMap(message => message.content.flatMap(block =>
        block.type === 'text' ? [block.text] : []))
    expect(compiled).toContain('vendor regional repair terms')
    expect(compiled).toContain('vendor regional repair terms.')
    expect(compiled).not.toContain('vendor regional repair terms!')
  })

  it('can review and restore an earlier accepted deferral without reversing a direct user Exclude', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('reviewable-temporary-exclude'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    appendClosedTurn(session, 1, 'Show me the calendar and its price', 'The calendar costs $20.')
    const priceSeq = session.snapshotEvents().find(event => event.type === 'assistant/message')?.seq
    if (priceSeq === undefined) throw new Error('price source missing')
    const priceRef = { sessionId: session.id, seq: priceSeq }
    const priceId = `${session.id}:${String(priceSeq)}`
    let reviewCount = 0
    const packets: FastRecommendationInput[] = []
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const input = options.messages[0]?.content.find(block => block.type === 'text')
        if (input?.type === 'text') {
          const packet = input.text.split('Conversation graph JSON:\n')[1]
          if (packet !== undefined) packets.push(JSON.parse(packet) as FastRecommendationInput)
        }
        const action = reviewCount++ === 0 ? 'exclude' : 'include'
        const text = JSON.stringify({ exclude: action === 'exclude' ? [{
          nodeId: priceId, reason: 'Price can wait while the image is corrected',
        }] : [], include: action === 'include' ? [{
          nodeId: priceId, reason: 'The user is buying the calendar now',
        }] : [], archive: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const firstView = ctx.contextify.get(active.agent)
    const firstGraph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const firstProposal = await ctx.contextify.recommend(active.agent, {
      planRevision: firstView.plan.revision, graphRevision: firstGraph.revision,
      activeSessionId: session.id,
    }, 'The calendar photo needs a color correction')
    expect(firstProposal.selection).toMatchObject([{ nodeId: priceId, action: 'exclude' }])
    await ctx.contextify.setNodeModes(active.agent, { revision: firstView.plan.revision },
      [{ node: priceRef, mode: 'exclude' }], firstGraph.revision, 'contextify-client')
    appendClosedTurn(session, 2, 'I will buy the calendar now; use its quoted price', 'Ready to check out')
    const secondView = ctx.contextify.get(active.agent)
    const secondGraph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const secondProposal = await ctx.contextify.recommend(active.agent, {
      planRevision: secondView.plan.revision, graphRevision: secondGraph.revision,
      activeSessionId: session.id,
    }, 'I will buy the calendar now; use its quoted price')
    expect(secondProposal.selection).toMatchObject([{ nodeId: priceId, action: 'include' }])
    expect(packets[1]?.nodes.find(node => node.id === priceId)).toMatchObject({
      included: false, reviewableExcluded: true,
    })
    expect(secondView.plan.excluded.map(item => item.nodeId)).toContain(priceId)
    await ctx.contextify.setNodeModes(active.agent, { revision: secondView.plan.revision },
      [{ node: priceRef, mode: 'natural' }], secondGraph.revision, 'contextify-client')
    expect(ctx.contextify.get(active.agent).plan.excluded.map(item => item.nodeId)).not.toContain(priceId)
    const compiled = compileContextify({ session, turn: 3, step: 1 }).messages
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    expect(compiled).toContain('The calendar costs $20.')

    const directView = ctx.contextify.get(active.agent)
    await ctx.contextify.setNodeMode(active.agent, { revision: directView.plan.revision },
      priceRef, 'exclude', 'contextify-client')
    appendClosedTurn(session, 3, 'Continue the order', 'Continuing the order')
    const thirdView = ctx.contextify.get(active.agent)
    const thirdGraph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const thirdProposal = await ctx.contextify.recommend(active.agent, {
      planRevision: thirdView.plan.revision, graphRevision: thirdGraph.revision,
      activeSessionId: session.id,
    }, 'Continue the order')
    expect(thirdProposal.selection).toEqual([])
    expect(packets[2]?.nodes.find(node => node.id === priceId)?.reviewableExcluded).toBeUndefined()
    expect(ctx.contextify.get(active.agent).plan.excluded.map(item => item.nodeId)).toContain(priceId)
    expect(reviewCount).toBe(3)
  })

  it('sends a confirmed two-node Context edit as one grouped case on the next review', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('grouped-case-root'))
    const prefix = appendClosedTurn(root, 1, 'shop for a camera', 'initial comparison')
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('grouped-case-active'))
    const active = start(activeSession, { provider: 'mock', model: 'mock' })
    const old = appendClosedTurn(activeSession, 2, 'camera budget is 600', 'old budget answer', {
      provider: 'mock', model: 'mock',
    })
    appendClosedTurn(activeSession, 3, 'camera budget is now 900', 'new budget answer', {
      provider: 'mock', model: 'mock',
    })
    const sibling = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('grouped-case-sibling'))
    start(sibling)
    const source = appendClosedTurn(sibling, 2, 'camera battery comparison', 'new source')
    const captured: GenerateOptions[] = []
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        captured.push(options)
        const text = JSON.stringify(captured.length === 1 ? {
          exclude: [{ nodeId: `${activeSession.id}:${String(old.userSeq)}`, reason: 'Old budget' }],
          include: [{ nodeId: `${sibling.id}:${String(source.userSeq)}`, reason: 'Useful comparison' }],
          archive: [],
        } : { exclude: [], include: [], archive: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const view = ctx.contextify.get(active.agent)
    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision, graphRevision: page.revision,
      activeSessionId: activeSession.id,
    }, 'continue camera comparison on the new budget')
    expect(proposal.selection.map(item => item.action)).toEqual(['exclude', 'include'])
    const accepted = await ctx.contextify.setNodeModes(active.agent,
      { revision: view.plan.revision }, [
        { node: { sessionId: activeSession.id, seq: old.userSeq }, mode: 'exclude' },
        { node: { sessionId: sibling.id, seq: source.userSeq }, mode: 'include' },
      ], page.revision, 'contextify-client')
    const nextPage = await ctx.contextify.familyPage(active.agent, undefined, 100)
    await ctx.contextify.recommend(active.agent, {
      planRevision: accepted.plan.revision, graphRevision: nextPage.revision,
      activeSessionId: activeSession.id,
    }, 'continue camera comparison on the new budget')
    const requestText = captured[1]?.messages[0]?.content[0]
    if (requestText?.type !== 'text') throw new Error('Fast request text was not captured')
    const json = requestText.text.split('Conversation graph JSON:\n')[1]
    if (json === undefined) throw new Error('Fast packet was not captured')
    const packet = JSON.parse(json) as FastRecommendationInput
    expect(packet.planExamples).toHaveLength(1)
    expect(packet.planExamples[0]?.choices.map(choice => choice.action)).toEqual(['exclude', 'include'])
    expect(packet.planExamples[0]?.choices.map(choice => [choice.beforeIncluded, choice.afterIncluded]))
      .toEqual([[true, false], [false, true]])
    expect(packet.planExamples[0]?.choices.map(choice => choice.content)).toEqual([
      'camera budget is 600', 'camera battery comparison',
    ])
  })

  it('routes an explicit Deep recommendation through one isolated runner and preserves its mode', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('recommend-deep'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    const turn = appendClosedTurn(session, 1, 'compare every architecture branch', 'current answer')
    const runner = vi.fn(async (_request: {
      parent: Agent
      snapshot: { graphRevision: string; planRevision: number; activeSessionId: SessionId }
      signal: AbortSignal
    }) => ({
      exclude: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, reason: 'stale premise' }],
      include: [],
      archive: [],
    }))
    ;(ctx.contextify as unknown as { deepRecommendation: typeof runner }).deepRecommendation = runner
    // A Fast response is registered only to prove the explicit Deep path never consumes it.
    ctx.llm.registerAdapter(['mock'], new class extends LlmAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = '{"exclude":[],"include":[],"archive":[]}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const view = ctx.contextify.get(active.agent)
    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)

    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphRevision: page.revision,
      activeSessionId: session.id,
    }, undefined, 'deep')

    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0]?.[0].parent).toBe(active.agent)
    expect(runner.mock.calls[0]?.[0].snapshot).toMatchObject({
      graphRevision: page.revision,
      planRevision: view.plan.revision,
      activeSessionId: session.id,
    })
    expect(proposal.mode).toBe('deep')
    expect(proposal.removedNodeIds).toEqual([`${session.id}:${String(turn.userSeq)}`])
  })

  it('cancels an owned Deep recommendation without cancelling the conversation Agent', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('recommend-deep-cancel'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    appendClosedTurn(session, 1, 'inspect all branches', 'current answer')
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const runner = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      started()
      signal.addEventListener('abort', () => {
        const error = new Error('cancelled by test')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    }))
    ;(ctx.contextify as unknown as { deepRecommendation: typeof runner }).deepRecommendation = runner
    const view = ctx.contextify.get(active.agent)
    const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const pending = ctx.contextify.recommend(active.agent, {
      planRevision: view.plan.revision,
      graphRevision: page.revision,
      activeSessionId: session.id,
    }, undefined, 'deep')

    await didStart
    ;(ctx.contextify as unknown as { cancelRecommendation: (agent: Agent) => void })
      .cancelRecommendation(active.agent)

    await expect(pending).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' })
    expect(active.agent.status).toBe('idle')
    expect(ctx.agents.get(active.agent.id)).toBe(active.agent)
  })

  it('permits only one recommendation across sibling Sessions in the same native family', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('recommend-family-root'))
    start(root)
    const prefix = appendClosedTurn(root, 1, 'shared premise', 'shared answer')
    const leftSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('recommend-family-left'))
    const rightSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('recommend-family-right'))
    const left = start(leftSession, { provider: 'mock', model: 'mock' })
    const right = start(rightSession, { provider: 'mock', model: 'mock' })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const didStart = new Promise<void>((resolve) => { started = resolve })
    const runner = vi.fn(async () => {
      started()
      await gate
      return { exclude: [], include: [], archive: [] }
    })
    ;(ctx.contextify as unknown as { deepRecommendation: typeof runner }).deepRecommendation = runner
    const leftView = ctx.contextify.get(left.agent)
    const rightView = ctx.contextify.get(right.agent)
    const leftPage = await ctx.contextify.familyPage(left.agent, undefined, 100)
    const rightPage = await ctx.contextify.familyPage(right.agent, undefined, 100)
    const first = ctx.contextify.recommend(left.agent, {
      planRevision: leftView.plan.revision,
      graphRevision: leftPage.revision,
      activeSessionId: leftSession.id,
    }, undefined, 'deep')
    await didStart

    await expect(ctx.contextify.recommend(right.agent, {
      planRevision: rightView.plan.revision,
      graphRevision: rightPage.revision,
      activeSessionId: rightSession.id,
    }, undefined, 'deep')).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_BUSY' })

    release()
    await expect(first).resolves.toMatchObject({ mode: 'deep' })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('rejects a recommendation when any Session in the reviewed family changes during the run', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('recommend-stale-root'))
    start(root)
    const prefix = appendClosedTurn(root, 1, 'prefix', 'answer')
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('recommend-stale-active'))
    const active = start(activeSession)
    const sibling = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('recommend-stale-sibling'))
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
    const planEventsBefore = session.snapshotEvents().filter(event => event.type === 'contextify/plan').length
    const active = start(session)

    expect(session.snapshotEvents().filter(event => event.type === 'contextify/plan')).toHaveLength(planEventsBefore)
    expect(ctx.contextify.get(active.agent).plan).toMatchObject({
      version: 3, revision: 8, stateRevision: 8, replacements: [],
    })
    const changed = await ctx.contextify.setNodeMode(
      active.agent, { revision: 8 }, { sessionId: session.id, seq: turn.userSeq }, 'exclude',
    )
    expect(changed.plan).toMatchObject({ version: 3, revision: 9 })
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/plan')?.data.version).toBe(3)
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

  it('focuses a mixed chat message to an exact source excerpt and restores it', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('mixed-offer-excerpt'))
    const active = start(session)
    const full = 'Sony HU-80 microphone for $14.99. Or JVC QAN0067-003 for $90.'
    appendClosedTurn(session, 1, 'Choose the beginner microphone', full)
    const assistantEvent = session.snapshotEvents().findLast(event => event.type === 'assistant/message')
    if (assistantEvent?.type !== 'assistant/message') throw new Error('fixture assistant is missing')
    const before = ctx.contextify.get(active.agent)
    const graphBefore = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const node = graphBefore.records.find(record => record.owner.seq === assistantEvent.seq)!
    const end = Array.from(full.slice(0, full.indexOf(' Or '))).length

    await expect(ctx.contextify.focusNodeExcerpt(active.agent,
      { revision: before.plan.revision }, node.owner, 0, 10_000, 'Chosen Sony offer'))
      .rejects.toThrow(/excerpt range/)
    expect(session.snapshotEvents().filter(event => event.type === 'context/compiler-snapshot')).toHaveLength(0)

    const focused = await ctx.contextify.focusNodeExcerpt(active.agent,
      { revision: before.plan.revision }, node.owner, 0, end,
      'Chosen Sony offer', 'contextify-client')
    expect(focused.plan.replacements).toMatchObject([{
      nodeId: node.id, kind: 'excerpt', start: 0, end, role: 'assistant',
    }])
    const compiled = ctx.contextCompiler.compile({ session, turn: 2, step: 1 })
    const visible = compiled.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text)
    expect(visible).toContain('Sony HU-80 microphone for $14.99.')
    expect(visible.join(' ')).not.toContain('JVC')
    const snapshot = session.snapshotEvents().findLast(event => event.type === 'context/compiler-snapshot')
    expect(snapshot?.type === 'context/compiler-snapshot' ? snapshot.data.provenance : null)
      .toMatchObject({ provider: 'contextify-excerpt', sourceId: session.id,
        sourceSeq: assistantEvent.seq })
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/excerpt-choice'))
      .toMatchObject({ data: { uiOrigin: 'contextify-client', start: 0, end } })
    const graphAfter = await ctx.contextify.familyPage(active.agent, undefined, 100)
    expect(graphAfter.edges).toEqual(graphBefore.edges)
    expect(graphAfter.records.find(record => record.id === node.id)?.replacement)
      .toMatchObject({ kind: 'excerpt', preview: 'Sony HU-80 microphone for $14.99.', original: full })
    expect(await ctx.contextify.getNodeText(active.agent, node.owner)).toBe(full)

    const undone = ctx.contextify.undo(active.agent, { revision: focused.plan.revision })
    expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages
      .flatMap(message => message.content).filter(block => block.type === 'text')
      .map(block => block.text).join(' ')).toContain('JVC')
    const redone = ctx.contextify.redo(active.agent, { revision: undone.plan.revision })
    const restored = await ctx.contextify.restoreNode(active.agent,
      { revision: redone.plan.revision }, node.owner)
    expect(restored.plan.replacements).toEqual([])
    expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages
      .flatMap(message => message.content).filter(block => block.type === 'text')
      .map(block => block.text).join(' ')).toContain('JVC')
  })

  it('pages a de-duplicated family and imports only a same-family message snapshot', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('root'))
    start(root)
    const rootTurn = appendClosedTurn(root, 1, 'root requirement', 'root answer')
    const activeSession = ctx.sessions.fork(root, SessionSeq(rootTurn.boundary), SessionId('active-child'))
    const active = start(activeSession)
    const activeTurn = appendClosedTurn(activeSession, 2, 'active question')
    const sibling = ctx.sessions.fork(root, SessionSeq(rootTurn.boundary), SessionId('sibling-child'))
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
      'contextify-client',
    )
    expect(activeSession.snapshotEvents().slice(before).map(event => event.type))
      .toEqual(['context/compiler-snapshot', 'contextify/plan', 'contextify/node-choice'])
    expect(activeSession.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')?.data)
      .toMatchObject({ origin: 'direct', changed: true, uiOrigin: 'contextify-client',
        beforePlanRevision: initial.plan.revision,
        afterPlanRevision: included.plan.revision,
        mutations: [{ nodeId: `${sibling.id}:${String(siblingTurn.userSeq)}`, mode: 'include' }] })
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

  it('imports a sibling Web observation with its call provenance and can undo the Include', async () => {
    const { ctx, start } = await harness()
    try {
      const root = ctx.sessions.create(SessionId('web-import-root'))
      start(root)
      const prefix = appendClosedTurn(root, 1, 'Compare publisher policies')
      const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('web-import-active'))
      const active = start(activeSession)
      const sibling = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('web-import-sibling'))
      start(sibling)
      const callId = CallId('sibling-web-call')
      sibling.append('turn/start', { turn: 2 })
      sibling.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Inspect publisher A' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      sibling.append('assistant/message', { stream: [], turn: 2, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'web_fetch',
            arguments: '{"url":"https://publisher.example/policy"}' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      const call = sibling.append('tool/call', { turn: 2, step: 1, callId,
        name: 'web_fetch', arguments: '{"url":"https://publisher.example/policy"}' })
      const result = sibling.append('tool/result', { turn: 2, step: 1,
        message: createToolResultMessage({ callId,
          content: [{ type: 'text', text: 'Publisher A allows reuse with attribution.' }],
          isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
      sibling.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

      const initial = ctx.contextify.get(active.agent)
      const included = await ctx.contextify.setNodeMode(active.agent,
        { revision: initial.plan.revision },
        { sessionId: sibling.id, seq: result.seq }, 'include', 'contextify-client')
      const snapshot = activeSession.eventAt(SessionSeq(included.plan.included[0]!.snapshotSeq))
      expect(snapshot?.type).toBe('context/compiler-snapshot')
      if (snapshot?.type !== 'context/compiler-snapshot') throw new Error('missing imported snapshot')
      expect(snapshot.data.provenance).toMatchObject({
        sourceId: sibling.id, sourceSeq: result.seq,
      })
      expect(snapshot.data.message.source).toMatchObject({ kind: 'plugin', form: 'recall' })
      const texts = snapshot.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      expect(texts.join('\n')).toContain('web_fetch')
      expect(texts.join('\n')).toContain('https://publisher.example/policy')
      expect(texts.join('\n')).toContain('Publisher A allows reuse with attribution.')
      expect(ctx.contextCompiler.compile({ session: activeSession, turn: 3, step: 1 }).messages
        .some(message => message.id === snapshot.data.message.id)).toBe(true)
      const childId = SessionId('web-import-worker')
      const started = vi.spyOn(ctx.subagents, 'startContinuable').mockResolvedValue({ childId } as never)
      await startSourceBoundContinuable(ctx, active.agent, childId,
        [included.plan.included[0]!.snapshotSeq], new AbortController().signal)
      expect(started).toHaveBeenCalledOnce()
      const delegatedPrompt = started.mock.calls[0]?.[0].request.prompt[0]
      expect(delegatedPrompt?.type).toBe('text')
      if (delegatedPrompt?.type !== 'text') throw new Error('missing delegated text')
      expect(delegatedPrompt.text).toContain('web-recall')
      expect(delegatedPrompt.text).toContain('https://publisher.example/policy')
      expect(childMessageAdmissible(activeSession, childId)).toBe(true)
      const altered = activeSession.append('context/compiler-snapshot', {
        ...snapshot.data,
        message: { ...snapshot.data.message,
          content: [{ type: 'text', text: 'Imported Web evidence. altered text' }] },
      })
      await expect(startSourceBoundContinuable(ctx, active.agent, SessionId('web-import-altered'),
        [altered.seq], new AbortController().signal)).rejects.toThrow('source-bound delegation')
      expect(started).toHaveBeenCalledOnce()
      ctx.contextify.undo(active.agent, { revision: included.plan.revision })
      expect(ctx.contextCompiler.compile({ session: activeSession, turn: 3, step: 1 }).messages
        .some(message => message.id === snapshot.data.message.id)).toBe(false)
      expect(childMessageAdmissible(activeSession, childId)).toBe(false)
      const reincluded = await ctx.contextify.setNodeMode(active.agent,
        { revision: ctx.contextify.get(active.agent).plan.revision },
        { sessionId: sibling.id, seq: result.seq }, 'include')
      expect(reincluded.plan.included).toHaveLength(1)
      expect(ctx.contextCompiler.compile({ session: activeSession, turn: 3, step: 1 }).messages
        .filter(message => message.source.kind === 'plugin' && message.source.form === 'recall'))
        .toHaveLength(1)

      const orphanId = CallId('sibling-web-without-source')
      sibling.append('turn/start', { turn: 3 })
      sibling.append('assistant/message', { stream: [], turn: 3, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: orphanId, name: 'web_fetch', arguments: '{}' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      sibling.append('tool/call', { turn: 3, step: 1, callId: orphanId,
        name: 'web_fetch', arguments: '{}' })
      const orphan = sibling.append('tool/result', { turn: 3, step: 1,
        message: createToolResultMessage({ callId: orphanId,
          content: [{ type: 'text', text: 'Unbound page text' }], isError: false }),
      }, { surfaceOp: 'append' })
      sibling.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
      const beforeRejected = activeSession.seq
      await expect(ctx.contextify.setNodeMode(active.agent,
        { revision: ctx.contextify.get(active.agent).plan.revision },
        { sessionId: sibling.id, seq: orphan.seq }, 'include'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      expect(activeSession.seq).toBe(beforeRejected)
    } finally { await ctx.fiber.dispose() }
  })

  it('passes a source-bound Web result and its call arguments into Fast candidate text', async () => {
    const { ctx, start } = await harness()
    try {
      const root = ctx.sessions.create(SessionId('web-fast-text-root'))
      start(root)
      const prefix = appendClosedTurn(root, 1, 'Find an orbital report', 'Ready')
      const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('web-fast-text-active'))
      const active = start(activeSession)
      appendClosedTurn(activeSession, 2, 'Review the planetary orbital report', 'Ready to compare')
      const sibling = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('web-fast-text-source'))
      start(sibling)
      const callId = CallId('web-fast-text-call')
      sibling.append('turn/start', { turn: 2 })
      sibling.append('assistant/message', { stream: [], turn: 2, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'web_fetch',
            arguments: '{"url":"https://example.org/planetary-orbital-report"}' }],
          source: { provider: 'mock', model: 'mock' },
        }),
      }, { surfaceOp: 'append' })
      const call = sibling.append('tool/call', { turn: 2, step: 1, callId,
        name: 'web_fetch', arguments: '{"url":"https://example.org/planetary-orbital-report"}' })
      const result = sibling.append('tool/result', { turn: 2, step: 1,
        message: createToolResultMessage({ callId,
          content: [{ type: 'text', text: 'Observed planetary orbital measurements.' }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
      sibling.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      let captured: GenerateOptions | undefined
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          captured = options
          const text = '{"exclude":[],"include":[],"archive":[]}'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const view = ctx.contextify.get(active.agent)
      const page = await ctx.contextify.familyPage(active.agent, undefined, 100)
      await ctx.contextify.recommend(active.agent, {
        planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: activeSession.id,
      }, 'Review the planetary orbital report')
      const prompt = captured?.messages[0]?.content.find(block => block.type === 'text')
      expect(prompt?.type).toBe('text')
      if (prompt?.type !== 'text') throw new Error('missing Fast packet')
      const packet = JSON.parse(prompt.text.split('Conversation graph JSON:\n')[1] ?? '{}') as {
        nodes?: Array<{ id: string; content: string }>
      }
      const candidate = packet.nodes?.find(node => node.id === `${sibling.id}:${String(result.seq)}`)
      expect(candidate?.content).toContain('planetary-orbital-report')
      expect(candidate?.content).toContain('Observed planetary orbital measurements.')
    } finally { await ctx.fiber.dispose() }
  })

  it('restores original semantics after an off-path placeholder is included', async () => {
    const { ctx, start } = await harness()
    const root = ctx.sessions.create(SessionId('restore-off-path-root'))
    start(root)
    const prefix = appendClosedTurn(root, 1, 'prefix', 'answer')
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('restore-off-path-active'))
    const active = start(activeSession)
    const sibling = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('restore-off-path-sibling'))
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
    const activeSession = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('accept-stale-active'))
    const active = start(activeSession)
    const sibling = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('accept-stale-sibling'))
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

  it('does not call an unreviewed guarded mutation a recommendation acceptance', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('unreviewed-guarded'))
    const active = start(session)
    const turn = appendClosedTurn(session, 1, 'one user requirement')
    const view = ctx.contextify.get(active.agent)
    const graph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    await expect(ctx.contextify.setNodeModes(active.agent,
      { revision: view.plan.revision },
      [{ node: { sessionId: session.id, seq: turn.userSeq }, mode: 'exclude' }],
      graph.revision)).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
    expect(session.snapshotEvents().some(event => event.type === 'contextify/node-choice')).toBe(false)
    expect(ctx.contextify.get(active.agent).plan.revision).toBe(view.plan.revision)
  })

  it('records an unchanged direct node operation without counting it as a changed plan', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('unchanged-node-choice'))
    const active = start(session)
    const turn = appendClosedTurn(session, 1, 'one user requirement')
    const view = ctx.contextify.get(active.agent)
    await ctx.contextify.setNodeMode(active.agent, { revision: view.plan.revision },
      { sessionId: session.id, seq: turn.userSeq }, 'natural')
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')?.data)
      .toMatchObject({ origin: 'direct', changed: false })
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')?.data)
      .not.toHaveProperty('uiOrigin')
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

    const child = ctx.sessions.fork(parent, SessionSeq(parent.snapshotEvents().at(-1)!.seq), SessionId('reset-child'))
    const childAgent = start(child)
    const view = ctx.contextify.get(childAgent.agent)

    expect(view.plan.revision).toBe(selected.plan.revision + 1)
    expect(view.plan.excluded).toEqual([])
    expect(view.plan.included).toEqual([])
    expect(child.snapshotEvents().findLast(event => event.type === 'contextify/plan')!.seq)
      .toBeGreaterThanOrEqual(child.inheritedEventCount ?? 0)
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

  it('projects reviewed Context choices into a live DSH policy profile', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('steward-live-profile'))
    const { agent } = start(session)
    const turn = appendClosedTurn(session, 1, 'Compare the previous Web sources', 'The sources differ.')
    const view = ctx.contextify.get(agent)
    await ctx.contextify.setNodeMode(agent, { revision: view.plan.revision },
      { sessionId: session.id, seq: turn.userSeq }, 'exclude', 'contextify-client')

    const profile = await ctx.contextify.stewardProfile(agent)
    expect(profile.release.support).toBe(1)
    expect(profile.release.acceptRate).toBeGreaterThan(0.5)
    expect(profile.evidence.support).toBe(0)
  })

  it('attaches a review-only draft route to Fast advice without another model call', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('steward-draft-route'))
      const { agent } = start(session, { provider: 'mock', model: 'mock' })
      appendClosedTurn(session, 1, 'Plan the experiment', 'The experiment plan is ready.')
      let calls = 0
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          calls += 1
          const text = '{"exclude":[],"include":[],"archive":[]}'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const view = ctx.contextify.get(agent)
      const page = await ctx.contextify.familyPage(agent)
      const base = { planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: session.id }
      const route = await ctx.contextify.recommend(agent, base, 'New topic: write the website copy', 'fast', true)
      expect(route.route).toMatchObject({ action: 'branch', base,
        objective: 'New topic: write the website copy' })
      expect(calls).toBe(1)
      expect(ctx.sessions.list()).toHaveLength(1)
      expect(ctx.contextify.get(agent).plan.revision).toBe(view.plan.revision)
      await ctx.contextify.presentRecommendation(agent, route, 'contextify-client')
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-presented')?.data)
        .toMatchObject({ routeAction: 'branch' })
      await ctx.contextify.reviewRoute(agent, route.route!, 'reject', undefined, 'contextify-client')
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/route-choice')?.data)
        .toMatchObject({ objective: 'New topic: write the website copy', choice: 'reject' })
      expect((await ctx.contextify.stewardProfile(agent)).branch).toMatchObject({ support: 1 })
      expect((await ctx.contextify.familyPage(agent)).revision).toBe(page.revision)
      const correction = await ctx.contextify.recommend(agent, base, 'Actually I meant the other experiment', 'fast', true)
      expect(correction.route).toBeUndefined()
      const manual = await ctx.contextify.recommend(agent, base, 'New topic: website copy', 'fast')
      expect(manual.route).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('learns an accepted native Return as an explicit route preference', async () => {
    const { ctx, start } = await harness()
    try {
      const parent = ctx.sessions.create(SessionId('route-mainline'))
      const first = appendClosedTurn(parent, 1, 'Start the overall plan', 'The plan has two parts.')
      const child = ctx.sessions.fork(parent, SessionSeq(first.boundary), SessionId('route-experiment'))
      appendClosedTurn(child, 2, 'Design experiment A', 'Experiment A is drafted.')
      const { agent } = start(child, { provider: 'mock', model: 'mock' })
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        // This separate Session fixture intentionally repeats the empty reviewer response.
        // oxlint-disable-next-line sonarjs/no-identical-functions
        override async * stream(): AsyncIterable<StreamChunk> {
          const text = '{"exclude":[],"include":[],"archive":[]}'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const view = ctx.contextify.get(agent)
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, {
        planRevision: view.plan.revision, graphRevision: page.revision, activeSessionId: child.id,
      }, 'Return to the main thread for the overall plan', 'fast', true)
      expect(proposal.route).toMatchObject({ action: 'return', targetSessionId: parent.id })
      await ctx.contextify.reviewRoute(agent, proposal.route!, 'accept', parent.id, 'contextify-client')
      expect((await ctx.contextify.stewardProfile(agent)).return).toMatchObject({ support: 1 })
      expect((await ctx.contextify.familyPage(agent)).revision).toBe(page.revision)
      await expect(ctx.contextify.reviewRoute(agent, proposal.route!, 'accept', SessionId('unrelated'),
        'contextify-client')).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
    } finally { await ctx.fiber.dispose() }
  })
})

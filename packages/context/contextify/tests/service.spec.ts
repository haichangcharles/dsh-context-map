import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ToolCallId as CallId } from '@deepseek-ai/dsh-llm/brand'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent, type AgentOptions, type AgentStatus } from '@deepseek-ai/dsh-agent'
import ContextCompilerRegistry from '@deepseek-ai/dsh-context-compiler'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
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
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import ContextifyService from '../src/index.ts'
import * as ContextifyBranchTool from '../src/branch-tool.ts'
import { childMessageAdmissible, startSourceBoundContinuable } from '../src/revision-lineage.ts'
import { projectSessionFamily } from '../src/family.ts'
import type { FastRecommendationInput } from '../src/fast-recommendation.ts'
import { buildFastRecommendationInput } from '../src/fast-recommendation.ts'
import { buildContextActionPacket } from '../src/semantic-route.ts'
import { contextEditsFromFamily } from '../src/personal-context-policy.ts'
import { compileContextify } from '../src/plan.ts'
import { completedTurnCandidate } from '../src/branch-review.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
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

class ContextTestSettings extends SettingsProvider {
  private readonly fixtureSections: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(this.fixtureSections) }
  protected persist(namespace: SettingsNamespace, value: Record<string, unknown>): Promise<void> {
    this.fixtureSections[namespace] = structuredClone(value)
    return Promise.resolve()
  }
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
  it('does not turn past task-specific chat exclusions into a global rule to remove new constraints', async () => {
    const { ctx, start } = await harness()
    try {
      const old = ctx.sessions.create(SessionId('chat-calibration-old-family'))
      const prior = start(old).agent
      for (let i = 1; i <= 4; i += 1) {
        const turn = appendClosedTurn(old, i, `Old project correction ${String(i)}`, 'obsolete answer')
        await ctx.contextify.setNodeMode(prior, { revision: ctx.contextify.get(prior).plan.revision },
          { sessionId: old.id, seq: turn.userSeq }, 'exclude', 'contextify-client')
      }
      const current = ctx.sessions.create(SessionId('chat-calibration-current-family'))
      const agent = start(current).agent
      appendClosedTurn(current, 1, 'Keep the new website accessible', 'The current plan')
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter('{"include":[],"exclude":[],"archive":[]}'))
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision,
        activeSessionId: current.id }, 'Draft the new accessible website plan', 'fast')
      expect(proposal.selection).toEqual([])
      expect(proposal.personalization?.examples.length).toBeGreaterThan(0)
      expect(proposal.personalization?.calibrationSources).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('captures current settings after the initial family read', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('settings-during-family-read'))
      const agent = start(session).agent
      appendClosedTurn(session, 1, 'writing task', 'draft')
      const page = await ctx.contextify.familyPage(agent)
      const service = ctx.contextify as unknown as {
        loadFamily: (...args: unknown[]) => Promise<unknown>
        promptSettings: () => ContextifyPromptSettings
      }
      const read = service.loadFamily.bind(service)
      let enabled = true
      service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, personalizationEnabled: enabled })
      vi.spyOn(service, 'loadFamily').mockImplementationOnce(async (...args) => {
        enabled = false
        return read(...args)
      })
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'writing task', 'local')
      expect(proposal.personalization?.enabled).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('cancels an in-flight Jev decision when the user disables personalization', async () => {
    const { ctx, start } = await harness()
    const fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { fastDecisionProvider: 'jev' })
      ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-credential' }) } as never)
      const session = ctx.sessions.create(SessionId('jev-settings-cancel'))
      const agent = start(session).agent
      appendClosedTurn(session, 1, 'writing task', 'draft')
      fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      }))
      const page = await ctx.contextify.familyPage(agent)
      const result = ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'writing task', 'fast')
      const assertion = expect(result).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' })
      await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1) })
      await ctx.settings.update('contextify', { personalizationEnabled: false })
      await assertion
    } finally { fetcher.mockRestore(); await ctx.fiber.dispose() }
  })

  it.each([false, true])('keeps Branch review available without personal feedback (catalog failure %s)', async (failCatalog) => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('branch-personal-off'))
      const agent = start(session, { provider: 'mock', model: 'mock' }).agent
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true, personalizationEnabled: false })
      const adapter = new MockAdapter(['hang', textResponse('{"action":"keep","confidence":0.9,"reason":"Continue"}')])
      ctx.llm.registerAdapter(['mock'], adapter)
      appendClosedTurn(session, 1, 'Plan the website', 'A plan')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      await ctx.settings.update('contextify', { automaticBranchReview: false })
      await vi.waitFor(() => { expect(adapter.requests[0]?.signal?.aborted).toBe(true) })
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      if (failCatalog) {
        const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
        vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(original)
          .mockImplementationOnce(original).mockRejectedValueOnce(new Error('Profile catalog unavailable'))
      }
      const turn = appendClosedTurn(session, 2, 'Continue the website', 'Updated plan')
      await vi.waitFor(() => {
        expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')?.data)
          .toMatchObject({ suggestion: null, turnEndSeq: turn.boundary })
      })
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('cancels an automatic Branch classifier when policy memory is reset', async () => {
    const { ctx, start } = await harness()
    try {
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const session = ctx.sessions.create(SessionId('branch-policy-reset-cancel'))
      const agent = start(session).agent
      const adapter = new MockAdapter(['hang'])
      ctx.llm.registerAdapter(['mock'], adapter)
      appendClosedTurn(session, 1, 'Plan the website', 'A plan')
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      await vi.waitFor(() => { expect(adapter.requests[0]?.signal?.aborted).toBe(true) })
      expect(session.snapshotEvents().some(event => event.type === 'contextify/branch-review')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('runs opt-in Jev through native Context review and logs its exact request before dispatch', async () => {
    const { ctx, start } = await harness()
    const fetcher = vi.spyOn(globalThis, 'fetch')
    try {
      ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-credential' }) } as never)
      ;(ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }).promptSettings = () => ({
        ...CONTEXTIFY_DEFAULT_SETTINGS, fastDecisionProvider: 'jev',
      })
      const session = ctx.sessions.create(SessionId('jev-native-reviewed'))
      const agent = start(session).agent
      const turn = appendClosedTurn(session, 1, 'current task', 'obsolete draft')
      fetcher.mockImplementation(async (_url, init) => {
        expect(session.snapshotEvents().at(-1)?.type).toBe('contextify/recommendation-request')
        expect(typeof init?.body).toBe('string')
        const body: unknown = JSON.parse(init?.body as string)
        expect(JSON.stringify(body)).not.toContain('fixture-only-credential')
        return Response.json({ model: 'jev-1.13.0', answers: { n0: { type: 'noul', noul: 0.9 }, n1: { type: 'noul', noul: 0.1 },
          active: { type: 'noul', noul: 1 }, newTask: { type: 'noul', noul: 0 }, wholeTask: { type: 'noul', noul: 0 },
          parent: { type: 'choice', choice: 'active', probabilities: { active: 1 } } }, usage: { input_tokens: 100, output_tokens: 20 } })
      })
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'current task', 'fast')
      expect(proposal.selection).toContainEqual(expect.objectContaining({ nodeId: `${session.id}:${String(turn.userSeq + 1)}`, action: 'exclude' }))
      expect(proposal.personalization?.reviewer).toBe('jev')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally { fetcher.mockRestore(); await ctx.fiber.dispose() }
  })

  it('uses reset-aware choices from another native family in the live Fast decision', async () => {
    const { ctx, start } = await harness()
    try {
      const old = ctx.sessions.create(SessionId('personal-case-old'))
      const prior = start(old).agent
      const turn = appendClosedTurn(old, 1, 'Plan the launch; exclude the outdated budget', 'outdated budget')
      await ctx.contextify.setNodeMode(prior, { revision: 1 }, { sessionId: old.id, seq: turn.userSeq }, 'exclude', 'contextify-client')
      const current = ctx.sessions.create(SessionId('personal-case-current'))
      const agent = start(current).agent
      appendClosedTurn(current, 1, 'Plan the next launch', 'current budget')
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter('{"include":[],"exclude":[],"archive":[]}'))
      const recommend = async () => {
        const page = await ctx.contextify.familyPage(agent)
        return ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: current.id }, 'Plan the launch', 'fast')
      }
      const proposal = await recommend()
      const request = current.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-request')!
      expect(request.type).toBe('contextify/recommendation-request')
      if (request.type !== 'contextify/recommendation-request') throw new Error('missing request')
      expect(request.data.userText).toContain('outdated budget')
      expect(proposal.personalization?.examples).toContainEqual(expect.objectContaining({ action: 'exclude', sourceSessionId: old.id }))
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      const reset = await recommend()
      expect(reset.personalization?.examples).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('reuses ordered multi-node plans across families and removes them on reset', async () => {
    const { ctx, start } = await harness()
    try {
      let reply = '{"include":[],"exclude":[],"archive":[]}'
      const adapter = new MockAdapter([])
      adapter.stream = async function * () { yield * textResponse(reply) }
      ctx.llm.registerAdapter(['mock'], adapter)
      for (const id of ['plan-old-a', 'plan-old-b']) {
        const session = ctx.sessions.create(SessionId(id))
        const agent = start(session).agent
        const turn = appendClosedTurn(session, 1, 'Prior writing scope', 'An obsolete draft')
        const page = await ctx.contextify.familyPage(agent)
        const nodeIds = page.records.map(record => record.id)
        expect(nodeIds).toHaveLength(2)
        reply = JSON.stringify({ include: [], archive: [], exclude: nodeIds.map(nodeId => ({ nodeId, reason: 'Old scope' })) })
        await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Release this old scope', 'fast')
        await ctx.contextify.setNodeModes(agent, { revision: 1 }, [
          { node: { sessionId: session.id, seq: turn.userSeq }, mode: 'exclude' },
          { node: { sessionId: session.id, seq: SessionSeq(turn.userSeq + 1) }, mode: 'exclude' },
        ], page.revision, 'contextify-client')
      }
      const current = ctx.sessions.create(SessionId('plan-current'))
      const agent = start(current).agent
      appendClosedTurn(current, 1, 'Current writing', 'Current draft')
      reply = '{"include":[],"exclude":[],"archive":[]}'
      const review = async () => {
        const page = await ctx.contextify.familyPage(agent)
        return ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: current.id }, 'Current writing', 'fast')
      }
      const proposal = await review()
      expect(proposal.personalization?.examples.length).toBeGreaterThan(0)
      const request = current.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-request')!
      if (request.type !== 'contextify/recommendation-request') throw new Error('missing request')
      const packet = JSON.parse(request.data.userText.split('Conversation graph JSON:\n')[1]!) as FastRecommendationInput
      expect(packet.planExamples.map(item => item.sourceSessionId)).toEqual(['plan-old-a', 'plan-old-b'])
      await review()
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      expect((await review()).personalization?.examples).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('disables personal decision evidence and calibration without changing current candidates', async () => {
    const { ctx, start } = await harness()
    try {
      const old = ctx.sessions.create(SessionId('personal-case-off-old'))
      const prior = start(old).agent
      const turn = appendClosedTurn(old, 1, 'private past launch objective', 'private past budget')
      await ctx.contextify.setNodeMode(prior, { revision: 1 }, { sessionId: old.id, seq: turn.userSeq }, 'exclude', 'contextify-client')
      const current = ctx.sessions.create(SessionId('personal-case-off-new'))
      const agent = start(current).agent
      appendClosedTurn(current, 1, 'current launch', 'current budget')
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter('{"include":[],"exclude":[],"archive":[]}'))
      ;(ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }).promptSettings = () => ({
        ...CONTEXTIFY_DEFAULT_SETTINGS, personalizationEnabled: false,
      })
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: current.id }, 'current launch', 'fast', true)
      const request = current.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-request')!
      if (request.type !== 'contextify/recommendation-request') throw new Error('missing request')
      expect(request.data.userText).not.toContain('private past')
      expect(proposal.personalization).toMatchObject({ enabled: false, examples: [] })
      const latest = await ctx.contextify.familyPage(agent)
      const local = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: latest.revision, activeSessionId: current.id }, undefined, 'local', true)
      expect(local.route).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('leaves the unedited Session log and surface compiler unchanged while projecting the graph', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('contextify-transparent-natural'))
    const initialEvents = session.snapshotEvents()
    const { agent } = start(session)
    expect(session.snapshotEvents()).toEqual(initialEvents)
    expect(ctx.contextCompiler.descriptor(session).id).toBe('surface')
    appendClosedTurn(session, 1, 'keep the ordinary request', 'ordinary answer')
    const beforeRead = session.snapshotEvents()
    expect(ctx.contextify.get(agent).plan.revision).toBe(1)
    expect((await ctx.contextify.familyPage(agent)).records).toHaveLength(2)
    expect(session.snapshotEvents()).toEqual(beforeRead)
    expect(ctx.contextCompiler.descriptor(session).id).toBe('surface')
  })

  it('uses semantic destination scores in the same Fast call and logs its frozen packet', async () => {
    const { ctx, start } = await harness()
    try {
      const root = ctx.sessions.create(SessionId('same-call-root'))
      const turn = appendClosedTurn(root, 1, 'Plan a website launch', 'We can write the announcement next')
      const child = ctx.sessions.fork(root, SessionSeq(turn.boundary), SessionId('same-call-copy'))
      appendClosedTurn(child, 2, 'Write an announcement for the website')
      const { agent } = start(root, { provider: 'mock', model: 'mock' })
      let calls = 0
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          calls += 1
          expect(JSON.stringify(options.messages)).toContain('Context-action packet JSON')
          const text = JSON.stringify({ include: [], exclude: [], archive: [], route: {
            intent: 'resume', intentScore: 0.95, candidates: [{ sessionId: child.id,
              destinationScore: 0.95, evidenceScore: 0.1, supersededScore: 0 }],
          } })
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const page = await ctx.contextify.familyPage(agent)
      const before = ctx.contextify.get(agent).plan
      const proposal = await ctx.contextify.recommend(agent, { planRevision: before.revision,
        graphRevision: page.revision, activeSessionId: root.id },
      'Polish the announcement for publication', 'fast', true)
      expect(calls).toBe(1)
      expect(proposal.route).toMatchObject({ action: 'navigate', targetSessionId: child.id })
      expect(proposal.selection).toEqual([])
      expect(ctx.contextify.get(agent).plan).toEqual(before)
      const logged = root.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-request')
      expect(logged?.data).toMatchObject({ objective: 'Polish the announcement for publication', maxTokens: 640 })
      expect((await ctx.contextify.familyPage(agent)).revision).toBe(page.revision)
    } finally { await ctx.fiber.dispose() }
  })

  it('relearns the same explicit lifecycle rejection after resetting policy memory', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('reset-lifecycle-dedup'))
      appendClosedTurn(session, 1, 'Plan this project')
      const { agent } = start(session)
      const base = { planRevision: ctx.contextify.get(agent).plan.revision,
        graphRevision: (await ctx.contextify.familyPage(agent)).revision, activeSessionId: session.id }
      const first = await ctx.contextify.recommend(agent, base, 'Park this task', 'local', true)
      await ctx.contextify.reviewWorkState(agent, first, session.id, 'reject', 'contextify-client')
      await ctx.contextify.reviewWorkState(agent, first, session.id, 'reject', 'contextify-client')
      expect(await ctx.contextify.policyEvidence(agent)).toHaveLength(1)
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      const fresh = await ctx.contextify.recommend(agent, base, 'Park this task', 'local', true)
      await ctx.contextify.reviewWorkState(agent, fresh, session.id, 'reject', 'contextify-client')
      expect(await ctx.contextify.policyEvidence(agent)).toMatchObject([{ action: 'park', choice: 'reject' }])
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/work-state-choice')).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('records manual navigation once and resets Profile evidence without changing Plans or logs', async () => {
    const { ctx, start } = await harness()
    try {
      const root = ctx.sessions.create(SessionId('policy-reset-root'))
      const turn = appendClosedTurn(root, 1, 'Plan the report')
      const child = ctx.sessions.fork(root, SessionSeq(turn.boundary), SessionId('policy-reset-child'))
      appendClosedTurn(child, 2, 'Write a comparison')
      const { agent } = start(root)
      const page = await ctx.contextify.familyPage(agent)
      const before = ctx.contextify.get(agent).plan
      await ctx.contextify.recordManualRoute(agent, child.id, 'move-1', page.revision,
        'contextify-client', 'Continue writing the comparison')
      await ctx.contextify.recordManualRoute(agent, child.id, 'move-1', page.revision,
        'contextify-client', 'Continue writing the comparison')
      expect((await ctx.contextify.stewardProfile(agent)).destination.support).toBe(1)
      const evidence = await ctx.contextify.policyEvidence(agent)
      expect(evidence).toMatchObject([{ action: 'navigate', sourceSessionId: root.id,
        objective: 'Continue writing the comparison' }])
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
      expect((await ctx.contextify.stewardProfile(agent)).destination.support).toBe(0)
      expect(ctx.contextify.get(agent).plan).toEqual(before)
      expect(root.snapshotEvents().filter(event => event.type === 'contextify/manual-route')).toHaveLength(1)
      await ctx.contextify.recordManualRoute(agent, child.id, 'move-2', page.revision,
        'contextify-client', 'Continue writing the comparison')
      expect((await ctx.contextify.stewardProfile(agent)).destination.support).toBe(1)
      expect(await ctx.contextify.policyEvidence(agent)).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('reviews an explicit Local task-state proposal separately from Context selection', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('lifecycle-local'))
      appendClosedTurn(session, 1, 'Plan this project')
      const { agent } = start(session)
      const page = await ctx.contextify.familyPage(agent)
      const before = ctx.contextify.get(agent).plan
      const proposal = await ctx.contextify.recommend(agent, {
        planRevision: before.revision, graphRevision: page.revision, activeSessionId: session.id,
      }, 'Park this task until the next phase', 'local', true)
      expect(proposal.workStates).toMatchObject([{ sessionId: session.id, state: 'parked' }])
      expect((await ctx.contextify.familyPage(agent)).sessions[0]?.workState).toBe('open')
      await ctx.contextify.reviewWorkState(agent, proposal, session.id, 'accept', 'contextify-client')
      expect((await ctx.contextify.familyPage(agent)).sessions[0]?.workState).toBe('parked')
      expect(ctx.contextify.get(agent).plan).toEqual(before)
      expect(await ctx.contextify.policyEvidence(agent)).toMatchObject([{ action: 'park', choice: 'accept' }])
      await ctx.contextify.reviewWorkState(agent, proposal, session.id, 'accept', 'contextify-client')
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/work-state-choice')).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('learns one positive Branch preference from a successful manual Context Map fork', async () => {
    const { ctx, start } = await harness()
    try {
      const source = ctx.sessions.create(SessionId('manual-branch-source'))
      const turn = appendClosedTurn(source, 1, 'Plan a long report', 'Start with the outline')
      const child = ctx.sessions.fork(source, SessionSeq(turn.boundary), SessionId('manual-branch-child'))
      const { agent } = start(source)
      await ctx.contextify.recordManualBranch(agent, child.id, 'contextify-client',
        'Write the report introduction')
      await ctx.contextify.recordManualBranch(agent, child.id, 'contextify-client',
        'Write the report introduction')
      expect(source.snapshotEvents().filter(event => event.type === 'contextify/manual-branch'))
        .toMatchObject([{ data: { objective: 'Write the report introduction' } }])
      expect((await ctx.contextify.stewardProfile(agent)).branch).toEqual({ acceptRate: 0.6, support: 1 })
      const second = ctx.sessions.fork(source, SessionSeq(turn.boundary), SessionId('manual-branch-second'))
      await ctx.contextify.recordManualBranch(agent, second.id, 'contextify-client', '🧪'.repeat(4_001))
      const bounded = source.snapshotEvents().findLast(event => event.type === 'contextify/manual-branch')
      expect(bounded?.data.childSessionId).toBe(second.id)
      expect(Array.from(bounded?.data.objective ?? '')).toHaveLength(4_000)
      await expect(ctx.contextify.recordManualBranch(agent, SessionId('missing-child'),
        'contextify-client')).rejects.toThrow(/unavailable/)
    } finally { await ctx.fiber.dispose() }
  })

  it('loads explicit dismissal feedback from an otherwise unreviewed historical family', async () => {
    const { ctx, start, stored } = await harness()
    const archivalCtx = new Context()
    await archivalCtx.plugin(SessionStore)
    try {
      const archived = archivalCtx.sessions.create(SessionId('policy-dismissal-only'))
      appendClosedTurn(archived, 1, 'Write an introduction', 'Draft')
      archived.append('contextify/recommendation-dismissed', {
        mode: 'fast', base: { activeSessionId: archived.id, graphRevision: 'g', planRevision: 0 },
        selection: [{ nodeId: 'old-page', action: 'include' }], archiveNodeIds: [],
        declinedNodeIds: ['old-page'], uiOrigin: 'contextify-client',
      })
      stored.set(archived.id, { inspection: { meta: archived.header,
        inheritedEventCount: archived.inheritedEventCount, events: archived.snapshotEvents() },
      revision: 'dismissed-v1' })
      const current = ctx.sessions.create(SessionId('policy-dismissal-current'))
      appendClosedTurn(current, 1, 'Write another introduction', 'Draft')
      const { agent } = start(current)
      expect((await ctx.contextify.stewardProfile(agent)).evidence).toEqual({ acceptRate: 0.4, support: 1 })
    } finally { await archivalCtx.fiber.dispose() }
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
          if (block?.type === 'text') packet = JSON.parse(block.text.split('Conversation graph JSON:\n')[1] ?? '{}') as { preferenceExamples: unknown[] }
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
      }, 'Compare warranty sources', 'fast')
      expect(proposal.selection).toContainEqual(expect.objectContaining({
        nodeId: `${current.id}:${String(fetchSeq)}`, action: 'exclude',
      }))
      expect(proposal.selection).not.toContainEqual(expect.objectContaining({
        nodeId: `${current.id}:${String(searchSeq)}`, action: 'exclude',
      }))
      expect(packet?.preferenceExamples).toHaveLength(4)
      for (let index = 0; index < 3; index += 1) {
        const oldView = ctx.contextify.get(earlierAgent)
        ctx.contextify.undo(earlierAgent, { revision: oldView.plan.revision })
      }
      const afterUndo = await ctx.contextify.recommend(agent, {
        planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: current.id,
      }, 'Compare warranty sources', 'fast')
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
      }, 'Compare warranty terms', 'fast')
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
      appendClosedTurn(current, 1, 'existing project brief', 'brief acknowledged')
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(
        '{"action":"keep","confidence":0.55,"reason":"Probably one topic"}'))
      const service = ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
      service.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: true })
      const next = appendClosedTurn(current, 2, 'compare a new warranty region', 'new answer')

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
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('request_context_branch')
    await ctx.plugin(ContextifyBranchTool)
    const missingAgent = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('request-branch-without-agent'),
      name: 'request_context_branch',
      arguments: { reason: 'A request must have an owning Agent.' },
    })
    expect(missingAgent.isError).toBe(true)
    expect(missingAgent.error?.message).toContain('active Agent')
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

  it('defaults to a Local review without resolving or calling a model', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('local-no-model'))
    const { agent } = start(session, { provider: 'mock', model: 'mock' })
    appendClosedTurn(session, 1, 'Write a comparison', 'Earlier draft')
    let calls = 0
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        calls += 1
        throw new Error('Local review must not call a model')
      }
    }())
    const view = ctx.contextify.get(agent)
    const graph = await ctx.contextify.familyPage(agent)
    const proposal = await ctx.contextify.recommend(agent, {
      activeSessionId: session.id, planRevision: view.plan.revision, graphRevision: graph.revision,
    }, 'Write the comparison with the earlier material')
    expect(proposal.mode).toBe('local')
    expect(proposal.selection).toEqual([])
    expect(calls).toBe(0)
    expect(ctx.contextify.get(agent).plan.revision).toBe(view.plan.revision)
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
    }, 'x'.repeat(200_000), 'fast')

    expect(proposal.selection).toMatchObject([{ action: 'exclude', reason: 'Superseded' }])
    expect(captured?.tools).toBeUndefined()
    expect(captured?.maxTokens).toBeLessThanOrEqual(800)
    expect(captured?.temperature).toBe(0)
    expect(captured?.reasoningEffort).toBe(ReasoningEffortId('off'))
    expect(JSON.stringify(captured?.messages).length).toBeLessThan(102_000)
    expect(proposal.mode).toBe('fast')
    expect(JSON.stringify(captured?.messages)).toContain('recent-active')
    expect(ctx.sessions.list()).toHaveLength(1)
    expect(session.seq).toBe(before + 1)

    await ctx.contextify.presentRecommendation(active.agent, { ...proposal, selection: [] }, 'contextify-client')
    expect(session.seq).toBe(before + 1)
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
    expect(session.seq).toBe(before + 2)
    await ctx.contextify.dismissRecommendation(active.agent, proposal, 'contextify-client')
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-dismissed')?.data)
      .toMatchObject({ mode: 'fast', base: proposal.base, uiOrigin: 'contextify-client',
        selection: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, action: 'exclude' }],
        archiveNodeIds: [] })
    expect(ctx.contextify.get(active.agent).plan.revision).toBe(view.plan.revision)
    await expect(ctx.contextify.dismissRecommendation(active.agent, proposal, 'contextify-client'))
      .rejects.toThrow('unavailable')
    const afterDismiss = await ctx.contextify.familyPage(active.agent, undefined, 100)
    await ctx.contextify.recommend(active.agent, { ...proposal.base, graphRevision: afterDismiss.revision }, undefined, 'fast')

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

  it('retains dismissed item feedback and stops repeating only the explicitly declined change', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('dismissed-item-repeat'))
    const active = start(session, { provider: 'mock', model: 'mock' })
    const first = appendClosedTurn(session, 1, 'old requirement', 'first answer')
    const second = appendClosedTurn(session, 2, 'other requirement', 'second answer')
    const firstId = `${session.id}:${String(first.userSeq)}`
    const secondId = `${session.id}:${String(second.userSeq)}`
    ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
      override async * stream(): AsyncIterable<StreamChunk> {
        const text = JSON.stringify({ exclude: [firstId, secondId].map(nodeId => ({
          nodeId, reason: 'May be obsolete',
        })), include: [], archive: [] })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const objective = 'Write the comparison with current requirements'
    const before = ctx.contextify.get(active.agent)
    const graph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const proposal = await ctx.contextify.recommend(active.agent, {
      planRevision: before.plan.revision, graphRevision: graph.revision, activeSessionId: session.id,
    }, objective, 'fast', true)
    await ctx.contextify.dismissRecommendation(active.agent, proposal, 'contextify-client', [firstId])
    expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-dismissed')?.data)
      .toMatchObject({ objective, declinedNodeIds: [firstId] })
    expect(ctx.contextify.get(active.agent).plan.revision).toBe(before.plan.revision)
    expect((await ctx.contextify.stewardProfile(active.agent)).release.support).toBe(0.5)
    const next = await ctx.contextify.recommend(active.agent, proposal.base, objective, 'fast', true)
    expect(next.selection.map(item => item.nodeId)).toEqual([secondId])
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
    }, undefined, 'fast')
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
    }, 'Draft the new regional comparison', 'fast')
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
    }, undefined, 'fast')
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
    }, 'vendor regional repair terms', 'fast')
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
    }, 'vendor regional repair terms', 'fast')
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
    expect(evidence.snapshotEvents().filter(event => event.type === 'contextify/plan')).toHaveLength(0)
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
    }, 'vendor regional repair terms', 'fast')
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
    }, 'vendor regional repair terms', 'fast')
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
    }, 'The calendar photo needs a color correction', 'fast')
    expect(firstProposal.selection).toMatchObject([{ nodeId: priceId, action: 'exclude' }])
    await ctx.contextify.setNodeModes(active.agent, { revision: firstView.plan.revision },
      [{ node: priceRef, mode: 'exclude' }], firstGraph.revision, 'contextify-client')
    appendClosedTurn(session, 2, 'I will buy the calendar now; use its quoted price', 'Ready to check out')
    const secondView = ctx.contextify.get(active.agent)
    const secondGraph = await ctx.contextify.familyPage(active.agent, undefined, 100)
    const secondProposal = await ctx.contextify.recommend(active.agent, {
      planRevision: secondView.plan.revision, graphRevision: secondGraph.revision,
      activeSessionId: session.id,
    }, 'I will buy the calendar now; use its quoted price', 'fast')
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
    }, 'Continue the order', 'fast')
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
    }, 'continue camera comparison on the new budget', 'fast')
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
    }, 'continue camera comparison on the new budget', 'fast')
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
    }, undefined, 'fast')
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
    expect(initial.plan).toMatchObject({ revision: 1, excluded: [], included: [] })
    const before = activeSession.seq
    const included = await ctx.contextify.setNodeMode(
      active.agent,
      { revision: initial.plan.revision },
      { sessionId: sibling.id, seq: siblingTurn.userSeq },
      'include',
      'contextify-client',
    )
    expect(activeSession.snapshotEvents().slice(before).map(event => event.type))
      .toEqual(['context/compiler-snapshot', 'contextify/plan', 'contextify/plan',
        'context/compiler', 'contextify/node-choice'])
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
      }, 'Review the planetary orbital report', 'fast')
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

  it('suggests an exact Web-source correction before Send without a model call or automatic Plan edit', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('web-explicit-correction'))
      const { agent } = start(session, { provider: 'mock', model: 'mock' })
      appendClosedTurn(session, 1, 'Compare two supplier reports', 'I found two reports.')
      const addWebResult = (turn: number, url: string, text: string) => {
        const callId = CallId(`web-correction-${String(turn)}`)
        session.append('turn/start', { turn })
        const call = session.append('tool/call', { turn, step: 1, callId,
          name: 'web_fetch', arguments: JSON.stringify({ url }) })
        const result = session.append('tool/result', { turn, step: 1,
          message: createToolResultMessage({ callId,
            content: [{ type: 'text', text }], isError: false }),
        }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
        return result.seq
      }
      addWebResult(2, 'https://research.test/valid',
        'VALID-WEB-REPORT mentions https://research.test/unbound only in page text')
      const revokedSeq = addWebResult(3, 'https://research.test/revoked', 'REVOKED-WEB-REPORT')
      let modelCalls = 0
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          modelCalls += 1
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
        planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: session.id,
      }, 'Ignore https://research.test/revoked. Continue comparing the reports.', 'fast', true)
      expect(modelCalls).toBe(0)
      expect(proposal.selection).toMatchObject([{ nodeId: `${session.id}:${String(revokedSeq)}`,
        action: 'exclude' }])
      expect(ctx.contextify.get(agent).plan.excluded).toHaveLength(0)
      await ctx.contextify.setNodeModes(agent, { revision: view.plan.revision }, [
        { node: { sessionId: session.id, seq: revokedSeq }, mode: 'exclude' },
      ], page.revision, 'contextify-client')
      const request = JSON.stringify(compileContextify({ session, turn: 4, step: 1 }).messages)
      expect(request).toContain('VALID-WEB-REPORT')
      expect(request).not.toContain('REVOKED-WEB-REPORT')
      expect(session.snapshotEvents().some(event => event.type === 'contextify/recommendation-reviewed'
        && event.data.uiOrigin === 'contextify-client')).toBe(true)
      const excluded = ctx.contextify.get(agent)
      const excludedPage = await ctx.contextify.familyPage(agent)
      const restore = await ctx.contextify.recommend(agent, {
        planRevision: excluded.plan.revision, graphRevision: excludedPage.revision,
        activeSessionId: session.id,
      }, 'Use https://research.test/revoked again for this answer.', 'fast', true)
      expect(modelCalls).toBe(0)
      expect(restore.selection).toMatchObject([{ nodeId: `${session.id}:${String(revokedSeq)}`,
        action: 'include' }])
      await ctx.contextify.setNodeModes(agent, { revision: excluded.plan.revision }, [
        { node: { sessionId: session.id, seq: revokedSeq }, mode: 'natural' },
      ], excludedPage.revision, 'contextify-client')
      expect(JSON.stringify(compileContextify({ session, turn: 4, step: 1 }).messages))
        .toContain('REVOKED-WEB-REPORT')
      const after = ctx.contextify.get(agent)
      const afterPage = await ctx.contextify.familyPage(agent)
      const spoof = await ctx.contextify.recommend(agent, {
        planRevision: after.plan.revision, graphRevision: afterPage.revision,
        activeSessionId: session.id,
      }, 'Ignore https://research.test/unbound.', 'fast', true)
      expect(spoof.selection).toEqual([])
      expect(modelCalls).toBe(1)
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

  it('records branch lifecycle with a graph revision without changing prompt selection', async () => {
    const { ctx, start } = await harness()
    try {
      const root = ctx.sessions.create(SessionId('lifecycle-main'))
      const { agent } = start(root)
      const prefix = appendClosedTurn(root, 1, 'Plan a report', 'First plan ready.')
      const child = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('lifecycle-draft'))
      appendClosedTurn(child, 2, 'Draft the report', 'Draft ready.')
      const before = await ctx.contextify.familyPage(agent)
      const planRevision = ctx.contextify.get(agent).plan.revision
      const compiledBefore = JSON.stringify(compileContextify({ session: root, turn: 2, step: 1 }).messages)
      await ctx.contextify.setWorkState(agent, child.id, 'completed', before.revision, 'contextify-client')
      const after = await ctx.contextify.familyPage(agent)
      expect(after.sessions.find(session => session.id === child.id)).toMatchObject({
        workState: 'completed', workStateSource: 'explicit',
      })
      expect(after.revision).not.toBe(before.revision)
      expect(ctx.contextify.get(agent).plan.revision).toBe(planRevision)
      expect(JSON.stringify(compileContextify({ session: root, turn: 2, step: 1 }).messages))
        .toBe(compiledBefore)
      await expect(ctx.contextify.setWorkState(agent, child.id, 'open', before.revision,
        'contextify-client')).rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_GRAPH' })
      await ctx.contextify.setWorkState(agent, child.id, 'open', after.revision, 'contextify-client')
      expect((await ctx.contextify.familyPage(agent)).sessions.find(session => session.id === child.id)
        ?.workState).toBe('open')
    } finally { await ctx.fiber.dispose() }
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

  it('does not publish a pre-reset Local proposal after the final family read resumes', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('reset-await-local'))
    appendClosedTurn(session, 1, 'Plan the article')
    const { agent } = start(session)
    const page = await ctx.contextify.familyPage(agent)
    const base = { planRevision: ctx.contextify.get(agent).plan.revision,
      graphRevision: page.revision, activeSessionId: session.id }
    const objective = 'New topic: draft a separate article'
    const previous = await ctx.contextify.recommend(agent, base, objective, 'local', true)
    const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
    let calls = 0
    let announce!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { announce = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async () => {
      calls += 1
      // Initial family, Profile index, then final family validation.
      if (calls === 3) { announce(); await gate }
      return await list()
    })
    try {
      const running = ctx.contextify.recommend(agent, base, objective, 'local', true)
      const cancelled = expect(running).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' })
      await reached
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      release()
      await cancelled
      await ctx.contextify.presentRecommendation(agent, previous, 'contextify-client')
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-presented'))
        .toHaveLength(0)
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
    } finally {
      release()
      spy.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('does not cache pre-reset inspections under the post-reset live cursor', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('reset-cache-interleaving'))
    const turn = appendClosedTurn(session, 1, 'Plan the article')
    const child = ctx.sessions.fork(session, SessionSeq(turn.boundary), SessionId('reset-cache-child'))
    appendClosedTurn(child, 2, 'Write the draft')
    const { agent } = start(session)
    const page = await ctx.contextify.familyPage(agent)
    await ctx.contextify.recordManualRoute(agent, child.id, 'before-cache-reset', page.revision,
      'contextify-client', 'Continue writing the draft')
    const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
    let calls = 0
    let announce!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { announce = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async () => {
      calls += 1
      // The family snapshot is frozen before the Profile index reads live cursors.
      if (calls === 2) { announce(); await gate }
      return await list()
    })
    try {
      const projecting = ctx.contextify.stewardProfile(agent)
      await reached
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      release()
      expect((await projecting).destination.support).toBe(0)
      expect((await ctx.contextify.stewardProfile(agent)).destination.support).toBe(0)
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
    } finally {
      release()
      spy.mockRestore()
      await ctx.fiber.dispose()
    }
  })


  it('accepts a fresh lifecycle review after rejecting the same draft at the same graph and Plan', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('lifecycle-reconsider'))
      appendClosedTurn(session, 1, 'Plan the article')
      const { agent } = start(session)
      const page = await ctx.contextify.familyPage(agent)
      const before = ctx.contextify.get(agent).plan
      const base = { planRevision: before.revision, graphRevision: page.revision, activeSessionId: session.id }
      const objective = 'Park this task until tomorrow'
      const first = await ctx.contextify.recommend(agent, base, objective, 'local', true)
      await ctx.contextify.reviewWorkState(agent, first, session.id, 'reject', 'contextify-client')
      expect((await ctx.contextify.familyPage(agent)).revision).toBe(base.graphRevision)
      expect((await ctx.contextify.familyPage(agent)).sessions[0]?.workState).toBe('open')
      const reconsidered = await ctx.contextify.recommend(agent, base, objective, 'local', true)
      await ctx.contextify.reviewWorkState(agent, reconsidered, session.id, 'accept', 'contextify-client')
      expect((await ctx.contextify.familyPage(agent)).sessions[0]?.workState).toBe('parked')
      expect(ctx.contextify.get(agent).plan).toEqual(before)
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/work-state-choice')
        .map(event => event.data.choice)).toEqual(['reject', 'accept'])
    } finally { await ctx.fiber.dispose() }
  })


  it('rejects a lifecycle acceptance cleared by reset during its pending family read', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('lifecycle-reset-await'))
    appendClosedTurn(session, 1, 'Plan the article')
    const { agent } = start(session)
    const page = await ctx.contextify.familyPage(agent)
    const before = ctx.contextify.get(agent).plan
    const proposal = await ctx.contextify.recommend(agent, {
      planRevision: before.revision, graphRevision: page.revision, activeSessionId: session.id,
    }, 'Park this task until tomorrow', 'local', true)
    const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
    let calls = 0
    let announce!: () => void
    let release!: () => void
    const reached = new Promise<void>((resolve) => { announce = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const spy = vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async () => {
      calls += 1
      if (calls === 1) { announce(); await gate }
      return await list()
    })
    try {
      const reviewing = ctx.contextify.reviewWorkState(agent, proposal, session.id, 'accept', 'contextify-client')
      const cleared = expect(reviewing).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
      await reached
      await ctx.contextify.resetPolicy(agent, 'contextify-client')
      release()
      await cleared
      expect((await ctx.contextify.familyPage(agent)).sessions[0]?.workState).toBe('open')
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/work-state-choice')).toHaveLength(0)
      expect(ctx.contextify.get(agent).plan).toEqual(before)
    } finally {
      release()
      spy.mockRestore()
      await ctx.fiber.dispose()
    }
  })


  it('records no manual-route label for stale, foreign, empty, unmarked or reused transfers', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('manual-route-invalid'))
      const turn = appendClosedTurn(session, 1, 'Plan the article')
      const first = ctx.sessions.fork(session, SessionSeq(turn.boundary), SessionId('manual-route-first'))
      const second = ctx.sessions.fork(session, SessionSeq(turn.boundary), SessionId('manual-route-second'))
      const { agent } = start(session)
      const page = await ctx.contextify.familyPage(agent)
      const objective = 'Continue the source lookup'
      await ctx.contextify.recordManualRoute(agent, first.id, 'original-transfer', page.revision,
        'contextify-client', objective)
      const cases = [
        { target: first.id, id: 'stale-transfer', revision: 'stale', origin: 'contextify-client' as const,
          goal: objective, code: 'CONTEXTIFY_STALE_GRAPH' },
        { target: SessionId('foreign-family'), id: 'foreign-transfer', revision: page.revision,
          origin: 'contextify-client' as const, goal: objective, code: 'CONTEXTIFY_CROSS_FAMILY' },
        { target: session.id, id: 'current-transfer', revision: page.revision,
          origin: 'contextify-client' as const, goal: objective, code: 'CONTEXTIFY_INVALID_TRANSITION' },
        { target: first.id, id: 'empty-transfer', revision: page.revision,
          origin: 'contextify-client' as const, goal: '', code: 'CONTEXTIFY_INVALID_TRANSITION' },
        { target: first.id, id: 'unmarked-transfer', revision: page.revision,
          origin: undefined, goal: objective, code: 'CONTEXTIFY_INVALID_TRANSITION' },
        { target: second.id, id: 'original-transfer', revision: page.revision,
          origin: 'contextify-client' as const, goal: objective, code: 'CONTEXTIFY_INVALID_TRANSITION' },
        { target: first.id, id: 'original-transfer', revision: page.revision,
          origin: 'contextify-client' as const, goal: 'Another draft', code: 'CONTEXTIFY_INVALID_TRANSITION' },
        { target: first.id, id: '', revision: page.revision,
          origin: 'contextify-client' as const, goal: objective, code: 'CONTEXTIFY_INVALID_TRANSITION' },
        { target: first.id, id: 'x'.repeat(129), revision: page.revision,
          origin: 'contextify-client' as const, goal: objective, code: 'CONTEXTIFY_INVALID_TRANSITION' },
      ]
      for (const item of cases) {
        await expect(ctx.contextify.recordManualRoute(agent, item.target, item.id, item.revision,
          item.origin, item.goal)).rejects.toMatchObject({ code: item.code })
      }
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/manual-route')).toHaveLength(1)
      expect((await ctx.contextify.stewardProfile(agent)).destination.support).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

})

describe('Contextify public operation boundaries', () => {
  async function pendingBranch(label: string) {
    const fixture = await harness()
    const session = fixture.ctx.sessions.create(SessionId(`guarded-branch-${label}`))
    const active = fixture.start(session)
    appendClosedTurn(session, 1, 'The original website plan', 'The shared constraints')
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Move this side topic into a branch.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    fixture.ctx.contextify.requestExplicitBranch(active.agent, 'A separate side task requested by the user')
    session.append('assistant/message', { stream: [], turn: 2, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'The side-task result' }], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await vi.waitFor(() => { expect(fixture.ctx.contextify.get(active.agent).branchSuggestion).toBeDefined() })
    const suggestion = fixture.ctx.contextify.get(active.agent).branchSuggestion
    if (suggestion === undefined) throw new Error('expected the explicit side-task suggestion')
    return { ...fixture, session, active, suggestion }
  }

  async function pendingRoute(label: string) {
    const fixture = await harness()
    const session = fixture.ctx.sessions.create(SessionId(`route-card-${label}`))
    const { agent } = fixture.start(session)
    const prefix = appendClosedTurn(session, 1, 'Plan the community website', 'The website launch checklist')
    fixture.ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({ exclude: [], include: [], archive: [],
      route: { intent: 'new-task', intentScore: 1, candidates: [] } })))
    const page = await fixture.ctx.contextify.familyPage(agent)
    const proposal = await fixture.ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'New task: write a press release about the event', 'fast', true)
    const route = proposal.route
    if (route?.action !== 'branch') throw new Error('expected a reviewed draft Branch route')
    return { ...fixture, session, agent, prefix, proposal, route }
  }

  function pauseNextCatalogRead(ctx: Context) {
    const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let pause = true
    const mock = vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async (...args) => {
      const rows = await original(...args)
      if (pause) {
        pause = false
        entered.resolve(undefined)
        await release.promise
      }
      return rows
    })
    return { entered: entered.promise, release: () => { release.resolve(undefined) }, restore: () => { mock.mockRestore() } }
  }

  it('reports unavailable temporary storage without preventing read-only Session startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contextify-unavailable-temp-'))
    const unavailable = join(directory, 'not-a-directory')
    await writeFile(unavailable, 'This path is a file, not temporary storage.')
    vi.stubEnv('TMPDIR', unavailable)
    vi.stubEnv('TEMP', unavailable)
    vi.stubEnv('TMP', unavailable)
    let context: Context | undefined
    try {
      const { ctx, start } = await harness()
      context = ctx
      const warn = vi.spyOn(ctx.logger, 'warn')
      const session = ctx.sessions.create(SessionId('unavailable-temp-startup'))
      const { agent } = start(session)
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('Deep snapshot cleanup failed')) })
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
      expect(session.snapshotEvents()).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await context?.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('loads and updates optional Profile settings without activating a Context Plan', async () => {
    const { ctx, start } = await harness()
    try {
      const fiber = await ctx.plugin(ContextTestSettings)
      const session = ctx.sessions.create(SessionId('optional-profile-settings'))
      const { agent } = start(session)
      const before = session.snapshotEvents()
      expect(ctx.settings.get('contextify')).toMatchObject({ automaticBranchReview: false, deepMaxRequests: 3 })
      await ctx.settings.update('contextify', { context: { additional: 'Keep my constraints together.' }, deepMaxRequests: 1 })
      expect(ctx.settings.get('contextify')).toMatchObject({ context: { additional: 'Keep my constraints together.' }, deepMaxRequests: 1 })
      expect(session.snapshotEvents()).toEqual(before)
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
      await fiber.dispose()
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('distinguishes unchanged selections from equally sized replacements of their node IDs', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('same-size-selection-edit'))
      const { agent } = start(session)
      const first = appendClosedTurn(session, 1, 'First constraint')
      const second = appendClosedTurn(session, 2, 'Second constraint')
      let view = await ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: session.id, seq: first.userSeq }, 'exclude')
      view = await ctx.contextify.setNodeMode(agent, { revision: view.plan.revision }, { sessionId: session.id, seq: first.userSeq }, 'exclude')
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')?.data).toMatchObject({ changed: false })
      view = await ctx.contextify.setNodeModes(agent, { revision: view.plan.revision }, [
        { node: { sessionId: session.id, seq: first.userSeq }, mode: 'natural' },
        { node: { sessionId: session.id, seq: second.userSeq }, mode: 'exclude' },
      ])
      expect(view.plan.excluded.map(item => item.nodeId)).toEqual([`${session.id}:${String(second.userSeq)}`])
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')?.data).toMatchObject({ changed: true })
    } finally { await ctx.fiber.dispose() }
  })

  it('uses the reviewed excerpt when assembling a later Fast proposal, preserving the original source', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('excerpt-recommendation-text'))
      const { agent } = start(session)
      const original = 'Keep the date; ignore the obsolete venue.'
      const turn = appendClosedTurn(session, 1, original, 'A public event plan')
      const view = await ctx.contextify.focusNodeExcerpt(agent, { revision: 1 }, { sessionId: session.id, seq: turn.userSeq }, 0, 13, 'Only the date still applies', 'contextify-client')
      const adapter = new MockAdapter([textResponse('{"exclude":[],"include":[],"archive":[]}')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const page = await ctx.contextify.familyPage(agent)
      await ctx.contextify.recommend(agent, { planRevision: view.plan.revision, graphRevision: page.revision, activeSessionId: session.id }, 'Write the event announcement', 'fast')
      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Keep the date')
      expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('obsolete venue')
      expect(session.eventAt(SessionSeq(turn.userSeq))?.data).toMatchObject({ content: [{ type: 'text', text: original }] })
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['invalid-json', 'provider-error', 'unexpected-tool'] as const)('fails closed for %s and releases the family review lock', async (failure) => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId(`failed-fast-${failure}`))
      const { agent } = start(session)
      appendClosedTurn(session, 1, 'Plan the community website', 'A first answer')
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          if (failure === 'provider-error') throw new Error('fixture provider unavailable')
          if (failure === 'unexpected-tool') {
            const id = CallId('unexpected-fast-tool')
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: 0, id, name: 'bash', argumentsDelta: '{}' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'bash', arguments: '{}' } }
          } else {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'text-delta', index: 0, text: 'No structured decision' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No structured decision' } }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      const view = ctx.contextify.get(agent)
      const page = await ctx.contextify.familyPage(agent)
      const base = { planRevision: view.plan.revision, graphRevision: page.revision, activeSessionId: session.id }
      await expect(ctx.contextify.recommend(agent, base, 'Publish the website plan', 'fast')).rejects.toMatchObject({
        code: failure === 'unexpected-tool' ? 'CONTEXTIFY_INVALID_RECOMMENDATION' : 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE',
      })
      expect(ctx.contextify.get(agent).plan).toEqual(view.plan)
      const current = await ctx.contextify.familyPage(agent)
      await expect(ctx.contextify.recommend(agent, { ...base, graphRevision: current.revision }, 'Publish the website plan', 'local')).resolves.toMatchObject({ mode: 'local' })
    } finally { await ctx.fiber.dispose() }
  })

  it('migrates a revisionless legacy record once and resumes the resulting owned plan unchanged', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('revisionless-legacy'))
      // Historical persisted formats are intentionally outside the v3 append vocabulary.
      session.append('contextify/plan', { kind: 'contextify/plan', version: 1, paths: [] } as never)
      const { agent } = start(session)
      expect(ctx.contextify.get(agent).plan).toMatchObject({ version: 3, revision: 1, included: [], excluded: [] })
      const before = session.snapshotEvents()
      agentEvents(ctx, agent).emit('agent/session-start', { source: 'startup' })
      expect(session.snapshotEvents()).toEqual(before)
      expect(ctx.contextCompiler.descriptor(session).id).toBe('contextify')
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects invalid pagination and unsupported direct-human Branch requests without writes', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('public-read-guards'))
      const { agent } = start(session)
      const before = session.snapshotEvents()
      for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(ctx.contextify.familyPage(agent, offset)).rejects.toBeInstanceOf(RangeError)
      }
      for (const limit of [0, -1, 501, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(ctx.contextify.familyPage(agent, undefined, limit)).rejects.toBeInstanceOf(RangeError)
      }
      expect(() => { ctx.contextify.requestExplicitBranch(agent, '   ') }).toThrow(/non-empty/)
      expect(() => { ctx.contextify.requestExplicitBranch(agent, 'A separate task') }).toThrow(/direct human Turn/)
      const outsider = stubAgent(ctx.sessions.create(SessionId('unregistered-operation'))).agent
      expect(() => ctx.contextify.get(outsider)).toThrow(/not live/)
      expect(session.snapshotEvents()).toEqual(before)
    } finally { await ctx.fiber.dispose() }
  })

  it('requires an idle Agent and an explicit, current lifecycle choice, and makes duplicates no-ops', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('lifecycle-operation-guards'))
      const active = start(session)
      appendClosedTurn(session, 1, 'Plan a workshop', 'A draft plan')
      const graph = await ctx.contextify.familyPage(active.agent)
      const before = session.snapshotEvents()
      await expect(ctx.contextify.setWorkState(active.agent, session.id, 'completed', graph.revision))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      await expect(ctx.contextify.setWorkState(active.agent, SessionId('missing-lifecycle-target'), 'completed', graph.revision, 'contextify-client'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      await expect(ctx.contextify.resetPolicy(active.agent)).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      active.setStatus('running')
      await expect(ctx.contextify.setWorkState(active.agent, session.id, 'completed', graph.revision, 'contextify-client'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_AGENT_BUSY' })
      active.setStatus('idle')
      expect(session.snapshotEvents()).toEqual(before)
      await ctx.contextify.setWorkState(active.agent, session.id, 'completed', graph.revision, 'contextify-client')
      const completed = await ctx.contextify.familyPage(active.agent)
      expect(completed.sessions.find(item => item.id === session.id)).toMatchObject({ workState: 'completed', workStateSource: 'explicit' })
      const after = session.snapshotEvents()
      await ctx.contextify.setWorkState(active.agent, session.id, 'completed', completed.revision, 'contextify-client')
      expect(session.snapshotEvents()).toEqual(after)
    } finally { await ctx.fiber.dispose() }
  })

  it('resets explicit selection with reversible history and rejects empty Undo/Redo', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('reset-undo-history'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'Keep the launch constraints')
      expect(() => ctx.contextify.undo(agent, { revision: 1 })).toThrow(/no earlier state/)
      expect(() => ctx.contextify.redo(agent, { revision: 1 })).toThrow(/no later state/)
      const selected = await ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: session.id, seq: turn.userSeq }, 'exclude')
      const reset = ctx.contextify.reset(agent, { revision: selected.plan.revision })
      expect(reset.plan.excluded).toEqual([])
      const undone = ctx.contextify.undo(agent, { revision: reset.plan.revision })
      expect(undone.plan.excluded).toHaveLength(1)
      const redone = ctx.contextify.redo(agent, { revision: undone.plan.revision })
      expect(redone.plan.excluded).toEqual([])
      expect(ctx.contextCompiler.compile({ session, turn: 2, step: 1 }).messages).toEqual(session.deriveMessages())
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects stale or invalid archives and requires restoration before a second replacement', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('archive-operation-guards'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'One plan with mixed old and new facts', 'The first answer')
      const node = { sessionId: session.id, seq: turn.userSeq }
      const before = session.snapshotEvents()
      for (const reason of [' ', 'x'.repeat(1001)]) {
        await expect(ctx.contextify.archiveNode(agent, { revision: 1 }, node, reason))
          .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      }
      await expect(ctx.contextify.archiveNode(agent, { revision: 1 }, node, 'obsolete', 'stale-graph'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_GRAPH' })
      await expect(ctx.contextify.archiveNode(agent, { revision: 1 }, { sessionId: session.id, seq: 999 }, 'obsolete'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_NODE' })
      expect(session.snapshotEvents()).toEqual(before)
      const archived = await ctx.contextify.archiveNode(agent, { revision: 1 }, node, 'obsolete')
      await expect(ctx.contextify.archiveNode(agent, { revision: archived.plan.revision }, node, 'obsolete'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      await expect(ctx.contextify.focusNodeExcerpt(agent, { revision: archived.plan.revision }, node, 0, 3, 'Keep the new part'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      const otherNode = { sessionId: session.id, seq: turn.userSeq + 1 }
      await expect(ctx.contextify.restoreNode(agent, { revision: archived.plan.revision }, otherNode))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      await expect(ctx.contextify.restoreNode(agent, { revision: archived.plan.revision }, { sessionId: session.id, seq: 999 }))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_NODE' })
      expect(ctx.contextify.get(agent).plan.revision).toBe(archived.plan.revision)
    } finally { await ctx.fiber.dispose() }
  })

  it('preserves an existing replacement when another chat node is archived', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('independent-archive-overlays'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'An obsolete request', 'Its obsolete response')
      const first = await ctx.contextify.archiveNode(agent, { revision: 1 }, { sessionId: session.id, seq: turn.userSeq }, 'First obsolete item')
      const second = await ctx.contextify.archiveNode(agent, { revision: first.plan.revision }, { sessionId: session.id, seq: turn.userSeq + 1 }, 'Second obsolete item')
      expect(second.plan.replacements.map(item => item.nodeId)).toEqual([
        `${session.id}:${String(turn.userSeq)}`, `${session.id}:${String(turn.userSeq + 1)}`,
      ])
      expect(second.plan.replacements[0]).toEqual(first.plan.replacements[0])
      const graph = await ctx.contextify.familyPage(agent)
      expect(graph.records.filter(node => node.replacement?.kind === 'placeholder')).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps a manually imported Web pin until the user explicitly changes its Context control', async () => {
    const { ctx, start } = await harness()
    try {
      const root = ctx.sessions.create(SessionId('explicit-imported-web-root'))
      const { agent } = start(root)
      const prefix = appendClosedTurn(root, 1, 'Compare event venues', 'Initial constraints')
      const source = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId('explicit-imported-web-source'))
      const callId = CallId('imported-web-call')
      source.append('turn/start', { turn: 2 })
      const call = source.append('tool/call', { turn: 2, step: 1, callId, name: 'web_fetch', arguments: '{"url":"https://venues.test/old"}' })
      const result = source.append('tool/result', { turn: 2, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'The old venue is available.' }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
      source.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const included = await ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: source.id, seq: result.seq }, 'include', 'contextify-client')
      const graph = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: included.plan.revision, graphRevision: graph.revision, activeSessionId: root.id }, 'Ignore https://venues.test/old. Keep comparing venues.', 'local', true)
      expect(proposal.selection).toEqual([])
      expect(ctx.contextify.get(agent).plan.included).toEqual(included.plan.included)
      const restored = await ctx.contextify.setNodeMode(agent, { revision: included.plan.revision },
        { sessionId: source.id, seq: result.seq }, 'natural', 'contextify-client')
      expect(restored.plan.included).toEqual([])
      expect(root.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('old venue')))).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not turn a worker relay into portable chat evidence or a conversation placeholder', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('worker-context-boundary'))
      const { agent } = start(session)
      const prefix = appendClosedTurn(session, 1, 'Original planning task')
      const activeRelay = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'A worker-only draft report' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('worker-sender') },
      }), { surfaceOp: 'append' })
      const child = ctx.sessions.fork(session, SessionSeq(prefix.boundary), SessionId('worker-report-branch'))
      const foreignRelay = child.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'An unbound worker report in another branch' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: SessionId('other-worker') },
      }), { surfaceOp: 'append' })
      const before = session.snapshotEvents()
      await expect(ctx.contextify.archiveNode(agent, { revision: 1 }, { sessionId: session.id, seq: activeRelay.seq }, 'Retire this report'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      await expect(ctx.contextify.getNodeText(agent, { sessionId: session.id, seq: activeRelay.seq }))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      await expect(ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: child.id, seq: foreignRelay.seq }, 'include'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      expect(session.snapshotEvents()).toEqual(before)
    } finally { await ctx.fiber.dispose() }
  })

  it('continues a bounded Branch review when historical Profile catalog I/O is unavailable', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('branch-profile-fallback'))
      for (let turn = 1; turn <= 5; turn++) appendClosedTurn(session, turn, `Original topic ${turn}`, `Original answer ${turn}`)
      const { agent } = start(session, { provider: 'mock', model: 'mock' })
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const original = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(original)
        .mockImplementationOnce(original).mockRejectedValueOnce(new Error('Profile catalog temporarily unavailable'))
      const warn = vi.spyOn(ctx.logger, 'warn')
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter('{"action":"suggest_branch","confidence":0.97,"reason":"A separate task"}'))
      const last = appendClosedTurn(session, 6, 'Write a separate announcement', 'The announcement draft')
      await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('Profile Branch feedback unavailable')) })
      await vi.waitFor(() => { expect(ctx.contextify.get(agent).branchSuggestion?.reason).toBe('A separate task') })
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')?.data).toMatchObject({ turnEndSeq: last.boundary })
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('drops a post-Turn Branch suggestion when a native recall arrives during its catalog read', async () => {
    const { ctx, start } = await harness()
    const session = ctx.sessions.create(SessionId('branch-recall-during-finalize'))
    const { agent } = start(session)
    appendClosedTurn(session, 1, 'The main planning task', 'Initial planning constraints')
    const pause = pauseNextCatalogRead(ctx)
    try {
      session.append('turn/start', { turn: 2 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Put this separate idea in a branch' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      ctx.contextify.requestExplicitBranch(agent, 'The separate idea requested by the user')
      session.append('assistant/message', { stream: [], turn: 2, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'The idea response' }], source: { provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await pause.entered
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'A newly recalled planning constraint' }],
        source: { kind: 'plugin', plugin: 'fixture-recall', form: 'recall' } }), { surfaceOp: 'append' })
      pause.release()
      await ctx.contextify.familyPage(agent)
      // One event-loop boundary settles the released mock persistence promises;
      // no timer or hidden service method is used to advance the background review.
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(session.snapshotEvents().some(event => event.type === 'contextify/branch-review')).toBe(false)
      expect(ctx.contextify.get(agent).branchSuggestion).toBeUndefined()
      expect(session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('newly recalled')))).toBe(true)
    } finally {
      pause.release()
      pause.restore()
      await ctx.fiber.dispose()
    }
  })

  it.each(['failed-result', 'empty-result', 'unbound-call'] as const)(
    'refuses importing %s Web observations without weakening their native provenance', async (condition) => {
      const { ctx, start } = await harness()
      try {
        const root = ctx.sessions.create(SessionId(`unimportable-web-${condition}`))
        const { agent } = start(root)
        const prefix = appendClosedTurn(root, 1, 'Compare current plans')
        const child = ctx.sessions.fork(root, SessionSeq(prefix.boundary), SessionId(`unimportable-web-child-${condition}`))
        const callId = CallId(`unimportable-web-call-${condition}`)
        child.append('turn/start', { turn: 2 })
        const call = child.append('tool/call', { turn: 2, step: 1, callId, name: 'web_fetch', arguments: '{"url":"https://evidence.test/page"}' })
        const result = child.append('tool/result', { turn: 2, step: 1, message: createToolResultMessage({ callId,
          content: condition === 'empty-result' ? [] : [{ type: 'text', text: 'A Web observation' }],
          isError: condition === 'failed-result' }),
        }, { surfaceOp: 'append', sourceEventSeqs: condition === 'unbound-call' ? [SessionSeq(0)] : [SessionSeq(call.seq)] })
        child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
        const before = root.snapshotEvents()
        await expect(ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: child.id, seq: result.seq }, 'include'))
          .rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
        expect(root.snapshotEvents()).toEqual(before)
      } finally { await ctx.fiber.dispose() }
    })

  it('projects image and file references conservatively into review text without forwarding attachment handles', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('multimodal-context-review-text'))
      const { agent } = start(session)
      const image = { type: 'image' as const, attachment: { attachmentId: AttachmentId('opaque-image-reference'), mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 } }
      const file = { type: 'file' as const, attachment: { attachmentId: AttachmentId('opaque-file-reference'), name: 'notes.txt', bytes: 1 } }
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Compare this plan diagram' }, image, file], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('assistant/message', { stream: [], turn: 1, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'A text answer' }, { type: 'reasoning', text: 'Private intermediate thought' }], source: { provider: 'mock', model: 'mock' } }),
      }, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const callId = CallId('multimodal-web-result')
      const call = session.append('tool/call', { turn: 2, step: 1, callId, name: 'web_fetch', arguments: '{"url":"https://diagram.test"}' })
      session.append('tool/result', { turn: 2, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'A source caption' }, image, file], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
      const adapter = new MockAdapter([textResponse('{"exclude":[],"include":[],"archive":[]}')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const page = await ctx.contextify.familyPage(agent)
      await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Compare the design evidence', 'fast')
      const request = JSON.stringify(adapter.requests[0]?.messages)
      expect(request).toContain('[Image]')
      expect(request).toContain('A source caption')
      expect(request).not.toContain('opaque-image-reference')
      expect(request).not.toContain('opaque-file-reference')
      expect(request).not.toContain('Private intermediate thought')
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['', 'invalid JSON', '{}', '[]', '{"url":17}'])(
    'does not treat malformed Web arguments as an exact source URL: %s', async (argumentsText) => {
      const { ctx, start } = await harness()
      try {
        const session = ctx.sessions.create(SessionId(`malformed-url-${argumentsText.length}`))
        const { agent } = start(session)
        appendClosedTurn(session, 1, 'Compare the venue sources', 'A first comparison')
        const callId = CallId('malformed-web-url')
        const call = session.append('tool/call', { turn: 2, step: 1, callId, name: 'web_fetch', arguments: argumentsText })
        session.append('tool/result', { turn: 2, step: 1,
          message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Page text mentions https://venue.test but does not bind its provenance.' }], isError: false }),
        }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
        const adapter = new MockAdapter([textResponse('{"exclude":[],"include":[],"archive":[]}')])
        ctx.llm.registerAdapter(['mock'], adapter)
        const page = await ctx.contextify.familyPage(agent)
        const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Ignore https://venue.test. Continue comparing venues.', 'fast', true)
        expect(adapter.requests).toHaveLength(1)
        expect(proposal.selection).toEqual([])
        expect(ctx.contextify.get(agent).plan.excluded).toEqual([])
      } finally { await ctx.fiber.dispose() }
    })

  it('rejects invalid excerpt text, bounds, origins and empty selections without changing context', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('excerpt-operation-guards'))
      const { agent } = start(session)
      const first = appendClosedTurn(session, 1, 'abc   def')
      const node = { sessionId: session.id, seq: first.userSeq }
      const child = ctx.sessions.fork(session, SessionSeq(first.boundary), SessionId('excerpt-off-path'))
      const offPath = appendClosedTurn(child, 2, 'A sibling-only requirement')
      session.append('turn/start', { turn: 2 })
      const mixed = session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      const before = session.snapshotEvents()
      for (const reason of [' ', 'x'.repeat(1001)]) {
        await expect(ctx.contextify.focusNodeExcerpt(agent, { revision: 1 }, node, 0, 3, reason))
          .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      }
      for (const [begin, end] of [[-1, 2], [0, 0], [3, 2], [0.5, 2], [0, 100], [Number.NaN, 2]] as const) {
        await expect(ctx.contextify.focusNodeExcerpt(agent, { revision: 1 }, node, begin, end, 'Keep part'))
          .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      }
      await expect(ctx.contextify.focusNodeExcerpt(agent, { revision: 1 }, node, 3, 6, 'Keep whitespace'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      await expect(ctx.contextify.getNodeText(agent, { sessionId: session.id, seq: 999 }))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_NODE' })
      await expect(ctx.contextify.focusNodeExcerpt(agent, { revision: 1 }, { sessionId: session.id, seq: 999 }, 0, 1, 'Keep part'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_NODE' })
      const siblingNode = { sessionId: child.id, seq: offPath.userSeq }
      await expect(ctx.contextify.getNodeText(agent, siblingNode)).rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      await expect(ctx.contextify.focusNodeExcerpt(agent, { revision: 1 }, siblingNode, 0, 1, 'Keep part'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      const mixedNode = { sessionId: session.id, seq: mixed.seq }
      await expect(ctx.contextify.getNodeText(agent, mixedNode)).rejects.toMatchObject({ code: 'CONTEXTIFY_UNSUPPORTED_MESSAGE' })
      await expect(ctx.contextify.focusNodeExcerpt(agent, { revision: 1 }, mixedNode, 0, 1, 'Keep part'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      expect(session.snapshotEvents()).toEqual(before)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects stale recommendation bases before any provider traffic', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('recommendation-base-guards'))
      const { agent } = start(session)
      appendClosedTurn(session, 1, 'Plan a public website')
      const page = await ctx.contextify.familyPage(agent)
      await expect(ctx.contextify.recommend(agent, { planRevision: 100, graphRevision: page.revision, activeSessionId: session.id }))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_REVISION' })
      await expect(ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: SessionId('wrong-active-session') }))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_GRAPH' })
      await expect(ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Website plan', 'fast'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
      expect(session.snapshotEvents().some(event => event.type === 'request/header')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a bounded Fast review rather than dropping mandatory manual overrides', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('mandatory-context-budget'))
      const { agent } = start(session)
      const turns = Array.from({ length: 33 }, (_, index) => appendClosedTurn(session, index + 1, `Pinned constraint ${index}`))
      const view = await ctx.contextify.setNodeModes(agent, { revision: 1 }, turns.map(turn => ({ node: { sessionId: session.id, seq: turn.userSeq }, mode: 'exclude' as const })))
      const page = await ctx.contextify.familyPage(agent)
      const before = session.snapshotEvents()
      await expect(ctx.contextify.recommend(agent, { planRevision: view.plan.revision, graphRevision: page.revision, activeSessionId: session.id }, 'Use a bounded review', 'fast'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_TOO_LARGE' })
      expect(session.snapshotEvents()).toEqual(before)
      expect(ctx.contextify.get(agent).plan.excluded).toHaveLength(33)
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses a model selection of a real graph source omitted from its bounded Fast packet', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('out-of-packet-source'))
      const { agent } = start(session)
      for (let turn = 1; turn <= 24; turn++) appendClosedTurn(session, turn, `Archived topic ${turn}`, `Archived reply ${turn}`)
      const page = await ctx.contextify.familyPage(agent)
      const objective = 'Write the launch announcement'
      const input = buildFastRecommendationInput({ graph: { ...page, nodes: page.records }, objective,
        contents: Object.fromEntries(page.records.map(node => [node.id, node.preview])),
        effectiveIncludedNodeIds: page.records.map(node => node.id), explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] })
      const shown = new Set(input.nodes.map(node => node.id))
      const omitted = page.records.find(node => !shown.has(node.id))
      if (omitted === undefined) throw new Error('long history must exceed the bounded source slate')
      const adapter = new MockAdapter([(options) => {
        const text = options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('')
        expect(text.split('Conversation graph JSON:\n')[1]).not.toContain(`"id":"${omitted.id}"`)
        return textResponse(JSON.stringify({ include: [], exclude: [{ nodeId: omitted.id, reason: 'A fabricated selection outside the packet' }], archive: [] }))
      }])
      ctx.llm.registerAdapter(['mock'], adapter)
      const review = ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, objective, 'fast')
      await expect(review).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
      await expect(review).rejects.toThrow(/outside its frozen candidate packet/)
      expect(adapter.requests).toHaveLength(1)
      expect(ctx.contextify.get(agent).plan.excluded).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses lifecycle advice for a native family branch outside the model Session slate', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('out-of-packet-lifecycle'))
      const { agent } = start(session)
      const prefix = appendClosedTurn(session, 1, 'Website launch planning', 'Shared constraints')
      for (let index = 0; index < 10; index++) {
        const child = ctx.sessions.fork(session, SessionSeq(prefix.boundary), SessionId(`slate-branch-${index}`))
        appendClosedTurn(child, 2, `Parallel work ${index}`, `Parallel result ${index}`)
      }
      const page = await ctx.contextify.familyPage(agent)
      const graph = { ...page, nodes: page.records }
      const contents = Object.fromEntries(page.records.map(node => [node.id, node.preview]))
      const base = { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }
      const objective = 'Write the website announcement'
      const input = buildFastRecommendationInput({ graph, contents, objective,
        effectiveIncludedNodeIds: page.records.filter(node => node.sessionIds.includes(session.id)).map(node => node.id),
        explicitIncludedNodeIds: [], explicitExcludedNodeIds: [] })
      const packet = buildContextActionPacket({ graph, contents, objective, base, visibleNodeIds: input.nodes.map(node => node.id) })
      const shown = new Set([session.id, ...packet.candidates.map(candidate => candidate.sessionId)])
      const omitted = page.sessions.find(candidate => !shown.has(candidate.id))
      if (omitted === undefined) throw new Error('parallel branches must exceed the bounded Session slate')
      const adapter = new MockAdapter([textResponse(JSON.stringify({ include: [], exclude: [], archive: [],
        workStates: [{ sessionId: omitted.id, state: 'completed', reason: 'An unobserved task was guessed complete' }] }))])
      ctx.llm.registerAdapter(['mock'], adapter)
      const review = ctx.contextify.recommend(agent, base, objective, 'fast')
      await expect(review).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
      await expect(review).rejects.toThrow(/outside its frozen candidate packet/)
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
      expect(session.snapshotEvents().some(event => event.type === 'contextify/work-state')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['plan', 'graph'] as const)('refuses a Fast result after its %s changes while the model is running', async (changed) => {
    const { ctx, start } = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      const session = ctx.sessions.create(SessionId(`model-review-stale-${changed}`))
      const { agent } = start(session)
      const first = appendClosedTurn(session, 1, 'Plan a website', 'Initial constraints')
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          entered.resolve(undefined)
          await release.promise
          yield* textResponse('{"include":[],"exclude":[],"archive":[]}')
        }
      }())
      const page = await ctx.contextify.familyPage(agent)
      const pending = ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Draft the launch announcement', 'fast')
      const settled = pending.then(() => ({ status: 'fulfilled' as const }), (error: unknown) => ({ status: 'rejected' as const, error }))
      await entered.promise
      if (changed === 'plan') await ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: session.id, seq: first.userSeq }, 'exclude')
      else appendClosedTurn(session, 2, 'New website launch constraint', 'A revised plan')
      release.resolve(undefined)
      expect(await settled).toMatchObject({ status: 'rejected', error: { code: changed === 'plan' ? 'CONTEXTIFY_STALE_REVISION' : 'CONTEXTIFY_STALE_GRAPH' } })
      expect(session.snapshotEvents().some(event => event.type === 'contextify/recommendation-presented')).toBe(false)
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    }
  })

  it('ignores a Fast archive rather than proposing durable retirement from the bounded classifier', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('fast-forbidden-retirement'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'Original website plan', 'A first draft')
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({ include: [], exclude: [],
        archive: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, reason: 'Fast mode cannot authorize retirement' }] })))
      const page = await ctx.contextify.familyPage(agent)
      await expect(ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Revise the website draft', 'fast'))
        .resolves.toMatchObject({ archive: [] })
      expect(ctx.contextify.get(agent).plan.replacements).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects contradictory model actions even when both refer to a legal frozen source', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('conflicting-frozen-selection'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'The current launch constraint', 'A website draft')
      const id = `${session.id}:${String(turn.userSeq)}`
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({
        include: [{ nodeId: id, reason: 'Use the constraint' }], exclude: [{ nodeId: id, reason: 'Remove the same constraint' }], archive: [],
      })))
      const page = await ctx.contextify.familyPage(agent)
      const review = ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Write a launch draft', 'fast')
      await expect(review).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
      await expect(review).rejects.toThrow(/conflicting actions/)
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it.each([new Error('model directory unavailable'), 'model directory detached'])(
    'preserves a provider-directory failure without starting a model stream: %s', async (reason) => {
      const { ctx, start } = await harness()
      try {
        const session = ctx.sessions.create(SessionId('provider-directory-boundary'))
        const { agent } = start(session)
        appendClosedTurn(session, 1, 'A website planning task', 'A draft plan')
        const adapter = new MockAdapter([])
        // resolveModel is the public third-party provider boundary; rejection
        // values are not required to be Error instances by the Promise protocol.
        vi.spyOn(adapter, 'resolveModel').mockRejectedValue(reason)
        ctx.llm.registerAdapter(['mock'], adapter)
        const page = await ctx.contextify.familyPage(agent)
        const review = ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Write the website draft', 'fast')
        await expect(review).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' })
        await expect(review).rejects.toThrow(reason instanceof Error ? reason.message : reason)
        expect(adapter.requests).toEqual([])
        expect(ctx.contextify.get(agent).plan.revision).toBe(1)
      } finally { await ctx.fiber.dispose() }
    })

  it.each(['unmarked', 'foreign-target', 'altered-card', 'opposite-choice', 'plan-changed', 'restored-plan', 'graph-changed'] as const)(
    'requires the original pending task-state card: %s', async (condition) => {
      const { ctx, start } = await harness()
      try {
        const session = ctx.sessions.create(SessionId(`task-state-card-${condition}`))
        const { agent } = start(session)
        const turn = appendClosedTurn(session, 1, 'Draft the conference website', 'The initial website plan')
        ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({ exclude: [], include: [], archive: [],
          workStates: [{ sessionId: session.id, state: 'parked', reason: 'This work can wait for the next planning stage.' }] })))
        const page = await ctx.contextify.familyPage(agent)
        const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Prepare another website draft', 'fast')
        expect(proposal.workStates).toMatchObject([{ sessionId: session.id, state: 'parked' }])
        if (condition === 'plan-changed') await ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: session.id, seq: turn.userSeq }, 'exclude')
        // A native journal replay can restore a new Plan outside a pending UI review.
        if (condition === 'restored-plan') session.append('contextify/plan', { ...ctx.contextify.get(agent).plan, revision: 2, stateRevision: 2 })
        if (condition === 'graph-changed') appendClosedTurn(session, 2, 'Continue the project with a new constraint', 'A later answer')
        if (condition === 'opposite-choice') {
          await ctx.contextify.reviewWorkState(agent, proposal, session.id, 'reject', 'contextify-client')
          const before = session.snapshotEvents()
          await ctx.contextify.reviewWorkState(agent, proposal, session.id, 'reject', 'contextify-client')
          expect(session.snapshotEvents()).toEqual(before)
        }
        const before = session.snapshotEvents()
        await expect(ctx.contextify.reviewWorkState(agent,
          condition === 'altered-card' ? { ...proposal, mode: 'local' } : proposal,
          condition === 'foreign-target' ? SessionId('unrelated-task') : session.id,
          'accept', condition === 'unmarked' ? undefined : 'contextify-client')).rejects.toMatchObject({
          code: condition === 'opposite-choice' ? 'CONTEXTIFY_INVALID_TRANSITION'
            : condition === 'restored-plan' ? 'CONTEXTIFY_STALE_REVISION'
              : condition === 'graph-changed' ? 'CONTEXTIFY_STALE_GRAPH' : 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE',
        })
        expect(session.snapshotEvents()).toEqual(before)
        expect(session.snapshotEvents().some(event => event.type === 'contextify/work-state')).toBe(false)
      } finally { await ctx.fiber.dispose() }
    })

  it('refuses proposals which omit or replace the reviewed selection, and refuses foreign decline IDs', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('reviewed-selection-guards'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'An outdated launch date', 'An obsolete schedule')
      const id = `${session.id}:${String(turn.userSeq)}`
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({ exclude: [{ nodeId: id, reason: 'The date is no longer needed' }], include: [], archive: [] })))
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Prepare the updated schedule', 'fast')
      await expect(ctx.contextify.setNodeModes(agent, { revision: 1 }, [], undefined, 'contextify-client', [id]))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
      await expect(ctx.contextify.setNodeModes(agent, { revision: 1 }, [], page.revision, 'contextify-client'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
      await expect(ctx.contextify.dismissRecommendation(agent, proposal, 'contextify-client', ['foreign-id']))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
      await expect(ctx.contextify.dismissRecommendation(agent, proposal, 'contextify-client', [id, id]))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_RECOMMENDATION' })
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
      expect(session.snapshotEvents().some(event => event.type === 'contextify/recommendation-reviewed' || event.type === 'contextify/recommendation-dismissed')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects unavailable or busy Branch operations without recording a choice', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('unavailable-branch-operations'))
      const active = start(session)
      expect(() => ctx.contextify.prepareBranchSuggestion(active.agent, 'missing')).toThrow(/unavailable/)
      expect(() => { ctx.contextify.keepBranchSuggestion(active.agent, 'missing') }).toThrow(/unavailable/)
      await expect(ctx.contextify.acceptBranchSuggestion(active.agent, 'missing', SessionId('missing-child'))).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      active.setStatus('running')
      expect(() => ctx.contextify.prepareBranchSuggestion(active.agent, 'missing')).toThrow(/idle/)
      expect(() => { ctx.contextify.keepBranchSuggestion(active.agent, 'missing') }).toThrow(/idle/)
      await expect(ctx.contextify.acceptBranchSuggestion(active.agent, 'missing', SessionId('missing-child'))).rejects.toMatchObject({ code: 'CONTEXTIFY_AGENT_BUSY' })
      expect(session.snapshotEvents()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['altered-card', 'plan-changed', 'restored-plan', 'stale-reject', 'wrong-child', 'conflicting-choice'] as const)(
    'does not record an invalid draft route review: %s', async (condition) => {
      const { ctx, session, agent, prefix, route } = await pendingRoute(condition)
      try {
        if (condition === 'plan-changed') await ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: session.id, seq: prefix.userSeq }, 'exclude')
        if (condition === 'restored-plan') session.append('contextify/plan', { ...ctx.contextify.get(agent).plan, revision: 2, stateRevision: 2 })
        if (condition === 'stale-reject') appendClosedTurn(session, 2, 'Another task already started', 'A newer answer')
        if (condition === 'conflicting-choice') await ctx.contextify.reviewRoute(agent, route, 'reject', undefined, 'contextify-client')
        const before = session.snapshotEvents()
        await expect(ctx.contextify.reviewRoute(agent,
          condition === 'altered-card' ? { ...route, reason: 'Not the displayed recommendation' } : route,
          condition === 'stale-reject' ? 'reject' : 'accept',
          condition === 'stale-reject' ? undefined : SessionId('not-a-created-child'), 'contextify-client')).rejects.toMatchObject({
          code: condition === 'altered-card' || condition === 'plan-changed' ? 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE'
            : condition === 'restored-plan' ? 'CONTEXTIFY_STALE_REVISION'
              : condition === 'stale-reject' ? 'CONTEXTIFY_STALE_GRAPH' : 'CONTEXTIFY_INVALID_TRANSITION',
        })
        expect(session.snapshotEvents()).toEqual(before)
      } finally { await ctx.fiber.dispose() }
    })

  it('records an accepted native draft Branch once and refuses a conflicting later decision', async () => {
    const { ctx, start, session, agent, prefix, route } = await pendingRoute('accepted')
    try {
      const child = ctx.sessions.fork(session, SessionSeq(prefix.boundary), SessionId('accepted-route-child'))
      start(child)
      await ctx.contextify.reviewRoute(agent, route, 'accept', child.id, 'contextify-client')
      const before = session.snapshotEvents()
      await ctx.contextify.reviewRoute(agent, route, 'accept', child.id, 'contextify-client')
      expect(session.snapshotEvents()).toEqual(before)
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/route-choice')?.data)
        .toMatchObject({ action: 'branch', choice: 'accept', targetSessionId: child.id })
      await expect(ctx.contextify.reviewRoute(agent, route, 'reject', undefined, 'contextify-client'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses treating an unrelated native fork as a manual Branch choice in the current family', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('manual-branch-family-guard'))
      const { agent } = start(session)
      appendClosedTurn(session, 1, 'Current writing project')
      const unrelated = ctx.sessions.create(SessionId('unrelated-native-root'))
      const prefix = appendClosedTurn(unrelated, 1, 'A different planning project')
      const foreignChild = ctx.sessions.fork(unrelated, SessionSeq(prefix.boundary), SessionId('unrelated-native-fork'))
      start(foreignChild)
      const before = session.snapshotEvents()
      await expect(ctx.contextify.recordManualBranch(agent, foreignChild.id, 'contextify-client', 'The current draft'))
        .rejects.toMatchObject({ code: 'CONTEXTIFY_CROSS_FAMILY' })
      expect(session.snapshotEvents()).toEqual(before)
      expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['no-target', 'wrong-target', 'changed-destination'] as const)(
    'refuses a Return card after its native draft transfer no longer matches: %s', async (condition) => {
      const { ctx, start } = await harness()
      try {
        const parent = ctx.sessions.create(SessionId(`return-parent-${condition}`))
        const prefix = appendClosedTurn(parent, 1, 'The website mainline', 'The overall project plan')
        const child = ctx.sessions.fork(parent, SessionSeq(prefix.boundary), SessionId(`return-source-${condition}`))
        appendClosedTurn(child, 2, 'Work on a writing branch', 'The side-branch draft')
        const { agent } = start(child)
        ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({ include: [], exclude: [], archive: [], route: {
          intent: 'return', intentScore: 1, candidates: [{ sessionId: parent.id, destinationScore: 1, evidenceScore: 0, supersededScore: 0 }],
        } })))
        const graph = await ctx.contextify.familyPage(agent)
        const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: graph.revision, activeSessionId: child.id }, 'Return to the mainline with the draft', 'fast', true)
        const route = proposal.route
        if (route?.action !== 'return') throw new Error('expected the original parent Return card')
        if (condition === 'changed-destination') appendClosedTurn(parent, 2, 'The mainline has a new launch deadline', 'A newer overall plan')
        const before = child.snapshotEvents()
        await expect(ctx.contextify.reviewRoute(agent, route, 'accept', condition === 'no-target' ? undefined
          : condition === 'wrong-target' ? child.id : parent.id, 'contextify-client')).rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_GRAPH' })
        expect(child.snapshotEvents()).toEqual(before)
      } finally { await ctx.fiber.dispose() }
    })

  it.each(['route', 'dismissal', 'impression'] as const)(
    'does not publish a cleared %s after asynchronous catalog I/O returns', async (operation) => {
      const { ctx, session, agent, proposal, route } = await pendingRoute(`reset-during-${operation}`)
      const pause = pauseNextCatalogRead(ctx)
      try {
        const pending = operation === 'route' ? ctx.contextify.reviewRoute(agent, route, 'reject', undefined, 'contextify-client')
          : operation === 'dismissal' ? ctx.contextify.dismissRecommendation(agent, proposal, 'contextify-client')
            : ctx.contextify.presentRecommendation(agent, proposal, 'contextify-client')
        // Observe rejection immediately so a real dependency failure cannot leak an unhandled Promise.
        const completion = pending.then(() => ({ status: 'fulfilled' as const }), (error: unknown) => ({ status: 'rejected' as const, error }))
        await pause.entered
        await ctx.contextify.resetPolicy(agent, 'contextify-client')
        const afterReset = session.snapshotEvents()
        pause.release()
        const result = await completion
        if (operation === 'impression') expect(result).toEqual({ status: 'fulfilled' })
        else expect(result).toMatchObject({ status: 'rejected', error: { code: 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' } })
        expect(session.snapshotEvents()).toEqual(afterReset)
      } finally {
        pause.release()
        pause.restore()
        await ctx.fiber.dispose()
      }
    })

  it('drops deleted historical families from cached preferences and isolates an unreadable cold family', async () => {
    const { ctx, start, stored } = await harness()
    const history = new Context()
    try {
      await history.plugin(SessionStore)
      const archived = history.sessions.create(SessionId('cached-then-deleted-preference'))
      appendClosedTurn(archived, 1, 'Keep work topics separate', 'A previous planning choice')
      archived.append('contextify/route-choice', { routeKey: 'prior-reviewed-branch', action: 'branch', choice: 'accept',
        base: { activeSessionId: archived.id, graphRevision: 'old', planRevision: 1 }, objective: 'A separate task',
        targetSessionId: archived.id, uiOrigin: 'contextify-client' })
      stored.set(archived.id, { inspection: { meta: archived.header, inheritedEventCount: archived.inheritedEventCount, events: archived.snapshotEvents() }, revision: 'prior-v1' })
      const session = ctx.sessions.create(SessionId('profile-cache-eviction'))
      const { agent } = start(session)
      appendClosedTurn(session, 1, 'Plan a website')
      expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(1)
      stored.delete(archived.id)
      expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(0)
      // An unavailable historical storage object must not prevent current Chat
      // from inspecting its available Profile evidence.
      stored.set(archived.id, { inspection: { meta: archived.header, inheritedEventCount: archived.inheritedEventCount,
        events: archived.snapshotEvents() }, revision: 'unavailable-storage' })
      const originalOpen = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        if (args[0] === archived.id) throw new Error('Historical storage is unavailable')
        return await originalOpen(...args)
      })
      const warn = vi.spyOn(ctx.logger, 'warn')
      expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('policy projection skipped Session family'))
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
    } finally {
      await history.fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('records an Archive review from a real restricted Deep child without applying its retirement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contextify-native-deep-review-'))
    const ctx = new Context()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(ContextCompilerRegistry)
      await ctx.plugin(JsonlSessionPersistence, { root: directory })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(ContextifyService)
      for (const name of ['read', 'grep']) ctx.tools.register(defineContentToolFixture({
        name, description: 'A restricted snapshot inspection fixture.', parameters: {},
        async execute() { return [{ type: 'text', text: '' }] },
      }))
      const handle = await ctx.agents.create({ sessionId: SessionId('native-deep-review'), agentOptions: { provider: 'mock', model: 'mock' } })
      const { agent } = handle
      const turn = appendClosedTurn(agent.session, 1, 'The launch was originally Friday', 'The draft still says Friday')
      const id = `${agent.id}:${String(turn.userSeq)}`
      const adapter = new MockAdapter([toolCallResponse('review-archive-submit', 'submit_context_recommendation', {
        include: [], exclude: [], archive: [{ nodeId: id, reason: 'An obsolete date can be retired after the user checks the correction.' }],
      })])
      ctx.llm.registerAdapter(['mock'], adapter)
      let reviewerId: SessionId | undefined
      ctx.on('agent/created', ({ agent: reviewer }) => { if (reviewer !== agent) reviewerId = reviewer.id })
      const graph = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: graph.revision, activeSessionId: agent.id }, 'Review obsolete launch information', 'deep')
      expect(proposal.archive).toMatchObject([{ nodeId: id }])
      expect(adapter.requests).toHaveLength(1)
      expect(reviewerId).toBeDefined()
      expect(reviewerId === undefined ? undefined : ctx.agents.get(reviewerId)).toBeUndefined()
      expect(ctx.contextify.get(agent).plan.replacements).toEqual([])
      await ctx.contextify.presentRecommendation(agent, proposal, 'contextify-client')
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-presented')?.data)
        .toMatchObject({ archiveNodeIds: [id] })
      await ctx.contextify.dismissRecommendation(agent, proposal, 'contextify-client')
      expect(agent.session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-dismissed')?.data)
        .toMatchObject({ archiveNodeIds: [id] })
      expect(ctx.contextify.get(agent).plan.replacements).toEqual([])
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('abstains from pair relocation after a real human steer corrects the same native Turn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contextify-native-steer-'))
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(ContextCompilerRegistry)
      await ctx.plugin(JsonlSessionPersistence, { root: directory })
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(ContextifyService)
      ctx.tools.register(defineContentToolFixture({
        name: 'wait_for_test_input', description: 'Hold a native Tool step so a real human can steer it.', parameters: {},
        async execute() {
          entered.resolve(undefined)
          await release.promise
          return [{ type: 'text', text: 'The tool completed after the human correction arrived.' }]
        },
      }))
      const handle = await ctx.agents.create({ sessionId: SessionId('native-steer-branch-boundary'),
        agentOptions: { provider: 'mock', model: 'mock' } })
      const { agent } = handle
      const adapter = new MockAdapter([
        textResponse('The initial planning context'),
        toolCallResponse('steer-test-hold', 'wait_for_test_input', {}), textResponse('The corrected result uses B, as the user requested.'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'The original conversation' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Prepare result A in a separate branch.' }], source: { kind: 'user' } }))
      await entered.promise
      expect(adapter.requests).toHaveLength(2)
      agent.steer(createUserMessage({ content: [{ type: 'text', text: 'Correction: use B instead of A, including this new constraint.' }], source: { kind: 'user' } }))
      release.resolve(undefined)
      await agent.whenIdle()
      const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
      if (end?.type !== 'turn/end') throw new Error('native steered Turn did not complete')
      expect(end.data.turn).toBe(2)
      expect(end.data.reason.kind).toBe('completed')
      expect(adapter.requests).toHaveLength(3)
      expect(agent.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('Correction: use B')))).toBe(true)
      // Pair relocation copies only its single input and final answer. The
      // native Turn contains a second human input, so that pair is incomplete.
      expect(completedTurnCandidate(agent.session.snapshotEvents(), end.seq, agent.id)).toBeNull()
    } finally {
      release.resolve(undefined)
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses a persisted first-Turn Branch candidate without a valid preceding boundary', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('first-turn-branch-boundary'))
      const { agent } = start(session)
      const first = appendClosedTurn(session, 1, 'First user task', 'First result')
      const candidate = completedTurnCandidate(session.snapshotEvents(), first.boundary, session.id)
      if (candidate === null) throw new Error('first Turn candidate missing')
      session.append('contextify/branch-review', { turnEndSeq: first.boundary,
        suggestion: { ...candidate, id: 'persisted-first-turn-candidate', confidence: 1, reason: 'Historical candidate', planRevision: 1, graphRevision: 'historical' } })
      const before = session.snapshotEvents()
      expect(() => ctx.contextify.prepareBranchSuggestion(agent, 'persisted-first-turn-candidate')).toThrow(/preceding Branch boundary/)
      expect(session.snapshotEvents()).toEqual(before)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['source-advanced', 'plan-changed', 'already-kept', 'busy-child', 'wrong-boundary', 'advanced-child'] as const)(
    'rejects a %s Branch relocation and leaves both native histories intact', async (condition) => {
      const { ctx, start, session, active, suggestion } = await pendingBranch(condition)
      try {
        const forkAt = condition === 'wrong-boundary' ? suggestion.boundaryAfter : suggestion.boundaryBefore
        const child = ctx.sessions.fork(session, SessionSeq(forkAt), SessionId(`relocation-guard-child-${condition}`))
        const childAgent = start(child)
        if (condition === 'source-advanced') appendClosedTurn(session, 3, 'Continue in the original conversation', 'A later answer')
        if (condition === 'plan-changed') await ctx.contextify.setNodeMode(active.agent, { revision: 1 }, suggestion.input, 'exclude')
        if (condition === 'already-kept') ctx.contextify.keepBranchSuggestion(active.agent, suggestion.id)
        if (condition === 'busy-child') childAgent.setStatus('running')
        if (condition === 'advanced-child') appendClosedTurn(child, 3, 'A newer child task', 'A child answer')
        const beforeSource = session.snapshotEvents()
        const beforeChild = child.snapshotEvents()
        const code = condition === 'source-advanced' || condition === 'advanced-child' ? 'CONTEXTIFY_STALE_GRAPH'
          : condition === 'plan-changed' ? 'CONTEXTIFY_STALE_REVISION'
            : condition === 'busy-child' ? 'CONTEXTIFY_AGENT_BUSY' : 'CONTEXTIFY_INVALID_TRANSITION'
        await expect(ctx.contextify.acceptBranchSuggestion(active.agent, suggestion.id, child.id)).rejects.toMatchObject({ code })
        if (condition === 'source-advanced') {
          expect(() => ctx.contextify.prepareBranchSuggestion(active.agent, suggestion.id)).toThrow(/advanced/)
          expect(() => { ctx.contextify.keepBranchSuggestion(active.agent, suggestion.id) }).toThrow(/advanced/)
        }
        if (condition === 'plan-changed') expect(() => { ctx.contextify.keepBranchSuggestion(active.agent, suggestion.id) }).toThrow(/Plan changed/)
        expect(session.snapshotEvents()).toEqual(beforeSource)
        expect(child.snapshotEvents()).toEqual(beforeChild)
      } finally { await ctx.fiber.dispose() }
    })

  it('keeps automatic review events distinct from explicit Client preference evidence', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('unmarked-review-choice'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'The original event date is Friday', 'The draft uses Friday')
      const nodeId = `${session.id}:${String(turn.userSeq)}`
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({ include: [], exclude: [{ nodeId, reason: 'Defer the old date while reviewing the draft' }], archive: [] })))
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Review the launch draft', 'fast')
      expect(proposal.selection).toMatchObject([{ nodeId, action: 'exclude' }])
      await ctx.contextify.presentRecommendation(agent, proposal)
      await ctx.contextify.setNodeModes(agent, { revision: 1 }, [{ node: { sessionId: session.id, seq: turn.userSeq }, mode: 'exclude' }], page.revision)
      const presented = session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-presented')
      const reviewed = session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-reviewed')
      expect(presented?.data).not.toHaveProperty('uiOrigin')
      expect(reviewed?.data).not.toHaveProperty('uiOrigin')
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
      const current = ctx.contextify.get(agent).plan
      const focused = await ctx.contextify.focusNodeExcerpt(agent, { revision: current.revision }, { sessionId: session.id, seq: turn.userSeq }, 0, 12, 'Only inspect the opening')
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/excerpt-choice')?.data).not.toHaveProperty('uiOrigin')
      expect(focused.plan.replacements).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('allows unmarked review dismissal and all-declined acceptance without claiming user labels', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('unmarked-declined-review'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'Old event date is Friday', 'The date needs a review')
      const nodeId = `${session.id}:${String(turn.userSeq)}`
      ctx.llm.registerAdapter(['mock'], branchDecisionAdapter(JSON.stringify({ include: [], exclude: [{ nodeId, reason: 'An old planning constraint' }], archive: [] })))
      const page = await ctx.contextify.familyPage(agent)
      const base = { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }
      const first = await ctx.contextify.recommend(agent, base, 'Review the launch date', 'fast')
      await ctx.contextify.dismissRecommendation(agent, first, undefined, [nodeId])
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-dismissed')?.data).not.toHaveProperty('uiOrigin')
      await ctx.contextify.recommend(agent, base, 'Inspect the launch draft differently', 'fast')
      await ctx.contextify.setNodeModes(agent, { revision: 1 }, [], page.revision, undefined, [nodeId])
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-reviewed')?.data).toMatchObject({ acceptedNodeIds: [], declinedNodeIds: [nodeId] })
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-reviewed')?.data).not.toHaveProperty('uiOrigin')
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('records a native unmarked branch move without confusing it with a Client preference', async () => {
    const { ctx, start, session, active, suggestion } = await pendingBranch('unmarked-native-move')
    try {
      const child = ctx.sessions.fork(session, SessionSeq(suggestion.boundaryBefore), SessionId('unmarked-native-move-child'))
      start(child)
      await ctx.contextify.acceptBranchSuggestion(active.agent, suggestion.id, child.id)
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-choice')?.data).toMatchObject({ choice: 'move' })
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-choice')?.data).not.toHaveProperty('uiOrigin')
      expect((await ctx.contextify.stewardProfile(active.agent)).branch.support).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('keeps unmarked Branch and route journal actions out of personalized evidence', async () => {
    const { ctx, start, session, agent, prefix, proposal, route } = await pendingRoute('unmarked-native-routing')
    try {
      await ctx.contextify.presentRecommendation(agent, proposal)
      await ctx.contextify.reviewRoute(agent, route, 'reject')
      const child = ctx.sessions.fork(session, SessionSeq(prefix.boundary), SessionId('unmarked-manual-child'))
      start(child)
      await ctx.contextify.recordManualBranch(agent, child.id)
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/route-choice')?.data).not.toHaveProperty('uiOrigin')
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/manual-branch')?.data).not.toHaveProperty('objective')
      expect(session.snapshotEvents().findLast(event => event.type === 'contextify/manual-branch')?.data).not.toHaveProperty('uiOrigin')
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })


  it.each(['missing-node', 'wrong-input-role'] as const)('rejects a persisted Branch card with %s without copying an invalid Q&A', async (condition) => {
    const { ctx, start, session, active, suggestion } = await pendingBranch(`forged-${condition}`)
    try {
      const forged = { ...suggestion, id: `forged-${condition}`, input: condition === 'missing-node'
        ? { sessionId: session.id, seq: suggestion.boundaryBefore }
        : suggestion.output }
      session.append('contextify/branch-review', { suggestion: forged, turnEndSeq: suggestion.boundaryAfter })
      const child = ctx.sessions.fork(session, SessionSeq(suggestion.boundaryBefore), SessionId(`forged-${condition}-child`))
      start(child)
      const beforeSource = session.snapshotEvents()
      const beforeChild = child.snapshotEvents()
      await expect(ctx.contextify.acceptBranchSuggestion(active.agent, forged.id, child.id)).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_NODE' })
      expect(session.snapshotEvents()).toEqual(beforeSource)
      expect(child.snapshotEvents()).toEqual(beforeChild)
    } finally { await ctx.fiber.dispose() }
  })

  it.each(['unexpected-tool', 'reasoning-only', 'provider-error'] as const)('keeps the conversation on a %s automatic Branch classifier result', async (condition) => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId(`branch-classifier-${condition}`))
      appendClosedTurn(session, 1, 'The initial website plan', 'The shared task constraints')
      const { agent } = start(session, { provider: 'mock', model: 'mock' })
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const warn = vi.spyOn(ctx.logger, 'warn')
      if (condition === 'unexpected-tool') ctx.llm.registerAdapter(['mock'], new MockAdapter([toolCallResponse('untrusted-branch-tool', 'invent_branch', {})]))
      else if (condition === 'reasoning-only') ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          yield { type: 'block-start', index: 0, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index: 0, text: '{"action":"keep","confidence":0.9,"reason":"Same task"}' }
          yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '{"action":"keep","confidence":0.9,"reason":"Same task"}' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }())
      else ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          yield { type: 'finish', reason: { kind: 'stop' } }
          throw new Error('Classifier unavailable')
        }
      }())
      const turn = appendClosedTurn(session, 2, 'Continue the current website plan', 'The revised plan')
      await vi.waitFor(() => { expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')?.data).toMatchObject({ suggestion: null, turnEndSeq: turn.boundary }) })
      expect(ctx.contextify.get(agent).branchSuggestion).toBeUndefined()
      expect(ctx.contextify.get(agent).plan.replacements).toEqual([])
      if (condition === 'provider-error') expect(warn).toHaveBeenCalledWith(expect.stringContaining('Branch classifier failed'))
      else expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Branch classifier failed'))
    } finally { await ctx.fiber.dispose() }
  })

  it('uses an inspectable default objective for an empty conversation rather than inventing a user preference', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('empty-default-objective'))
      const { agent } = start(session)
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id })
      expect(proposal).toMatchObject({ mode: 'local', selection: [], archive: [], currentNodeIds: [], proposedNodeIds: [] })
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
      expect(session.snapshotEvents().some(event => event.type === 'contextify/recommendation-request')).toBe(false)
    } finally { await ctx.fiber.dispose() }
  })


  it('preserves a model route with normal reasoning rather than forcing an unsupported off mode', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('reasoning-route-fallback'))
      appendClosedTurn(session, 1, 'Plan the website', 'The shared plan')
      const { agent } = start(session)
      session.append('request/header', { header: { config: { provider: 'mock', model: 'mock', reasoningEffort: ReasoningEffortId('normal') } }, reason: 'initial' })
      const adapter = new MockAdapter([textResponse('{"include":[],"exclude":[],"archive":[]}')], { efforts: [{ id: ReasoningEffortId('normal'), name: 'Normal' }] })
      ctx.llm.registerAdapter(['mock'], adapter)
      const page = await ctx.contextify.familyPage(agent)
      await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Review the website plan', 'fast')
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.reasoningEffort).toBe(ReasoningEffortId('normal'))
      expect(adapter.requests[0]?.tools).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('recommends from original inspected text when a persisted replacement points at a non-snapshot event', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('invalid-replacement-recommendation'))
      const turn = appendClosedTurn(session, 1, 'Original source material for the website', 'A source-grounded draft')
      const { agent } = start(session)
      const plan = ctx.contextify.get(agent).plan
      session.append('contextify/plan', { ...plan, replacements: [{ nodeId: `${session.id}:${String(turn.userSeq)}`, snapshotSeq: turn.userSeq, originalEventSeq: turn.userSeq, role: 'user', kind: 'placeholder', reason: 'A corrupt persisted snapshot pointer' }] })
      const adapter = new MockAdapter([textResponse('{"include":[],"exclude":[],"archive":[]}')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const page = await ctx.contextify.familyPage(agent)
      await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Review sources', 'fast')
      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('Original source material for the website')
      expect(page.records.find(node => node.owner.seq === turn.userSeq)?.replacement).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects a nonexistent public node without misclassifying its unregistered Session as another known family', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('unknown-public-node'))
      const { agent } = start(session)
      await expect(ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: SessionId('not-registered'), seq: 2 }, 'include')).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_NODE' })
    } finally { await ctx.fiber.dispose() }
  })


  it('does not append a duplicate Branch review after a matching journal result arrives during classification', async () => {
    const { ctx, start } = await harness()
    const release = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    try {
      const session = ctx.sessions.create(SessionId('branch-duplicate-journal'))
      appendClosedTurn(session, 1, 'The main planning task', 'The shared plan')
      start(session, { provider: 'mock', model: 'mock' })
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(): AsyncIterable<StreamChunk> {
          entered.resolve(undefined)
          await release.promise
          yield* textResponse('{"action":"suggest_branch","confidence":0.97,"reason":"Another independent task"}')
        }
      }())
      const turn = appendClosedTurn(session, 2, 'Write a separate event announcement', 'The announcement')
      await entered.promise
      session.append('contextify/branch-review', { turnEndSeq: turn.boundary, suggestion: null })
      release.resolve(undefined)
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/branch-review' && event.data.turnEndSeq === turn.boundary)).toHaveLength(1)
    } finally { release.resolve(undefined); await ctx.fiber.dispose() }
  })

  it('suppresses a confident generic Move after repeated reviewed Keep choices at the same branch depth', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('strong-keep-style'))
      const { agent } = start(session, { provider: 'mock', model: 'mock' })
      for (let turn = 1; turn <= 6; turn++) {
        const prior = appendClosedTurn(session, turn, `Plan website stage ${String(turn)}`, 'The planning result')
        const suggestion = { id: `keep-style-${String(turn)}`, sourceSessionId: session.id, turn,
          boundaryBefore: prior.userSeq - 2, boundaryAfter: prior.boundary, input: { sessionId: session.id, seq: prior.userSeq },
          output: { sessionId: session.id, seq: prior.boundary - 1 }, inputPreview: `Plan website stage ${String(turn)}`, outputPreview: 'The planning result',
          confidence: 0.9, reason: 'A potential stage branch', planRevision: 1, graphRevision: 'prior' }
        session.append('contextify/branch-review', { suggestion, turnEndSeq: prior.boundary })
        session.append('contextify/branch-choice', { suggestionId: suggestion.id, choice: 'keep', turnEndSeq: prior.boundary, uiOrigin: 'contextify-client' })
      }
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const adapter = new MockAdapter([textResponse('{"action":"suggest_branch","confidence":0.91,"reason":"Independent stage"}')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const last = appendClosedTurn(session, 7, 'Plan the new website stage', 'The next planning result')
      await vi.waitFor(() => { expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')?.data).toEqual({ suggestion: null, turnEndSeq: last.boundary }) })
      expect(adapter.requests).toHaveLength(1)
      expect(ctx.contextify.get(agent).plan.replacements).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })


  it('records reviewed lifecycle cursors for a real empty native Session without fabricating an event', async () => {
    for (const reviewed of [false, true]) {
      const { ctx, start } = await harness()
      try {
        const session = ctx.sessions.create(SessionId(`empty-lifecycle-${String(reviewed)}`))
        const { agent } = start(session)
        expect(session.snapshotEvents()).toEqual([])
        const page = await ctx.contextify.familyPage(agent)
        if (reviewed) {
          const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Park this task until tomorrow', 'local', true)
          expect(proposal.workStates).toMatchObject([{ sessionId: session.id, state: 'parked' }])
          await ctx.contextify.reviewWorkState(agent, proposal, session.id, 'accept', 'contextify-client')
        } else await ctx.contextify.setWorkState(agent, session.id, 'parked', page.revision, 'contextify-client')
        expect(session.snapshotEvents().find(event => event.type === 'contextify/work-state')?.data).toMatchObject({ targetEventSeq: -1, state: 'parked' })
        expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(0)
      } finally { await ctx.fiber.dispose() }
    }
  })

  it('excludes native worker Sessions from Context Maps and user preference catalogs', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('worker-exclusion-profile'))
      const { agent } = start(session)
      const worker = ctx.sessions.create(SessionId('profile-native-worker'), { meta: { origin: 'subagent' } })
      expect(worker.header.origin).toBe('subagent')
      appendClosedTurn(worker, 1, 'An internal worker task', 'A worker answer')
      const page = await ctx.contextify.familyPage(agent)
      expect(page.sessions.map(item => item.id)).toEqual([session.id])
      expect(await ctx.contextify.policyEvidence(agent)).toEqual([])
      expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not label missing draft transfers or reuse an action ID with an absent objective', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('manual-route-absent-objective'))
      const { agent } = start(session)
      const turn = appendClosedTurn(session, 1, 'Plan a website', 'The plan')
      const child = ctx.sessions.fork(session, SessionSeq(turn.boundary), SessionId('manual-route-absent-child'))
      start(child)
      const page = await ctx.contextify.familyPage(agent)
      await expect(ctx.contextify.recordManualRoute(agent, child.id, 'transfer-a', page.revision, 'contextify-client')).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      await ctx.contextify.recordManualRoute(agent, child.id, 'transfer-a', page.revision, 'contextify-client', 'Write the announcement')
      await expect(ctx.contextify.recordManualRoute(agent, child.id, 'transfer-a', page.revision, 'contextify-client')).rejects.toMatchObject({ code: 'CONTEXTIFY_INVALID_TRANSITION' })
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/manual-route')).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })


  it('drops a classifier whose native request header loses its model route during catalog I/O', async () => {
    const { ctx, start } = await harness()
    const pause = pauseNextCatalogRead(ctx)
    try {
      const session = ctx.sessions.create(SessionId('branch-route-drift'))
      appendClosedTurn(session, 1, 'The existing website task', 'The shared constraints')
      const { agent } = start(session)
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const adapter = new MockAdapter([])
      ctx.llm.registerAdapter(['mock'], adapter)
      const turn = appendClosedTurn(session, 2, 'A separate announcement', 'The written announcement')
      await pause.entered
      // The public native header journal may restore a temporarily incomplete
      // route. It must not authorize the isolated classifier to call a provider.
      session.append('request/header', { header: { config: { provider: '', model: '' } }, reason: 'change' })
      pause.release()
      await vi.waitFor(() => { expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')?.data).toMatchObject({ suggestion: null, turnEndSeq: turn.boundary }) })
      expect(adapter.requests).toEqual([])
      expect(ctx.contextify.get(agent).branchSuggestion).toBeUndefined()
    } finally { pause.release(); pause.restore(); await ctx.fiber.dispose() }
  })

  it('deduplicates simultaneous visible impressions while preserving one recommendation', async () => {
    const { ctx, session, agent, proposal } = await pendingRoute('simultaneous-impressions')
    try {
      await Promise.all([ctx.contextify.presentRecommendation(agent, proposal), ctx.contextify.presentRecommendation(agent, proposal)])
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-presented')).toHaveLength(1)
      await ctx.contextify.dismissRecommendation(agent, proposal)
      expect(session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-dismissed')).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('records a visible Return card with its native target and no claim of an authenticated preference', async () => {
    const { ctx, start } = await harness()
    try {
      const parent = ctx.sessions.create(SessionId('visible-return-root'))
      const prefix = appendClosedTurn(parent, 1, 'Plan the website', 'The shared launch plan')
      const child = ctx.sessions.fork(parent, SessionSeq(prefix.boundary), SessionId('visible-return-child'))
      appendClosedTurn(child, 2, 'Write the event announcement', 'The announcement draft')
      const { agent } = start(child)
      const adapter = new MockAdapter([textResponse(JSON.stringify({ include: [], exclude: [], archive: [], route: { intent: 'return', intentScore: 1, candidates: [{ sessionId: parent.id, destinationScore: 1, evidenceScore: 0, supersededScore: 0 }] } }))])
      ctx.llm.registerAdapter(['mock'], adapter)
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: child.id }, 'Return to the mainline and continue the launch plan', 'fast', true)
      expect(proposal.route).toMatchObject({ action: 'return', targetSessionId: parent.id })
      await ctx.contextify.presentRecommendation(agent, proposal)
      expect(child.snapshotEvents().findLast(event => event.type === 'contextify/recommendation-presented')?.data).toMatchObject({ routeAction: 'return', routeTargetSessionId: parent.id })
    } finally { await ctx.fiber.dispose() }
  })


  it('ignores non-text model output blocks while validating the Fast selection JSON', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('fast-image-output'))
      appendClosedTurn(session, 1, 'Plan the website', 'The shared plan')
      const { agent } = start(session)
      const adapter = new MockAdapter([[{ type: 'block-end', index: 1, block: { type: 'image', attachment: { attachmentId: AttachmentId('classifier-fixture-image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } }, ...textResponse('{"include":[],"exclude":[],"archive":[]}')]], { efforts: [{ id: ReasoningEffortId('normal'), name: 'Normal' }] })
      ctx.llm.registerAdapter(['mock'], adapter)
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: page.revision, activeSessionId: session.id }, 'Inspect the current plan', 'fast')
      expect(proposal.selection).toEqual([])
      expect(adapter.requests[0]?.reasoningEffort).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })

  it('ignores a classifier image while retaining its tool-free Branch JSON', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('branch-image-output'))
      appendClosedTurn(session, 1, 'The existing website task', 'The shared plan')
      start(session, { provider: 'mock', model: 'mock' })
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const adapter = new MockAdapter([[{ type: 'block-end', index: 1, block: { type: 'image', attachment: { attachmentId: AttachmentId('classifier-fixture-image'), mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } }, ...textResponse('{"action":"keep","confidence":0.95,"reason":"The same ongoing task"}')]], { efforts: [{ id: ReasoningEffortId('normal'), name: 'Normal' }] })
      ctx.llm.registerAdapter(['mock'], adapter)
      const turn = appendClosedTurn(session, 2, 'Continue the website plan', 'The revised plan')
      await vi.waitFor(() => { expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')?.data).toMatchObject({ suggestion: null, turnEndSeq: turn.boundary }) })
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.reasoningEffort).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })


  it('labels a manual draft transfer back to the native parent as Return and permits idle cancellation', async () => {
    const { ctx, start } = await harness()
    try {
      const parent = ctx.sessions.create(SessionId('manual-return-root'))
      const prefix = appendClosedTurn(parent, 1, 'Plan the website', 'The main plan')
      const child = ctx.sessions.fork(parent, SessionSeq(prefix.boundary), SessionId('manual-return-child'))
      const { agent } = start(child)
      const page = await ctx.contextify.familyPage(agent)
      ctx.contextify.cancelRecommendation(agent)
      await ctx.contextify.recordManualRoute(agent, parent.id, 'manual-return-transfer', page.revision, 'contextify-client', 'Bring the draft back to the launch plan')
      expect(child.snapshotEvents().findLast(event => event.type === 'contextify/manual-route')?.data).toMatchObject({ action: 'return', targetSessionId: parent.id })
    } finally { await ctx.fiber.dispose() }
  })

  it('starts a routed first-Turn classifier before any assistant answer exists', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('first-turn-classifier-route'))
      const { agent } = start(session, { provider: 'mock', model: 'mock' })
      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const adapter = new MockAdapter([textResponse('{"action":"keep","confidence":0.9,"reason":"Initial shared task"}')])
      ctx.llm.registerAdapter(['mock'], adapter)
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Plan a community website' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
      expect(session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: 'The initial plan' }], source: { provider: 'mock', model: 'mock' } }) }, { surfaceOp: 'append' })
      const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(session.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')?.data).toMatchObject({ suggestion: null, turnEndSeq: end.seq }) })
      expect(ctx.contextify.get(agent).plan.replacements).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })


  it('preserves validated lifecycle advice while calibrating a learned Context choice', async () => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId('calibrated-lifecycle-advice'))
      const { agent } = start(session)
      const first = appendClosedTurn(session, 1, 'The old Friday date', 'The original schedule')
      const plan = await ctx.contextify.setNodeMode(agent, { revision: 1 }, { sessionId: session.id, seq: first.userSeq }, 'exclude', 'contextify-client')
      const adapter = new MockAdapter([textResponse(JSON.stringify({ include: [], exclude: [], archive: [], workStates: [{ sessionId: session.id, state: 'parked', reason: 'The user is postponing this planning stage' }] }))])
      ctx.llm.registerAdapter(['mock'], adapter)
      const page = await ctx.contextify.familyPage(agent)
      const proposal = await ctx.contextify.recommend(agent, { planRevision: plan.plan.revision, graphRevision: page.revision, activeSessionId: session.id }, 'Review the next website stage', 'fast')
      expect(proposal.workStates).toMatchObject([{ sessionId: session.id, state: 'parked' }])
      expect(ctx.contextify.get(agent).plan).toEqual(plan.plan)
      expect(adapter.requests).toHaveLength(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('does not cache stale Profile inspections when a live conversation advances during a cold sibling read', async () => {
    const { ctx, start, stored } = await harness()
    const history = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    try {
      await history.plugin(SessionStore)
      const session = ctx.sessions.create(SessionId('aa-profile-cache-race-root'))
      const prefix = appendClosedTurn(session, 1, 'The main website plan', 'The shared constraints')
      const { agent } = start(session)
      const restoredRoot = history.sessions.create(session.id, { seed: session.snapshotEvents(), meta: session.header })
      const cold = history.sessions.fork(restoredRoot, SessionSeq(prefix.boundary), SessionId('zz-profile-cache-race-child'))
      stored.set(cold.id, { inspection: { meta: cold.header, inheritedEventCount: cold.inheritedEventCount, events: cold.snapshotEvents() }, revision: 'cold-sibling-v1' })
      const list = ctx.sessionPersistence.list.bind(ctx.sessionPersistence)
      let catalogs = 0
      vi.spyOn(ctx.sessionPersistence, 'list').mockImplementation(async () => {
        catalogs += 1
        if (catalogs === 2) appendClosedTurn(session, 2, 'A newly supplied deadline', 'The updated plan')
        return await list()
      })
      const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
      let coldReads = 0
      vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        return { ...handle, read: async (...readArgs) => {
          coldReads += 1
          if (coldReads === 2) { entered.resolve(undefined); await release.promise }
          return await handle.read(...readArgs)
        } }
      })
      const projecting = ctx.contextify.stewardProfile(agent)
      await entered.promise
      appendClosedTurn(session, 3, 'Another corrected launch constraint', 'The latest plan')
      release.resolve(undefined)
      expect((await projecting).branch.support).toBe(0)
      expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(0)
      expect(coldReads).toBeGreaterThanOrEqual(3)
      expect((await ctx.contextify.familyPage(agent)).records.some(node => node.preview === 'Another corrected launch constraint')).toBe(true)
    } finally { release.resolve(undefined); await history.fiber.dispose(); await ctx.fiber.dispose() }
  })


  it.each(['complete-new', 'cancel-new'] as const)('preserves newer family-root review ownership when a missing native parent is restored: %s', async (outcome) => {
    const { ctx, start } = await harness()
    const history = new Context()
    const firstEntered = Promise.withResolvers<undefined>()
    const secondEntered = Promise.withResolvers<undefined>()
    const firstRelease = Promise.withResolvers<undefined>()
    const secondRelease = Promise.withResolvers<undefined>()
    try {
      await history.plugin(SessionStore)
      const parent = history.sessions.create(SessionId(`recover-parent-${outcome}`))
      const prefix = appendClosedTurn(parent, 1, 'Plan the community website', 'The launch constraints')
      const originalChild = history.sessions.fork(parent, SessionSeq(prefix.boundary), SessionId(`recover-child-${outcome}`))
      // Native fork metadata and its exact inherited prefix remain usable while
      // the parent's persistence object has not yet been restored into the catalog.
      const child = ctx.sessions.create(originalChild.id, { seed: parent.snapshotEvents(),
        meta: originalChild.header, inheritedEventCount: originalChild.inheritedEventCount })
      const { agent } = start(child)
      appendClosedTurn(child, 2, 'Write the event announcement', 'The announcement draft')
      let requests = 0
      ctx.llm.registerAdapter(['mock'], new class extends OffReasoningAdapter {
        override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          requests += 1
          const first = requests === 1
          const entered = first ? firstEntered : secondEntered
          entered.resolve(undefined)
          await (first ? firstRelease : secondRelease).promise
          options.signal?.throwIfAborted()
          yield* textResponse('{"include":[],"exclude":[],"archive":[]}')
        }
      }())
      const oldPage = await ctx.contextify.familyPage(agent)
      expect(oldPage.rootSessionId).toBe(child.id)
      const oldReview = ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: oldPage.revision, activeSessionId: child.id }, 'Inspect the announcement draft', 'fast')
      const stale = expect(oldReview).rejects.toMatchObject({ code: 'CONTEXTIFY_STALE_GRAPH' })
      await firstEntered.promise
      ctx.sessions.create(parent.id, { seed: parent.snapshotEvents(), meta: parent.header })
      const newPage = await ctx.contextify.familyPage(agent)
      expect(newPage.rootSessionId).toBe(parent.id)
      const newReview = ctx.contextify.recommend(agent, { planRevision: 1, graphRevision: newPage.revision, activeSessionId: child.id }, 'Inspect the restored launch plan', 'fast')
      const completion = newReview.then(proposal => ({ kind: 'completed' as const, proposal }), (error: unknown) => ({ kind: 'failed' as const, error }))
      await secondEntered.promise
      firstRelease.resolve(undefined)
      await stale
      if (outcome === 'cancel-new') ctx.contextify.cancelRecommendation(agent)
      secondRelease.resolve(undefined)
      const result = await completion
      if (outcome === 'cancel-new') expect(result).toMatchObject({ kind: 'failed', error: { code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' } })
      else expect(result).toMatchObject({ kind: 'completed', proposal: { base: { graphRevision: newPage.revision }, selection: [] } })
      expect(requests).toBe(2)
      expect(ctx.contextify.get(agent).plan.revision).toBe(1)
    } finally {
      firstRelease.resolve(undefined); secondRelease.resolve(undefined)
      await history.fiber.dispose(); await ctx.fiber.dispose()
    }
  })


  it.each(['active', 'off-path'] as const)('learns the actual Context effect of a Client-confirmed Natural restoration on %s material', async (location) => {
    const { ctx, start } = await harness()
    try {
      const session = ctx.sessions.create(SessionId(`natural-policy-${location}`))
      const prefix = appendClosedTurn(session, 1, 'Plan the community website', 'The launch constraints')
      const { agent } = start(session)
      const sibling = ctx.sessions.fork(session, SessionSeq(prefix.boundary), SessionId(`natural-policy-sibling-${location}`))
      const borrowed = appendClosedTurn(sibling, 2, 'Research attendee onboarding', 'The onboarding findings')
      const ref = location === 'active' ? { sessionId: session.id, seq: prefix.userSeq } : { sessionId: sibling.id, seq: borrowed.userSeq }
      const nodeId = `${ref.sessionId}:${String(ref.seq)}`
      const changed = await ctx.contextify.setNodeMode(agent, { revision: 1 }, ref, location === 'active' ? 'exclude' : 'include', 'contextify-client')
      const restored = await ctx.contextify.setNodeMode(agent, { revision: changed.plan.revision }, ref, 'natural', 'contextify-client')
      const natural = session.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')
      if (natural?.type !== 'contextify/node-choice') throw new Error('expected the confirmed Natural event')
      expect(natural.data).toMatchObject({ changed: true, mutations: [{ nodeId, mode: 'natural' }] })
      const evidence = await ctx.contextify.policyEvidence(agent)
      const expectedAction = location === 'active' ? 'include' : 'release'
      expect(evidence.find(item => item.sourceEventSeq === natural.seq)).toMatchObject({ action: expectedAction, origin: 'manual-action', choice: 'accept', sourceSessionId: session.id, targetNodeId: nodeId, onActiveBranch: location === 'active' })
      const graph = await ctx.contextify.familyPage(agent)
      const family = { rootSessionId: graph.rootSessionId, activeSessionId: graph.activeSessionId,
        sessions: graph.sessions, edges: graph.edges, nodes: graph.records }
      const inspections = new Map(ctx.sessions.list().map(item => [item.id, { meta: item.header,
        events: item.snapshotEvents(), inheritedEventCount: item.inheritedEventCount }]))
      const edits = contextEditsFromFamily(family, inspections)
      const expectedMode = location === 'active' ? 'include' : 'exclude'
      expect(edits.find(item => item.episodeId === `${session.id}:${String(natural.seq)}`)).toMatchObject({ mode: expectedMode, onActiveBranch: location === 'active' })
      const packet = buildFastRecommendationInput({ graph: family,
        contents: Object.fromEntries(graph.records.map(node => [node.id, node.preview])), objective: 'Continue planning the website',
        effectiveIncludedNodeIds: graph.records.filter(node => node.sessionIds.includes(session.id)).map(node => node.id),
        explicitIncludedNodeIds: restored.plan.included.map(item => item.nodeId),
        explicitExcludedNodeIds: restored.plan.excluded.map(item => item.nodeId), preferenceEdits: edits })
      expect(packet.preferenceExamples).toContainEqual(expect.objectContaining({ mode: expectedMode, onActiveBranch: location === 'active' }))
      expect(packet.preferenceExamples.length).toBeLessThanOrEqual(4)
      const profile = await ctx.contextify.stewardProfile(agent)
      expect(profile.evidence.support).toBe(1)
      expect(profile.release.support).toBe(1)
      const undone = ctx.contextify.undo(agent, { revision: restored.plan.revision })
      expect((await ctx.contextify.policyEvidence(agent)).find(item => item.sourceEventSeq === natural.seq)?.undone).toBe(true)
      const afterUndo = await ctx.contextify.stewardProfile(agent)
      expect(location === 'active' ? afterUndo.evidence.support : afterUndo.release.support).toBe(0)
      const redone = ctx.contextify.redo(agent, { revision: undone.plan.revision })
      expect((await ctx.contextify.policyEvidence(agent)).find(item => item.sourceEventSeq === natural.seq)?.undone).not.toBe(true)
      await ctx.contextify.setNodeMode(agent, { revision: redone.plan.revision }, ref, 'natural', 'contextify-client')
      expect(await ctx.contextify.policyEvidence(agent)).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('abstains from labeling a historical Natural whose canonical target changed after native parent recovery', async () => {
    const { ctx, start } = await harness()
    const history = new Context()
    try {
      await history.plugin(SessionStore)
      const parent = history.sessions.create(SessionId('natural-recovered-parent'))
      const prefix = appendClosedTurn(parent, 1, 'Plan the website', 'The original constraints')
      const fork = history.sessions.fork(parent, SessionSeq(prefix.boundary), SessionId('natural-recovered-child'))
      const child = ctx.sessions.create(fork.id, { seed: parent.snapshotEvents(),
        meta: fork.header, inheritedEventCount: fork.inheritedEventCount })
      const { agent } = start(child)
      const ref = { sessionId: child.id, seq: prefix.userSeq }
      const excluded = await ctx.contextify.setNodeMode(agent, { revision: 1 }, ref, 'exclude', 'contextify-client')
      await ctx.contextify.setNodeMode(agent, { revision: excluded.plan.revision }, ref, 'natural', 'contextify-client')
      const natural = child.snapshotEvents().findLast(event => event.type === 'contextify/node-choice')
      if (natural?.type !== 'contextify/node-choice') throw new Error('expected a native Natural restoration')
      ctx.sessions.create(parent.id, { seed: parent.snapshotEvents(), meta: parent.header })
      expect((await ctx.contextify.familyPage(agent)).records.find(node => node.owner.seq === prefix.userSeq)?.id).toBe(`${parent.id}:${String(prefix.userSeq)}`)
      expect((await ctx.contextify.policyEvidence(agent)).some(item => item.sourceEventSeq === natural.seq)).toBe(false)
    } finally { await history.fiber.dispose(); await ctx.fiber.dispose() }
  })

  it.each([0, 1])('orders equal-time native Branch feedback by Session and event cursor before the real 32-choice window (offset %s)', async (offset) => {
    const { ctx, start } = await harness()
    try {
      // Create the lexically later family first so catalog insertion order cannot
      // accidentally substitute for the cross-family timestamp tie-break.
      const later = ctx.sessions.create(SessionId(`zz-window-history-${String(offset)}`))
      const earlier = ctx.sessions.create(SessionId(`aa-window-history-${String(offset)}`))
      const at = Date.now()
      const laterChoiceSeqs: number[] = []
      let earlierChoiceSeq = -1
      const clock = vi.spyOn(Date, 'now').mockReturnValue(at)
      try {
        for (const [session, count] of [[later, 32], [earlier, 1]] as const) {
          clock.mockReturnValue(session === earlier ? at + offset : at)
          appendClosedTurn(session, 0, 'The existing website plan', 'Shared constraints')
          for (let turn = 1; turn <= count; turn++) {
            const prior = appendClosedTurn(session, turn, `Compare website stage ${String(turn)}`, 'The stage comparison')
            const suggestion = { id: `${session.id}-review-${String(turn)}`, sourceSessionId: session.id, turn,
              boundaryBefore: prior.userSeq - 2, boundaryAfter: prior.boundary,
              input: { sessionId: session.id, seq: prior.userSeq },
              output: { sessionId: session.id, seq: prior.boundary - 1 },
              inputPreview: `Compare website stage ${String(turn)}`, outputPreview: 'The stage comparison',
              confidence: 0.9, reason: 'A separate completed stage', planRevision: 1, graphRevision: 'native-history' }
            session.append('contextify/branch-review', { suggestion, turnEndSeq: prior.boundary })
            // 24 Moves plus 8 Keeps in the 32-choice family. The first Keep is
            // displaced only when the other family's Move is genuinely newer.
            const choice = session === earlier || (turn >= 2 && turn <= 25) ? 'move' : 'keep'
            const event = session.append('contextify/branch-choice', {
              suggestionId: suggestion.id, choice, turnEndSeq: prior.boundary, uiOrigin: 'contextify-client',
            })
            if (session === later) laterChoiceSeqs.push(event.seq)
            else earlierChoiceSeq = event.seq
          }
        }
      } finally { clock.mockRestore() }

      const current = ctx.sessions.create(SessionId(`mm-window-current-${String(offset)}`))
      const { agent } = start(current, { provider: 'mock', model: 'mock' })
      appendClosedTurn(current, 1, 'The current website brief', 'Brief acknowledged')
      const evidence = await ctx.contextify.policyEvidence(agent)
      expect(evidence).toHaveLength(33)
      const laterCursors = laterChoiceSeqs.map(seq => [later.id, seq])
      const earlierCursor = [earlier.id, earlierChoiceSeq]
      expect(evidence.map(item => [item.sourceSessionId, item.sourceEventSeq]))
        .toEqual(expect.arrayContaining([earlierCursor, ...laterCursors]))
      expect(evidence.filter(item => item.sourceSessionId === later.id).map(item => item.sourceEventSeq))
        .toEqual(laterChoiceSeqs)
      expect(evidence.find(item => item.sourceSessionId === earlier.id))
        .toMatchObject({ sourceSessionId: earlier.id, sourceEventSeq: earlierChoiceSeq, at: at + offset })
      expect(evidence.map(item => item.at)).toEqual(offset === 0
        ? Array.from({ length: 33 }, () => at)
        : [...Array.from({ length: 32 }, () => at), at + 1])
      expect((await ctx.contextify.stewardProfile(agent)).branch.support).toBe(33)

      await ctx.plugin(ContextTestSettings)
      await ctx.settings.update('contextify', { automaticBranchReview: true })
      const adapter = new MockAdapter([textResponse('{"action":"keep","confidence":0.8,"reason":"One planning task"}')])
      ctx.llm.registerAdapter(['mock'], adapter)
      const next = appendClosedTurn(current, 2, 'Compare another website stage', 'The next stage comparison')
      await vi.waitFor(() => {
        const review = current.snapshotEvents().findLast(event => event.type === 'contextify/branch-review')
        expect(review?.type === 'contextify/branch-review' && review.data.turnEndSeq).toBe(next.boundary)
        const suggestion = review?.type === 'contextify/branch-review' ? review.data.suggestion : null
        if (offset === 0) expect(suggestion).toBe(null)
        else expect(suggestion).toMatchObject({
          confidence: 26 / 34,
          reason: 'You moved most earlier reviewed conversations to new branches; review this placement.',
        })
      })
      const view = ctx.contextify.get(agent)
      if (offset === 0) expect(view.branchSuggestion).toBeUndefined()
      else expect(view.branchSuggestion).toMatchObject({ sourceSessionId: current.id, confidence: 26 / 34 })
      expect(adapter.requests).toHaveLength(1)
      expect(ctx.sessions.list()).toHaveLength(3)
      expect(view.plan.replacements).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

})

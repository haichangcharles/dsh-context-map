// Keyless assembled-browser check for editing a recorded native Web observation.
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  ToolCallId, createAssistantMessage, createToolResultMessage, createUserMessage,
  LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-loop'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

it('edits a native Web result through the assembled Context Map and restores it with Undo', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('research-web-evidence-ui'),
      meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const agent = handle.agent
    const webText = 'WEB_EVIDENCE_B: the supplier page was superseded'
    const callId = ToolCallId('research-web-b')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Check the supplier page.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const call = agent.session.append('tool/call', {
      turn: 1, step: 1, callId, name: 'web_fetch',
      arguments: '{"url":"https://research.test/supplier-b"}',
    })
    const result = agent.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId, content: [{ type: 'text', text: webText }], isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    agent.session.append('assistant/message', {
      stream: [], turn: 1, step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'I found the supplier page.' }],
        source: { provider: 'prepared-sample', model: 'browser-check' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    scaffold.ctx.sessionTitle.rename(agent.session, 'Web evidence check')
    const hostNodes = (await scaffold.ctx.contextify.familyPage(agent)).records
    expect({
      nodes: hostNodes.map(node => ({ sourceKind: node.sourceKind, preview: node.preview })),
      result: agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
        .map(event => ({ surfaceOp: event.surfaceOp, callId: event.data.message.source.callId })),
    }).toEqual({
      nodes: expect.arrayContaining([{ sourceKind: 'web', preview: webText }]),
      result: [{ surfaceOp: 'append', callId }],
    })

    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('sample workspace missing')
    await workspace.attachSession(agent.session.id)
    await page.getByRole('treeitem').filter({ hasText: 'Web evidence check' }).click()
    const map = page.getByRole('region', { name: 'Context Map' })
    const browserNodes = await map.locator('article[aria-label]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('aria-label')))
    expect(browserNodes).toContain(`Web source message: ${webText}`)
    const evidence = map.getByRole('article', { name: `Web source message: ${webText}`, exact: true })
    await evidence.waitFor()
    const before = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    expect(before).toContain(webText)
    await evidence.getByRole('checkbox', { name: `Include ${webText} in context`, exact: true }).click()
    try {
      await expect.poll(() => scaffold.ctx.contextify.get(agent).plan.excluded.map(item => item.eventSeq))
        .toContain(result.seq)
    } catch (cause) {
      const alerts = await page.locator('[role="alert"]').allTextContents()
      throw new Error(`Web evidence click did not commit: ${JSON.stringify(alerts)}`, { cause })
    }
    const excluded = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    expect(excluded).not.toContain(webText)
    expect(excluded).not.toContain('https://research.test/supplier-b')
    await map.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(agent).plan.excluded).toHaveLength(0)
    const restored = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    expect(restored).toContain(webText)
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120_000)

it('admits only source-valid worker reports through the optional assembled Web lineage runtime', async () => {
  const sourcePath = process.env.WWW_TOPIOCQA_SOURCE
  const replayPath = process.env.WWW_TOPIOCQA_REPLAY
  if ((sourcePath === undefined) !== (replayPath === undefined)) {
    throw new Error('both TopiOCQA source and replay paths are required')
  }
  const external = sourcePath === undefined || replayPath === undefined ? undefined : (() => {
    const raw = readFileSync(sourcePath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      Question: string
      Answer: string
      Gold_passage: { id: string
        title: string
        text: string }
    })
    const replay = readFileSync(replayPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      episode_id: string
      position: number
      source_row_index: number
    }).filter(row => row.episode_id === 'evaluation-000' && row.position <= 32)
      .sort((left, right) => left.position - right.position)
    if (replay.length !== 32 || replay.some((row, index) => row.position !== index + 1)) {
      throw new Error('the frozen TopiOCQA episode prefix is unavailable')
    }
    const at = (position: number) => raw[replay[position - 1]!.source_row_index]!
    if (at(31).Gold_passage.id !== at(32).Gold_passage.id) {
      throw new Error('the target Web passage was not observed in the prior turn')
    }
    return {
      at,
      validText: `WEB-A-VALID-SOURCE\n${at(32).Gold_passage.title}\n${at(32).Gold_passage.text}`,
      revokedText: `WEB-B-REVOKED\n${at(30).Gold_passage.title}\n${at(30).Gold_passage.text}`,
      targetQuestion: at(32).Question,
      targetAnswer: at(32).Answer,
    }
  })()
  const scaffold = await launchWebScaffold({
    extraOverlayPath: resolve(import.meta.dirname, 'fixtures/contextify-lineage-overlay.yml'),
  })
  let browser: Browser | undefined
  const parentId = SessionId('research-web-source-bound-parent')
  const childGate = Promise.withResolvers<boolean>()
  const requests: Array<{ sessionId: string | undefined
    body: string
    toolNames: string[]
    recommendation: boolean }> = []
  let browserDraftReviewModelCalls = 0
  try {
    scaffold.ctx.llm.registerAdapter(['context-lineage-fixture'], new class extends LlmAdapter {
      override resolveModel(provider: string, model: string) {
        return Promise.resolve({ provider, id: model, name: model,
          reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] } })
      }

      override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const body = JSON.stringify(options.messages)
        const recommendation = String(options.system).includes('Return JSON immediately without analysis')
        requests.push({ sessionId: options.sessionId, body,
          toolNames: options.tools?.map(tool => tool.name) ?? [], recommendation })
        if (recommendation && external !== undefined) {
          const packetOutput = process.env.WWW_TOPIOCQA_RECOMMENDATION_PACKET_OUTPUT
          if (packetOutput !== undefined) writeFileSync(packetOutput, JSON.stringify({
            system: options.system, messages: options.messages,
          }, null, 2) + '\n')
        }
        if (options.sessionId !== parentId && !recommendation) await childGate.promise
        const text = recommendation ? '{"exclude":[],"include":[],"archive":[]}'
          : options.sessionId === parentId ? 'PARENT-ACK'
            : body.includes('WEB-B-REVOKED') ? 'WORKER-B-STALE' : 'WORKER-A-VALID'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const contextify = scaffold.ctx.contextify as unknown as {
      promptSettings: () => { automaticBranchReview: boolean }
    }
    const originalPromptSettings = contextify.promptSettings.bind(contextify)
    contextify.promptSettings = () => ({ ...originalPromptSettings(), automaticBranchReview: false })
    const parent = (await scaffold.ctx.agents.create({ sessionId: parentId,
      meta: { cwd: `${scaffold.workspaceCwd}/workspace` },
      agentOptions: { provider: 'context-lineage-fixture', model: 'fixture' },
    })).agent
    parent.followup(createUserMessage({ content: [{ type: 'text',
      text: external === undefined ? 'HUMAN-A-GOAL' : external.at(1).Question }],
    source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
      expect(parent.status).toBe('idle')
    }, { timeout: 10_000 })
    expect(scaffold.ctx.contextCompiler.descriptor(parent.session).id)
      .toBe('contextify-revision-lineage')
    expect(requests.find(item => item.sessionId === parentId)?.toolNames)
      .toEqual(expect.arrayContaining(['list_context_sources', 'delegate_context_sources']))
    for (let turn = 2; turn <= 31; turn += 1) {
      parent.session.append('turn/start', { turn })
      parent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: external === undefined
          ? `WEB-LONG-CHAT-${String(turn)}: compare product details`
          : `WEB-LONG-CHAT-${String(turn)}: ${external.at(turn).Question}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      parent.session.append('assistant/message', { stream: [], turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: external === undefined
            ? `Product comparison note ${String(turn)}.` : external.at(turn).Answer }],
          source: { provider: 'context-lineage-fixture', model: 'fixture' },
        }),
      }, { surfaceOp: 'append' })
      parent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    if (external !== undefined) {
      const sibling = scaffold.ctx.sessions.fork(parent.session, SessionSeq(parent.session.seq - 1),
        SessionId('research-topiocqa-alternative-branch'))
      sibling.append('turn/start', { turn: 32 })
      sibling.append('user/message', createUserMessage({ content: [{ type: 'text',
        text: `Explore the alternative song: ${external.at(30).Question}` }],
      source: { kind: 'user' } }), { surfaceOp: 'append' })
      sibling.append('assistant/message', { stream: [], turn: 32, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: external.at(30).Answer }],
          source: { provider: 'context-lineage-fixture', model: 'fixture' } }),
      }, { surfaceOp: 'append' })
      sibling.append('turn/end', { turn: 32, reason: { kind: 'completed' } })
      expect((await scaffold.ctx.contextify.familyPage(parent)).sessions).toHaveLength(2)
    }
    parent.session.append('turn/start', { turn: 32 })
    parent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'HUMAN-A-GOAL: keep the valid supplier evidence' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const callAId = ToolCallId('research-bound-web-a')
    const callA = parent.session.append('tool/call', { turn: 32, step: 1, callId: callAId,
      name: 'web_fetch', arguments: '{"url":"https://research.test/valid"}' })
    const a = parent.session.append('tool/result', { turn: 32, step: 1,
      message: createToolResultMessage({ callId: callAId,
        content: [{ type: 'text', text: external?.validText ?? 'WEB-A-VALID-SOURCE' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [callA.seq] })
    parent.session.append('turn/end', { turn: 32, reason: { kind: 'completed' } })
    if (a === undefined) throw new Error('human source missing')
    const callId = ToolCallId('research-bound-web-b')
    parent.session.append('turn/start', { turn: 33 })
    const call = parent.session.append('tool/call', { turn: 33, step: 1, callId,
      name: 'web_fetch', arguments: '{"url":"https://research.test/revoked"}' })
    const b = parent.session.append('tool/result', { turn: 33, step: 1,
      message: createToolResultMessage({ callId,
        content: [{ type: 'text', text: external?.revokedText ?? 'WEB-B-REVOKED' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    parent.session.append('turn/end', { turn: 33, reason: { kind: 'completed' } })

    if (external !== undefined) {
      const view = scaffold.ctx.contextify.get(parent)
      const page = await scaffold.ctx.contextify.familyPage(parent)
      const proposal = await scaffold.ctx.contextify.recommend(parent, {
        planRevision: view.plan.revision, graphRevision: page.revision,
        activeSessionId: parent.id,
      }, external.targetQuestion, 'fast')
      expect(proposal.mode).toBe('fast')
    }

    const list = await scaffold.ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('research-list-sources'), name: 'list_context_sources',
      arguments: {}, agent: parent })
    expect(list.isError).toBe(false)
    expect(JSON.parse(String(list.value)).sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ seq: a.seq, kind: 'web' }),
      expect.objectContaining({ seq: b.seq, kind: 'web' }),
    ]))
    scaffold.ctx.tools.register(defineTool({ name: 'subagent',
      description: 'ordinary delegation fixture', parameters: {},
      output: { schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('must not start'),
    }))
    const ordinary = await scaffold.ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('research-ordinary-worker'), name: 'subagent',
      arguments: {}, agent: parent })
    expect(ordinary.isError).toBe(true)
    expect(ordinary.error?.message).toContain('source binding')
    const delegate = async (seq: number, callName: string) => {
      const result = await scaffold.ctx.tools.execute({ signal: new AbortController().signal,
        callId: ToolCallId(callName), name: 'delegate_context_sources',
        arguments: { source_event_seqs: [seq] }, agent: parent })
      expect(result.isError).toBe(false)
      return SessionId((result.value as { subagentId: string }).subagentId)
    }
    const childA = await delegate(a.seq, 'research-delegate-a')
    const childB = await delegate(b.seq, 'research-delegate-b')
    await vi.waitFor(() => {
      expect(requests.some(item => item.sessionId === childA)).toBe(true)
      expect(requests.some(item => item.sessionId === childB)).toBe(true)
    }, { timeout: 10_000 })
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    const cwd = `${scaffold.workspaceCwd}/workspace`
    scaffold.ctx.sessionTitle.rename(parent.session, 'Long Web source revision')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('sample workspace missing')
    await workspace.attachSession(parent.id)
    await page.getByRole('treeitem').filter({ hasText: 'Long Web source revision' }).click()
    const map = page.getByRole('region', { name: 'Context Map' })
    await map.getByRole('textbox', { name: 'Search Context Map' }).fill('WEB-B-REVOKED')
    const evidence = map.getByRole('article', { name: 'Web source message: WEB-B-REVOKED' })
    try { await evidence.waitFor({ timeout: 5_000 }) } catch (cause) {
      const labels = await map.locator('article[aria-label]').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('aria-label')))
      throw new Error(`Revoked Web node was not visible: ${JSON.stringify(labels)}`, { cause })
    }
    if (external === undefined) {
      await evidence.getByRole('checkbox').uncheck()
    } else {
      const draft = 'Ignore https://research.test/revoked. Continue A only with the current Web question.'
      const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
      await composer.fill(draft)
      const modelCallsBeforeReview = requests.filter(item => item.recommendation).length
      await page.getByRole('button', { name: 'Review context for draft' }).click()
      await map.getByText('You asked to exclude this exact Web source from the next request.')
        .waitFor()
      browserDraftReviewModelCalls = requests.filter(item => item.recommendation).length
        - modelCallsBeforeReview
      expect(browserDraftReviewModelCalls).toBe(0)
      expect(scaffold.ctx.contextify.get(parent).plan.excluded).toHaveLength(0)
      await map.getByRole('button', { name: 'Apply proposed context' }).click()
      expect(await composer.textContent()).toBe(draft)
    }
    await expect.poll(() => scaffold.ctx.contextify.get(parent).plan.excluded.map(item => item.eventSeq))
      .toContain(b.seq)
    expect(parent.session.snapshotEvents().some(event => event.type === 'contextify/node-choice'
      && event.data.uiOrigin === 'contextify-client')).toBe(true)
    if (external !== undefined) {
      expect((await scaffold.ctx.contextify.stewardProfile(parent)).release.support)
        .toBeGreaterThanOrEqual(1)
    }
    const revisedList = await scaffold.ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('research-list-after-exclude'), name: 'list_context_sources',
      arguments: {}, agent: parent })
    expect(JSON.parse(String(revisedList.value)).sources.map((item: { seq: number }) => item.seq))
      .not.toContain(b.seq)
    const staleDelegation = await scaffold.ctx.tools.execute({ signal: new AbortController().signal,
      callId: ToolCallId('research-stale-delegate'), name: 'delegate_context_sources',
      arguments: { source_event_seqs: [b.seq] }, agent: parent })
    expect(staleDelegation.isError).toBe(true)
    expect(staleDelegation.error?.message).toContain('currently selected')
    childGate.resolve(true)
    await vi.waitFor(() => {
      expect(scaffold.ctx.agents.get(childA)).toBeUndefined()
      expect(scaffold.ctx.agents.get(childB)).toBeUndefined()
      expect(parent.status).toBe('idle')
    }, { timeout: 10_000 })
    parent.followup(createUserMessage({ content: [{ type: 'text',
      text: external === undefined ? 'Continue A only'
        : `Continue A only. ${external.targetQuestion}` }],
    source: { kind: 'user' } }))
    await vi.waitFor(() => {
      expect(parent.status).toBe('idle')
      expect(requests.filter(item => item.sessionId === parentId).at(-1)?.body)
        .toContain('Continue A only')
    }, { timeout: 10_000 })
    const final = requests.filter(item => item.sessionId === parentId).at(-1)?.body ?? ''
    expect(final).toContain('WORKER-A-VALID')
    expect(final).toContain('WEB-A-VALID-SOURCE')
    expect(final).not.toContain('WORKER-B-STALE')
    expect(final).not.toContain('WEB-B-REVOKED')
    expect(final).toContain('WEB-LONG-CHAT-31')
    const selectedEvidenceTexts = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(selectedEvidenceTexts)
      if (typeof value !== 'object' || value === null) return []
      return Object.values(value).flatMap(item => typeof item === 'string'
        && (item.startsWith('WEB-A-VALID-SOURCE') || item === 'WORKER-A-VALID')
        ? [item] : selectedEvidenceTexts(item))
    }
    const selectedEvidence = selectedEvidenceTexts(JSON.parse(final) as unknown).sort()
    expect(selectedEvidence).toHaveLength(2)
    const selectedEvidenceSha256 = createHash('sha256')
      .update(JSON.stringify(selectedEvidence)).digest('hex')
    if (external !== undefined) {
      const requestOutput = process.env.WWW_TOPIOCQA_REQUEST_OUTPUT
      if (requestOutput !== undefined) writeFileSync(requestOutput, JSON.stringify({
        version: 'assembled-topiocqa-long-web-context-replay-v1',
        episodeId: 'evaluation-000', targetPosition: 32,
        goldAnswer: external.targetAnswer,
        providerMessages: JSON.parse(final) as unknown,
      }, null, 2) + '\n')
      const textBlocks = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.flatMap(textBlocks)
        if (typeof value !== 'object' || value === null) return []
        const block = value as { type?: unknown; text?: unknown; content?: unknown }
        return block.type === 'text' && typeof block.text === 'string'
          ? [block.text] : textBlocks(block.content)
      }
      const finalText = textBlocks(JSON.parse(final) as unknown).join('\n')
      expect(finalText).toContain(external.targetQuestion)
      expect(finalText).toContain(external.at(32).Gold_passage.text)
      expect(finalText).not.toContain(external.at(30).Gold_passage.text)
    }
    const output = process.env.WWW_LONG_WEB_REPLAY_OUTPUT
    if (output !== undefined) writeFileSync(output, JSON.stringify({
      version: external === undefined ? 'assembled-long-web-context-replay-v1'
        : 'assembled-topiocqa-long-web-context-replay-v2',
      preparedLongChatTurns: 30,
      ...(external === undefined ? {} : { externalSourceConversationTurns: 31,
        graphSessionCount: (await scaffold.ctx.contextify.familyPage(parent)).sessions.length,
        externalTargetPosition: 32,
        profileReleaseSupport: (await scaffold.ctx.contextify.stewardProfile(parent)).release.support }),
      browserConfirmedExclude: parent.session.snapshotEvents().some(event =>
        event.type === 'contextify/node-choice' && event.data.uiOrigin === 'contextify-client'
        && event.data.mutations.some(item => item.nodeId === `${parent.id}:${String(b.seq)}`
          && item.mode === 'exclude')),
      browserReviewedAgentExclude: parent.session.snapshotEvents().some(event =>
        event.type === 'contextify/recommendation-reviewed'
        && event.data.uiOrigin === 'contextify-client'
        && event.data.acceptedNodeIds.includes(`${parent.id}:${String(b.seq)}`)),
      browserDraftReviewModelCalls,
      nativeWebResults: [a.seq, b.seq],
      childRequestCount: requests.filter(item => item.sessionId === childA
        || item.sessionId === childB).length,
      parentRequestCount: requests.filter(item => item.sessionId === parentId).length,
      finalRequestSha256: createHash('sha256').update(final).digest('hex'),
      selectedEvidenceSha256,
      finalRequestBytes: Buffer.byteLength(final),
      finalContainsValidWebSource: final.includes('WEB-A-VALID-SOURCE'),
      finalContainsRevokedWebSource: final.includes('WEB-B-REVOKED'),
      finalContainsIndependentWorker: final.includes('WORKER-A-VALID'),
      finalContainsRevokedWorker: final.includes('WORKER-B-STALE'),
    }, null, 2) + '\n')
  } finally {
    childGate.resolve(true)
    await browser?.close()
    await scaffold.close()
  }
}, 120_000)

it('uses reviewed Web Context choices in the assembled Fast recommendation path', async () => {
  const scaffold = await launchWebScaffold()
  try {
    scaffold.ctx.llm.registerAdapter(['context-policy-fixture'], new class extends LlmAdapter {
      override resolveModel(provider: string, model: string) {
        return Promise.resolve({ provider, id: model, name: model,
          reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }] } })
      }

      override async * stream(): AsyncIterable<StreamChunk> {
        const text = '{"exclude":[],"include":[],"archive":[]}'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }())
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('research-web-context-personalization'),
      meta: { cwd: `${scaffold.workspaceCwd}/workspace` },
      agentOptions: { provider: 'context-policy-fixture', model: 'fixture' },
    })
    const agent = handle.agent
    const resultSeqs: number[] = []
    for (let turn = 1; turn <= 14; turn += 1) {
      const callId = ToolCallId(`context-policy-web-${String(turn)}`)
      agent.session.append('turn/start', { turn })
      agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `Compare warranty terms ${String(turn)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      agent.session.append('assistant/message', { stream: [], turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name: 'web_fetch',
            arguments: `{"url":"https://research.test/terms/${String(turn)}"}` }],
          source: { provider: 'context-policy-fixture', model: 'fixture' },
        }),
      }, { surfaceOp: 'append' })
      const call = agent.session.append('tool/call', { turn, step: 1, callId,
        name: 'web_fetch', arguments: `{"url":"https://research.test/terms/${String(turn)}"}` })
      const result = agent.session.append('tool/result', { turn, step: 1,
        message: createToolResultMessage({ callId,
          content: [{ type: 'text', text: `Warranty source ${String(turn)}` }], isError: false }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
      agent.session.append('assistant/message', { stream: [], turn, step: 2,
        message: createAssistantMessage({
          content: [{ type: 'text', text: `Compared warranty source ${String(turn)}` }],
          source: { provider: 'context-policy-fixture', model: 'fixture' },
        }),
      }, { surfaceOp: 'append' })
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      resultSeqs.push(result.seq)
    }
    const setResultMode = async (seq: number, mode: 'exclude' | 'natural', client: boolean) => {
      const revision = scaffold.ctx.contextify.get(agent).plan.revision
      await scaffold.ctx.contextify.setNodeMode(agent, { revision },
        { sessionId: agent.id, seq }, mode, client ? 'contextify-client' : undefined)
    }
    for (const seq of resultSeqs.slice(0, 8)) await setResultMode(seq, 'exclude', false)
    for (const seq of resultSeqs.slice(0, 8)) await setResultMode(seq, 'natural', true)
    for (const seq of resultSeqs.slice(8, 13)) await setResultMode(seq, 'exclude', true)

    const plan = scaffold.ctx.contextify.get(agent).plan
    const graph = await scaffold.ctx.contextify.familyPage(agent, undefined, 100)
    const proposal = await scaffold.ctx.contextify.recommend(agent, {
      planRevision: plan.revision, graphRevision: graph.revision,
      activeSessionId: agent.id,
    }, 'Compare warranty terms')
    const target = `${agent.id}:${String(resultSeqs[13])}`
    expect(graph.records.find(node => node.id === target)).toMatchObject({
      sourceKind: 'web', webAction: 'web_fetch',
    })
    expect(proposal.selection).toContainEqual(expect.objectContaining({
      nodeId: target, action: 'exclude',
    }))
    expect(scaffold.ctx.contextify.get(agent).plan.excluded.map(item => item.nodeId))
      .not.toContain(target)
    await scaffold.ctx.contextify.setNodeModes(agent, { revision: plan.revision },
      [{ node: { sessionId: agent.id, seq: resultSeqs[13]! }, mode: 'exclude' }],
      graph.revision, 'contextify-client')
    const nextInput = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 15, step: 1,
    }).messages)
    expect(nextInput).not.toContain('Warranty source 14')
  } finally { await scaffold.close() }
}, 120_000)

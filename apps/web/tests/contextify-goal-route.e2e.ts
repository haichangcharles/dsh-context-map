/** Keyless real-Web composition; model responses are engineering fixtures, not accuracy evidence. */
import { chromium, type Browser } from 'playwright'
import { expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type Session } from '@deepseek-ai/dsh-session'
import { CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from './support.ts'

function append(session: Session, text: string) {
  const turn = session.seq + 1
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
  session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
    source: { provider: 'prepared-sample', model: 'goal-web' }, content: [{ type: 'text', text: 'Task recorded.' }],
  }) }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

it('reviews a new sibling task in the browser, preserves its draft and applies native parent Context', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  const originalFetch = globalThis.fetch
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const credential = vi.spyOn(scaffold.ctx.credentials, 'resolve').mockResolvedValue({ value: 'fixture-only-key', source: 'test' })
  try {
    const settings = scaffold.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    settings.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS,
      fastDecisionProvider: 'goal-model-jev', automaticBranchReview: false,
      context: { additional: 'Independent trip services are sibling tasks. Use the complete task and ancestors.', override: '' } })
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const root = (await scaffold.ctx.agents.create({ sessionId: SessionId('goal-web-main'), meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
    append(root.session, 'DINNER_MAINLINE: organize the trip.')
    const seed = root.session.snapshotEvents()
    const hotel = (await scaffold.ctx.agents.create({ sessionId: SessionId('goal-web-hotel'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { cwd, parentSession: root.id, isSeeded: true },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
    append(hotel.session, 'HOTEL_ONLY: lodging preferences.')
    scaffold.ctx.sessionTitle.rename(hotel.session, 'Hotel task fixture')
    let modelCalls = 0, jevCalls = 0
    scaffold.ctx.on('llm/stream', (request): AsyncIterable<StreamChunk> => {
      expect(request.messages[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'contextify' })
      const input = request.messages[0]?.content[0]
      expect(input?.type === 'text' && (JSON.parse(input.text) as { draft: string }).draft).toBe('Arrange transport for the trip.')
      modelCalls += 1
      const text = JSON.stringify({ goal: 'Arrange transport', assignment: 'new', sessionId: root.id })
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }, { global: true, prepend: true })
    fetcher.mockImplementation(async (url, init) => {
      if (url !== 'https://api.typesafe.ai/v1/systemone') return originalFetch(url, init)
      jevCalls += 1
      if (typeof init?.body !== 'string') throw new Error('Expected JSON Jev fixture request')
      const body = JSON.parse(init.body) as { questions: Record<string, { type: string; criteria?: Record<string, string> }> }
      return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
        if (q.type === 'noul') return [key, { type: 'noul', noul: key === 'wholeTask' ? 1 : .05 }]
        const choice: string = q.criteria?.p0 === undefined ? 'active' : 'p0'
        return [key, { type: 'choice', choice, probabilities: { [choice]: 1 } }]
      })) as Record<string, unknown> })
    })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('fixture workspace missing')
    await workspace.attachSession(hotel.id)
    await page.getByRole('treeitem').filter({ hasText: 'Hotel task fixture' }).click()
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, 'Arrange transport for the trip.')
    await page.getByRole('button', { name: 'Draft review mode', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Fast review for draft', exact: true }).click()
    const review = page.getByRole('dialog', { name: 'Context recommendation review' })
    await review.waitFor({ timeout: 15_000 })
    await review.getByRole('button', { name: 'Create branch with proposed Context', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agents.list().filter(agent => agent.session.header.parentSession === root.id).length,
      { timeout: 15_000 }).toBe(2)
    const child = scaffold.ctx.agents.list().find(agent => agent.id !== hotel.id && agent.session.header.parentSession === root.id)
    if (child === undefined) throw new Error('reviewed sibling missing')
    await expect.poll(() => child.session.snapshotEvents().some(e => e.type === 'contextify/recommendation-reviewed'),
      { timeout: 10_000 }).toBe(true)
    const compiled = scaffold.ctx.contextCompiler.compile({ session: child.session, turn: child.session.seq + 1, step: 1 })
    expect(JSON.stringify(compiled.messages)).toContain('DINNER_MAINLINE')
    expect(JSON.stringify(compiled.messages)).not.toContain('HOTEL_ONLY')
    scaffold.ctx.sessionTitle.rename(child.session, 'Approved transport task fixture')
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').innerText(),
      { timeout: 10_000 }).toContain('Approved transport task fixture')
    await expect.poll(() => input.innerText()).toBe('Arrange transport for the trip.')
    expect(modelCalls).toBe(1)
    expect(jevCalls).toBe(1)
    expect(JSON.stringify(hotel.session.snapshotEvents())).not.toContain('fixture-only-key')
  } finally {
    try { await browser?.close() } finally {
      fetcher.mockRestore()
      credential.mockRestore()
      await scaffold.close()
    }
  }
}, 90_000)

// This case calls the same Host services directly; responses are engineering fixtures only.
it('projects confirmed management workflows through the real Loader and removes them on disable and reset', async () => {
  const scaffold = await launchWebScaffold()
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const credential = vi.spyOn(scaffold.ctx.credentials, 'resolve').mockResolvedValue({ value: 'fixture-only-key', source: 'test' })
  let tick = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => tick++)
  try {
    let enabled = true
    const settings = scaffold.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    settings.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, personalizationEnabled: enabled,
      fastDecisionProvider: 'goal-model-jev', automaticBranchReview: false })
    const root = (await scaffold.ctx.agents.create({ sessionId: SessionId('memory-loader-main'),
      meta: { cwd: `${scaffold.workspaceCwd}/workspace` },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
    append(root.session, 'Plan the workshop.')
    for (let i = 0; i < 4; i++) {
      const seed = root.session.snapshotEvents()
      const child = (await scaffold.ctx.agents.create({ sessionId: SessionId(`memory-loader-child-${i}`), seed,
        inheritedEventCount: SessionLogOffset(seed.length),
        meta: { cwd: `${scaffold.workspaceCwd}/workspace`, parentSession: root.id, isSeeded: true },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
      append(child.session, `Plan independent venue ${i}.`)
      await scaffold.ctx.contextify.recordManualBranch(root, child.id, 'contextify-client', `Plan venue ${i}.`)
      const page = await scaffold.ctx.contextify.familyPage(child)
      await scaffold.ctx.contextify.recordManualRoute(child, root.id, `return-${i}`, page.revision, 'contextify-client', 'Return to plan.')
    }
    const goalInputs: Record<string, unknown>[] = [], jevInputs: Record<string, unknown>[] = []
    scaffold.ctx.on('llm/stream', (request): AsyncIterable<StreamChunk> => {
      const block = request.messages[0]?.content[0]
      if (block?.type !== 'text') throw new Error('Expected goal fixture input')
      goalInputs.push(JSON.parse(block.text) as Record<string, unknown>)
      const text = JSON.stringify({ goal: 'Plan workshop', assignment: 'existing', sessionId: root.id })
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }, { global: true, prepend: true })
    fetcher.mockImplementation(async (url, init) => {
      if (url !== 'https://api.typesafe.ai/v1/systemone') throw new Error('External inference blocked by fixture')
      if (typeof init?.body !== 'string') throw new Error('Expected Jev fixture input')
      const body = JSON.parse(init.body) as {
        state: { contextActions: Record<string, unknown> }
        questions: Record<string, { type: string; criteria?: Record<string, string> }>
      }
      jevInputs.push(body.state.contextActions)
      return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
        if (q.type === 'noul') return [key, { type: 'noul', noul: key === 'wholeTask' ? 1 : .05 }]
        const choice: string = q.criteria?.p0 === undefined ? 'active' : 'p0'
        return [key, { type: 'choice', choice, probabilities: { [choice]: 1 } }]
      })) as Record<string, unknown> })
    })
    const review = async () => {
      const page = await scaffold.ctx.contextify.familyPage(root)
      return scaffold.ctx.contextify.recommend(root, { activeSessionId: root.id, graphRevision: page.revision,
        planRevision: scaffold.ctx.contextify.get(root).plan.revision }, 'Plan the next workshop.', 'fast', true)
    }
    expect((await scaffold.ctx.contextify.policyEvidence(root)).filter(row => row.action === 'branch')).toHaveLength(4)
    const revision = scaffold.ctx.contextify.get(root).plan.revision
    const proposal = await review()
    expect(proposal.personalization?.managementMemory?.rules).toContainEqual(expect.objectContaining({ action: 'branch', activity: 'planning', accepted: 4 }))
    expect(proposal.personalization?.managementMemory?.workflows).toContainEqual(expect.objectContaining({ actions: ['branch', 'return'] }))
    expect(goalInputs[0]?.managementMemory).toEqual(proposal.personalization?.managementMemory)
    expect(jevInputs[0]?.managementMemory).toEqual(proposal.personalization?.managementMemory)
    expect(proposal.personalization?.managementMemory).toMatchSnapshot('confirmed management memory from native events')
    const requests = root.session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-request')
    expect(requests).toHaveLength(2)
    const loggedGoal = JSON.parse(requests[0]!.data.userText) as Record<string, unknown>
    const loggedJev = JSON.parse(requests[1]!.data.userText) as { state: { contextActions: Record<string, unknown> } }
    expect(loggedGoal.managementMemory).toEqual(goalInputs[0]?.managementMemory)
    expect(loggedJev.state.contextActions.managementMemory).toEqual(jevInputs[0]?.managementMemory)
    const compiled = scaffold.ctx.contextCompiler.compile({ session: root.session, turn: root.session.seq + 1, step: 1 })
    expect(JSON.stringify(compiled.messages)).not.toContain('managementMemory')
    expect(scaffold.ctx.contextify.get(root).plan.revision).toBe(revision)
    enabled = false
    expect((await review()).personalization?.managementMemory).toBeUndefined()
    expect(goalInputs[1]?.managementMemory).toBeUndefined()
    expect(jevInputs[1]?.managementMemory).toBeUndefined()
    enabled = true
    await scaffold.ctx.contextify.resetPolicy(root, 'contextify-client')
    expect((await review()).personalization?.managementMemory).toBeUndefined()
    expect(goalInputs[2]?.managementMemory).toBeUndefined()
    expect(jevInputs[2]?.managementMemory).toBeUndefined()
    expect(scaffold.ctx.contextify.get(root).plan.revision).toBe(revision)
    expect(JSON.stringify(root.session.snapshotEvents())).not.toContain('fixture-only-key')
  } finally {
    clock.mockRestore(); fetcher.mockRestore(); credential.mockRestore()
    await scaffold.close()
  }
}, 90_000)

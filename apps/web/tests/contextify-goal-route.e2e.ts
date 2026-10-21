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

it('logs partial inventory and native lifecycle through the real Loader without granting routes', async () => {
  const scaffold = await launchWebScaffold()
  try {
    const settings = scaffold.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    settings.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, fastDecisionProvider: 'goal-model-native',
      automaticBranchReview: false })
    const root = (await scaffold.ctx.agents.create({ sessionId: SessionId('inventory-root'),
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
    append(root.session, 'Root planning task.')
    const seed = root.session.snapshotEvents()
    let active = root
    for (let index = 0; index < 9; index++) {
      active = (await scaffold.ctx.agents.create({ sessionId: SessionId(`inventory-${index}`), seed,
        inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: root.id, isSeeded: true },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
      append(active.session, `Separate planning task ${index}.`)
    }
    let calls = 0
    scaffold.ctx.on('llm/stream', (): AsyncIterable<StreamChunk> => {
      calls++
      const text = '{"goal":"Unidentified continuation","assignment":"unknown","sessionId":null,"retention":"unknown"}'
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }, { global: true, prepend: true })
    for (const [id, state] of [[root.id, 'completed'], [active.id, 'parked']] as const) {
      const page = await scaffold.ctx.contextify.familyPage(active)
      await scaffold.ctx.contextify.setWorkState(active, id, state, page.revision, 'contextify-client')
    }
    const page = await scaffold.ctx.contextify.familyPage(active)
    const before = scaffold.ctx.contextify.get(active).plan
    const result = await scaffold.ctx.contextify.recommend(active,
      { activeSessionId: active.id, graphRevision: page.revision, planRevision: before.revision },
      'Continue the earlier planning work.', 'fast', true)
    const requests = active.session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-request')
    expect(requests).toHaveLength(1)
    const input = JSON.parse(requests[0]!.data.userText) as { omittedTaskCount: number; tasks: unknown[] }
    expect(input.omittedTaskCount).toBe(1)
    expect(input.tasks).toHaveLength(9)
    expect(input.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: root.id, workState: 'completed', workStateSource: 'explicit' }),
      expect.objectContaining({ sessionId: active.id, workState: 'parked', workStateSource: 'explicit' }),
    ]))
    expect(requests[0]!.data.system).toContain('The supplied task inventory is partial')
    expect(result.route).toBeUndefined()
    expect(result.selection).toEqual([])
    expect(scaffold.ctx.contextify.get(active).plan).toEqual(before)
    expect(calls).toBe(1)
  } finally { await scaffold.close() }
})

it.each(['goal-model-jev', 'goal-model-native'] as const)('reviews a new sibling task in the browser with %s and applies native parent Context', async (provider) => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  const originalFetch = globalThis.fetch
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const credential = vi.spyOn(scaffold.ctx.credentials, 'resolve').mockResolvedValue({ value: 'fixture-only-key', source: 'test' })
  try {
    const settings = scaffold.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    settings.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS,
      fastDecisionProvider: provider, automaticBranchReview: false,
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
    const records = (await scaffold.ctx.contextify.familyPage(hotel)).records
    for (const [ownerId, mode] of [[root.id, 'exclude'], [root.id, 'natural'], [hotel.id, 'exclude']] as const) {
      const source = records.find(node => node.owner.sessionId === ownerId && node.role === 'user')!
      await scaffold.ctx.contextify.setNodeMode(hotel,
        { revision: scaffold.ctx.contextify.get(hotel).plan.revision }, source.owner, mode, 'contextify-client')
    }
    let modelCalls = 0, jevCalls = 0
    let observedExamples: unknown[] | undefined
    scaffold.ctx.on('llm/stream', (request): AsyncIterable<StreamChunk> => {
      expect(request.messages[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'contextify' })
      const input = request.messages[0]?.content[0]
      expect(input?.type === 'text' && (JSON.parse(input.text) as { draft: string }).draft).toBe('Arrange transport for the trip.')
      modelCalls += 1
      const text = JSON.stringify({ goal: 'Arrange transport', retention: 'task-lineage', assignment: 'new', sessionId: root.id })
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
      const body = JSON.parse(init.body) as {
        state: { instructions: string; graph: { preferenceExamples: unknown[] } }
        questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>
      }
      expect(body.state.instructions).toContain(JSON.stringify({ goal: 'Arrange transport', retention: 'task-lineage', assignment: 'new', sessionId: root.id }))
      observedExamples = body.state.graph.preferenceExamples
      const questions = Object.values(body.questions)
      expect(questions.some(question => question.instructions.includes(
        JSON.stringify({ ownerSessionId: root.id, relation: 'new-parent' })))).toBe(true)
      expect(questions.some(question => question.instructions.includes(
        JSON.stringify({ ownerSessionId: hotel.id, relation: 'other-owner' })))).toBe(true)
      return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
        if (q.type === 'noul') {
          const preserved = key.startsWith('n') && q.instructions.includes('"baseIncluded":true')
          return [key, { type: 'noul', noul: key === 'wholeTask' || preserved ? 1 : .05 }]
        }
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
    await expect.poll(() => ({ modelCalls, jevCalls })).toEqual({ modelCalls: 1, jevCalls: provider === 'goal-model-native' ? 0 : 1 })
    if (provider === 'goal-model-jev') expect(observedExamples).toEqual([
      expect.objectContaining({ mode: 'exclude', onActiveBranch: true, ownerRelation: 'ancestor-task' }),
      expect.objectContaining({ mode: 'include', onActiveBranch: true, ownerRelation: 'ancestor-task' }),
      expect.objectContaining({ onActiveBranch: true, ownerRelation: 'local-task' }),
    ])
    const review = page.getByRole('dialog', { name: 'Context recommendation review' })
    await review.waitFor({ timeout: 15_000 })
    await review.getByRole('button', { name: 'Create branch with proposed Context', exact: true }).click()
    await expect.poll(() => scaffold.ctx.agents.list().filter(agent => agent.session.header.parentSession === root.id).length,
      { timeout: 15_000 }).toBe(2)
    const child = scaffold.ctx.agents.list().find(agent => agent.id !== hotel.id && agent.session.header.parentSession === root.id)
    if (child === undefined) throw new Error('reviewed sibling missing')
    await expect.poll(() => child.session.snapshotEvents().some(e => e.type === 'contextify/recommendation-reviewed'),
      { timeout: 10_000 }).toBe(true)
    const carried = child.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-reviewed')
    expect(carried?.type === 'contextify/recommendation-reviewed' ? carried.data : undefined).toMatchObject({
      sourceBase: { activeSessionId: hotel.id },
      selection: [],
    })
    expect(carried?.type === 'contextify/recommendation-reviewed' ? carried.data.scopePolicy : undefined).toBeUndefined()
    const requests = hotel.session.snapshotEvents().filter(e => e.type === 'contextify/recommendation-request')
    expect(requests).toHaveLength(provider === 'goal-model-native' ? 1 : 2)
    const traceId = requests[0]!.data.recommendationTraceId
    expect(traceId).toEqual(expect.any(String))
    if (provider === 'goal-model-jev') expect(requests[1]!.data.recommendationTraceId).toBe(traceId)
    else {
      expect(requests[0]!.data.system).toContain('without individual source exceptions')
      expect(credential).not.toHaveBeenCalledWith('TYPESAFE_API_KEY')
    }
    expect(carried?.type === 'contextify/recommendation-reviewed' ? carried.data.recommendationTraceId : undefined).toBe(traceId)
    const compiled = scaffold.ctx.contextCompiler.compile({ session: child.session, turn: child.session.seq + 1, step: 1 })
    expect(JSON.stringify(compiled.messages)).toContain('DINNER_MAINLINE')
    expect(JSON.stringify(compiled.messages)).not.toContain('HOTEL_ONLY')
    scaffold.ctx.sessionTitle.rename(child.session, 'Approved transport task fixture')
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').innerText(),
      { timeout: 10_000 }).toContain('Approved transport task fixture')
    await expect.poll(() => input.innerText()).toBe('Arrange transport for the trip.')
    expect(modelCalls).toBe(1)
    expect(jevCalls).toBe(provider === 'goal-model-native' ? 0 : 1)
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
      const text = JSON.stringify({ goal: 'Plan workshop', retention: 'task-lineage', assignment: 'existing', sessionId: root.id })
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
        questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> }>
      }
      expect(Object.keys(body.questions).some(key => ['active', 'newTask', 'parent'].includes(key) || /^task\d+$/.test(key))).toBe(false)
      expect(body.questions.wholeTask).toBeUndefined()
      jevInputs.push(body.state.contextActions)
      return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
        if (q.type === 'noul') {
          const preserved = key.startsWith('n') && q.instructions.includes('"baseIncluded":true')
          return [key, { type: 'noul', noul: key === 'wholeTask' || preserved ? 1 : .05 }]
        }
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
    for (let i = 0; i < 35; i++) append(root.session, `Planning record ${i}`)
    const wide = await scaffold.ctx.contextify.familyPage(root, undefined, 500)
    await scaffold.ctx.contextify.setNodeModes(root, { revision: scaffold.ctx.contextify.get(root).plan.revision },
      wide.records.filter(node => node.role === 'user' && node.owner.sessionId === root.id).slice(0, 33)
        .map(node => ({ node: node.owner, mode: 'exclude' as const })))
    const widePage = await scaffold.ctx.contextify.familyPage(root)
    const local = await scaffold.ctx.contextify.recommend(root, { activeSessionId: root.id, graphRevision: widePage.revision,
      planRevision: scaffold.ctx.contextify.get(root).plan.revision }, 'New topic: Separate planning task', 'local', true)
    expect(local.route?.action).toBe('branch')
    expect(local.proposedNodeIds).toEqual(local.currentNodeIds)
    expect(goalInputs).toHaveLength(3)
    expect(jevInputs).toHaveLength(3)
    expect(JSON.stringify(root.session.snapshotEvents())).not.toContain('fixture-only-key')
  } finally {
    clock.mockRestore(); fetcher.mockRestore(); credential.mockRestore()
    await scaffold.close()
  }
}, 90_000)

it.each([false, true])('acknowledges the displayed complete policy through the shipped Client and next goal review (carry=%s)', async (carry) => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  let restoreFetch: (() => void) | undefined
  let restoreCredential: (() => void) | undefined
  const originalFetch = globalThis.fetch
  try {
    const credential = vi.spyOn(scaffold.ctx.credentials, 'resolve').mockResolvedValue({ value: 'fixture-only-key', source: 'test' })
    restoreCredential = () => { credential.mockRestore() }
    const settings = scaffold.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    settings.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, fastDecisionProvider: 'goal-model-jev', automaticBranchReview: false })
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const root = (await scaffold.ctx.agents.create({ sessionId: SessionId('scope-web-parent'), meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
    append(root.session, 'PARENT_SCOPE_SOURCE')
    const seed = root.session.snapshotEvents()
    const child = (await scaffold.ctx.agents.create({ sessionId: SessionId('scope-web-child'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { cwd, parentSession: root.id, isSeeded: true },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent
    append(child.session, 'OWN_SCOPE_SOURCE')
    const source = carry ? (await scaffold.ctx.agents.create({ sessionId: SessionId('scope-web-origin'), seed,
      inheritedEventCount: SessionLogOffset(seed.length), meta: { cwd, parentSession: root.id, isSeeded: true },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })).agent : child
    if (carry) append(source.session, 'UNRELATED_ORIGIN_SOURCE')
    scaffold.ctx.sessionTitle.rename(source.session, 'Complete policy fixture')
    const inputs: { confirmedScopePolicies?: unknown[] }[] = []
    scaffold.ctx.on('llm/stream', (request): AsyncIterable<StreamChunk> => {
      expect(request.messages[0]?.source).toMatchObject({ kind: 'plugin', plugin: 'contextify' })
      const input = request.messages[0]?.content[0]
      if (input?.type !== 'text') throw new Error('Expected goal input')
      inputs.push(JSON.parse(input.text) as { confirmedScopePolicies?: unknown[] })
      const text = JSON.stringify({ goal: 'Continue own writing', retention: 'task-owned', assignment: 'existing', sessionId: child.id })
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }, { global: true, prepend: true })
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (url !== 'https://api.typesafe.ai/v1/systemone') return originalFetch(url, init)
      if (typeof init?.body !== 'string') throw new Error('Expected fixture body')
      const body = JSON.parse(init.body) as { questions: Record<string, {
        type: string
        instructions: string
        criteria?: Record<string, string>
      }> }
      return Response.json({ model: 'jev-1.13.0', answers: Object.fromEntries(Object.entries(body.questions).map(([key, q]) => {
        if (q.type === 'noul') return [key, { type: 'noul', noul: key.startsWith('n') && q.instructions.includes('"baseIncluded":true') ? 1 : .05 }]
        const choice = q.criteria?.p0 === undefined ? 'active' : 'p0'
        return [key, { type: 'choice', choice, probabilities: { [choice]: 1 } }]
      })) as Record<string, unknown> })
    })
    restoreFetch = () => { fetcher.mockRestore() }
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('Fixture workspace unavailable')
    await workspace.attachSession(source.id)
    await page.getByRole('treeitem').filter({ hasText: 'Complete policy fixture' }).click()
    await writeComposerDraft(page, page.locator('[data-composer-input]').first(), 'Continue own writing with only this task.')
    await page.getByRole('button', { name: 'Draft review mode', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Fast review for draft', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Context recommendation review' })
    await dialog.getByText('Only this task', { exact: true }).waitFor({ timeout: 15_000 })
    await dialog.getByRole('button', { name: carry ? 'Move draft with proposed Context' : 'Apply proposed context', exact: true }).click()
    await expect.poll(() => child.session.snapshotEvents().some(e => e.type === 'contextify/recommendation-reviewed' && e.data.scopePolicy?.mode === 'task-owned'), { timeout: 15_000 }).toBe(true)
    if (carry) {
      const carried = child.session.snapshotEvents().findLast(e => e.type === 'contextify/recommendation-reviewed')
      expect(carried?.type === 'contextify/recommendation-reviewed' ? carried.data : undefined).toMatchObject({
        sourceBase: { activeSessionId: source.id },
        scopePolicy: { mode: 'task-owned', assignment: 'existing', sessionId: child.id, sourceCount: 2 },
      })
    }
    const compiled = scaffold.ctx.contextCompiler.compile({ session: child.session, turn: child.session.seq + 1, step: 1 })
    expect(JSON.stringify(compiled.messages)).toContain('OWN_SCOPE_SOURCE')
    expect(JSON.stringify(compiled.messages)).not.toContain('PARENT_SCOPE_SOURCE')
    expect(JSON.stringify(compiled.messages)).not.toContain('UNRELATED_ORIGIN_SOURCE')
    const family = await scaffold.ctx.contextify.familyPage(child)
    const next = await scaffold.ctx.contextify.recommend(child, { activeSessionId: child.id, graphRevision: family.revision,
      planRevision: scaffold.ctx.contextify.get(child).plan.revision }, 'Continue the next section.', 'fast', true)
    expect(inputs[0]?.confirmedScopePolicies).toBeUndefined()
    expect(inputs[1]?.confirmedScopePolicies).toEqual([expect.objectContaining({ mode: 'task-owned', sourceSessionId: child.id })])
    expect(next.personalization?.scopePolicyExamples).toHaveLength(1)
    expect(inputs).toHaveLength(2)
    if (!carry) {
      const originalExample = next.personalization!.scopePolicyExamples![0]!
      for (const objective of ['Compile invoice ledger.', 'Plan gallery lighting.', 'Translate sonnet meter.', 'Schedule orchard pruning.']) {
        const history = await scaffold.ctx.contextify.familyPage(child)
        await scaffold.ctx.contextify.setNodeModes(child, { revision: scaffold.ctx.contextify.get(child).plan.revision },
          history.records.filter(node => node.owner.sessionId === root.id).map(node => ({ node: node.owner, mode: 'natural' })))
        const current = await scaffold.ctx.contextify.familyPage(child)
        const proposal = await scaffold.ctx.contextify.recommend(child, { activeSessionId: child.id, graphRevision: current.revision,
          planRevision: scaffold.ctx.contextify.get(child).plan.revision }, objective, 'fast', true)
        await scaffold.ctx.contextify.presentRecommendation(child, proposal, 'contextify-client')
        await scaffold.ctx.contextify.setNodeModes(child, { revision: proposal.base.planRevision }, proposal.selection.map(item => ({
          node: current.records.find(node => node.id === item.nodeId)!.owner,
          mode: item.action === 'exclude' ? 'exclude' as const : 'natural' as const,
        })), proposal.base.graphRevision, 'contextify-client', [], proposal.scopePolicy!.key)
      }
      const queryFamily = await scaffold.ctx.contextify.familyPage(child)
      const retrieved = await scaffold.ctx.contextify.recommend(child, { activeSessionId: child.id, graphRevision: queryFamily.revision,
        planRevision: scaffold.ctx.contextify.get(child).plan.revision }, 'Continue own writing with only this task.', 'fast', true)
      expect(retrieved.personalization?.scopePolicyExamples).toContainEqual(originalExample)
      const recent = (await scaffold.ctx.contextify.stewardProfile(child)).scopePolicyExamples!
      expect(recent).toHaveLength(4); expect(recent).not.toContainEqual(originalExample)
      expect(inputs.at(-1)?.confirmedScopePolicies).toEqual(retrieved.personalization?.scopePolicyExamples)
      expect(retrieved.personalization?.scopePolicyExamples?.map(({ objective, mode, assignment }) =>
        ({ objective, mode, assignment }))).toMatchSnapshot('goal-conditioned confirmed scope policies')
      const map = page.getByRole('region', { name: 'Context Map', exact: true })
      await map.getByRole('button', { name: 'Context preferences', exact: true }).click()
      const preferences = map.getByRole('region', { name: 'Learned Context preferences', exact: true })
      const examples = preferences.getByText('Confirmed complete-policy examples', { exact: true }).locator('..')
      await examples.locator('summary').click()
      await examples.getByText('Task at the time: Schedule orchard pruning.', { exact: true }).waitFor()
      const example = recent.at(-1)!
      await examples.getByText(`Record source: ${example.sourceSessionId}:${String(example.sourceEventSeq)}`, { exact: true }).waitFor()
      const planRevision = scaffold.ctx.contextify.get(child).plan.revision
      await preferences.getByRole('button', { name: 'Reset learned preferences', exact: true }).click()
      const emptyExamples = examples.getByText('No active complete-scope approvals yet.', { exact: true })
      await emptyExamples.waitFor({ state: 'attached' })
      await examples.locator('summary').click()
      await emptyExamples.waitFor()
      expect((await scaffold.ctx.contextify.stewardProfile(child)).scopePolicyExamples).toEqual([])
      expect(scaffold.ctx.contextify.get(child).plan.revision).toBe(planRevision)
      const afterReset = scaffold.ctx.contextCompiler.compile({ session: child.session, turn: child.session.seq + 1, step: 1 })
      expect(JSON.stringify(afterReset.messages)).toBe(JSON.stringify(compiled.messages))
    }
  } finally {
    try { await browser?.close() } finally {
      restoreFetch?.(); restoreCredential?.()
      await scaffold.close()
    }
  }
}, 90_000)

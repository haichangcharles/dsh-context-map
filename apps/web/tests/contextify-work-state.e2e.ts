/** A reviewed branch lifecycle choice reaches the native Session graph through the browser. */
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, writeComposerDraft } from './support.ts'

it('completes and reopens a branch without changing the selected request context', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const { agent } = await scaffold.ctx.agents.create({
      sessionId: SessionId('work-state-root'), meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Plan the launch.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', { stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'First, draft the announcement.' }],
        source: { provider: 'prepared-sample', model: 'browser-check' },
      }),
    }, { surfaceOp: 'append' })
    const boundary = agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const forked = await scaffold.ctx.sessionController.fork({ sessionId: agent.id, atSeq: boundary.seq })
    const child = scaffold.ctx.sessions.get(forked.sessionId)
    if (child === undefined) throw new Error('native Session Controller fork did not create a child')
    child.append('turn/start', { turn: 2 })
    child.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Draft the announcement.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    child.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    scaffold.ctx.sessionTitle.rename(agent.session, 'Launch planning')

    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('sample workspace missing')
    await workspace.attachSession(agent.id)
    await page.getByRole('treeitem').filter({ hasText: 'Launch planning' }).click()

    const map = page.getByRole('region', { name: 'Context Map' })
    await map.getByText('Branches (2) · task lifecycle').click()
    const childRow = map.locator(`[data-work-session-id="${child.id}"]`)
    const compiled = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    const planRevision = scaffold.ctx.contextify.get(agent).plan.revision
    await childRow.getByRole('button', { name: 'Complete Draft the announcement.' }).click()
    await expect.poll(async () => (await scaffold.ctx.contextify.familyPage(agent)).sessions
      .find(session => session.id === child.id)?.workState).toBe('completed')
    await expect.poll(() => childRow.getAttribute('data-work-state')).toBe('completed')
    expect(JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)).toBe(compiled)
    expect(scaffold.ctx.contextify.get(agent).plan.revision).toBe(planRevision)

    await childRow.getByRole('button', { name: 'Reopen Draft the announcement.' }).click()
    await expect.poll(async () => (await scaffold.ctx.contextify.familyPage(agent)).sessions
      .find(session => session.id === child.id)?.workState).toBe('open')
    await expect.poll(() => childRow.getAttribute('data-work-state')).toBe('open')
    expect(JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)).toBe(compiled)

    const composer = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, composer, 'Park this task until the announcement is ready')
    await page.getByRole('button', { name: 'Review context for draft', exact: true }).click()
    const review = map.getByRole('dialog', { name: 'Context recommendation review' })
    await review.waitFor({ timeout: 10_000 })
    await review.getByRole('button', { name: 'Park branch', exact: true }).click()
    await expect.poll(async () => (await scaffold.ctx.contextify.familyPage(agent)).sessions
      .find(session => session.id === agent.id)?.workState).toBe('parked')
    expect(scaffold.ctx.contextify.get(agent).plan.revision).toBe(planRevision)
    await review.getByRole('button', { name: 'Close recommendation review' }).click()
    await writeComposerDraft(page, composer, 'Write the announcement in its own branch')
    await childRow.getByRole('button', { name: 'Move draft here: Draft the announcement.', exact: true }).click()
    await expect.poll(() => agent.session.snapshotEvents().filter(event => event.type === 'contextify/manual-route')
      .map(event => event.data.objective), { timeout: 10_000 })
      .toEqual(['Write the announcement in its own branch'])
    await expect.poll(() => composer.innerText(), { timeout: 10_000 }).toBe('Write the announcement in its own branch')
    try { await expect.poll(() => childRow.textContent({ timeout: 1_000 }), { timeout: 8_000 }).toContain('Active · open') }
    catch (cause) { throw new Error(`Destination activation failed: agent=${String(scaffold.ctx.agents.get(child.id) !== undefined)}; map=${JSON.stringify(await map.allTextContents())}; alerts=${JSON.stringify(await page.getByRole('alert').allTextContents())}`, { cause }) }
    await map.getByRole('button', { name: 'Context preferences', exact: true }).click()
    const preferences = map.getByRole('region', { name: 'Learned Context preferences' })
    try { await preferences.getByText('Recent explicit choices', { exact: true }).waitFor({ timeout: 10_000 }) }
    catch (cause) { throw new Error(`Preference inspector failed: ${JSON.stringify(await preferences.allTextContents())}; alerts=${JSON.stringify(await map.getByRole('alert').allTextContents())}`, { cause }) }
    await preferences.getByRole('button', { name: 'Reset learned preferences', exact: true }).click()
    const emptyEvidence = preferences.getByText('No recorded explicit choices yet.', { exact: true })
    await emptyEvidence.waitFor({ state: 'attached', timeout: 10_000 })
    await preferences.getByText('Recent explicit choices', { exact: true }).click()
    await emptyEvidence.waitFor({ timeout: 10_000 })
    expect(scaffold.ctx.contextify.get(agent).plan.revision).toBe(planRevision)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'contextify/manual-route')).toHaveLength(1)
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120_000)

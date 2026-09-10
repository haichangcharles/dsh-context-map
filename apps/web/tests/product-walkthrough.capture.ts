/**
 * Capture real product screenshots with a prepared conversation and review fixture.
 * Run: pnpm exec vitest run --config product-site/capture.config.ts
 * The unique output directory is printed after the hermetic application closes.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title'
import { CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

it('captures branching, cross-branch context and review without losing history', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dsh-gallery-'))
  const enterpriseQuestion = 'Explore an enterprise pilot with paid onboarding.'
  const scaffold = await launchWebScaffold({
    contextRecommendation: (prompt) => {
      const marker = 'Conversation graph JSON:\n'
      const graph = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as { nodes: { id: string; content: string }[] }
      const obsolete = graph.nodes.find(node => node.content === enterpriseQuestion)
      if (obsolete === undefined) throw new Error('prepared review message missing')
      return { exclude: [{ nodeId: obsolete.id, reason: 'The active direction is a free community launch. Paid onboarding is an earlier alternative.' }], include: [], archive: [] }
    },
  })
  let browser: Browser | undefined
  try {
    const contextify = scaffold.ctx.contextify as unknown as { promptSettings: () => ContextifyPromptSettings }
    contextify.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false })
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, locale: 'en-US', colorScheme: 'dark', deviceScaleFactor: 3 })
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    const handle = await scaffold.ctx.agents.create({ sessionId: SessionId('launch-options'), meta: { cwd }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    const root = handle.agent
    const append = (session: typeof root.session, turn: number, user: string, answer: string): void => {
      session.append('turn/start', { turn })
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      session.append('assistant/message', { stream: [], turn, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: answer }], source: { provider: 'prepared-sample', model: 'gallery' } }) }, { surfaceOp: 'append' })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const startingAnswer = 'Two paths to explore: a community launch or an enterprise pilot.'
    append(root.session, 1, 'How should we launch our open-source research tool?', startingAnswer)
    scaffold.ctx.sessionTitle.rename(root.session, 'Launch options')
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('sample workspace missing')
    await workspace.attachSession(root.session.id)
    await page.getByRole('treeitem').filter({ hasText: 'Launch options' }).click()
    const map = page.getByRole('region', { name: 'Context Map' })
    await map.getByText('2 / 2 in context', { exact: true }).waitFor()
    await page.evaluate(() => document.fonts.ready)
    await map.getByRole('button', { name: 'Re-layout', exact: true }).click()
    await page.waitForTimeout(700)
    await map.getByRole('article', { name: `Assistant message: ${startingAnswer}`, exact: true }).click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Branch from Here' }).waitFor()
    await map.screenshot({ path: join(output, 'branch-start.png') })
    await page.keyboard.press('Escape')
    await map.getByRole('article', { name: `Assistant message: ${startingAnswer}`, exact: true }).click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Branch from Here' }).click()
    await expect.poll(() => scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === root.session.id)).toBeDefined()
    const community = scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === root.session.id)!
    const communityAnswer = 'Publish on GitHub. Let developers install it themselves and share feedback.'
    await page.locator('[role="treeitem"][aria-selected="true"]').filter({ hasText: 'Launch options (' }).waitFor()
    scaffold.ctx.sessionTitle.rename(community.session, 'Community launch')
    await page.getByRole('treeitem').filter({ hasText: 'Community launch' }).click()
    await map.getByText('2 / 2 in context', { exact: true }).waitFor()
    append(community.session, 2, 'Explore a free, community-first launch.', communityAnswer)
    await map.getByText('4 / 4 in context', { exact: true }).waitFor()
    await map.getByRole('article', { name: `Assistant message: ${startingAnswer}`, exact: true }).click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Branch from Here' }).click()
    await expect.poll(() => scaffold.ctx.agents.list().find(agent =>
      agent.session.header.parentSession === root.session.id && agent.session.id !== community.session.id,
    )).toBeDefined()
    const enterprise = scaffold.ctx.agents.list().find(agent =>
      agent.session.header.parentSession === root.session.id && agent.session.id !== community.session.id,
    )!
    const enterpriseAnswer = 'Offer paid onboarding and a sales-led pilot for enterprise teams.'
    await page.locator('[role="treeitem"][aria-selected="true"]').filter({ hasText: 'Launch options (' }).waitFor()
    scaffold.ctx.sessionTitle.rename(enterprise.session, 'Enterprise pilot')
    await page.getByRole('treeitem').filter({ hasText: 'Enterprise pilot' }).click()
    append(enterprise.session, 2, enterpriseQuestion, enterpriseAnswer)
    await map.getByText('4 / 6 in context', { exact: true }).waitFor()
    await page.getByRole('treeitem').filter({ hasText: 'Community launch' }).click()
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').innerText()).toContain('Community launch')
    await page.getByRole('treeitem').filter({ hasText: 'Enterprise pilot' }).click()
    await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').innerText()).toContain('Enterprise pilot')
    await page.reload({ waitUntil: 'load' })
    await map.getByText('4 / 6 in context', { exact: true }).waitFor()
    await map.getByRole('button', { name: 'Re-layout', exact: true }).click()
    await page.waitForTimeout(700) // Allow the native fit animation to finish before capturing.
    await page.screenshot({ path: join(output, 'branch-map.png') })
    expect(community.session.header.parentSession).toBe(root.session.id)
    expect(enterprise.session.header.parentSession).toBe(root.session.id)
    await map.getByRole('checkbox', { name: `Include ${communityAnswer} in context`, exact: true }).check()
    await map.getByRole('checkbox', { name: `Include ${enterpriseAnswer} in context`, exact: true }).uncheck()
    await map.getByText('4 / 6 in context', { exact: true }).waitFor()
    const compiled = JSON.stringify(scaffold.ctx.contextCompiler.compile({ session: enterprise.session, turn: 3, step: 1 }).messages)
    expect(compiled).toContain(communityAnswer)
    expect(compiled).not.toContain(enterpriseAnswer)
    expect(JSON.stringify(enterprise.session.snapshotEvents())).toContain(enterpriseAnswer)
    await map.screenshot({ path: join(output, 'context-control.png') })
    const before = scaffold.ctx.contextify.get(enterprise).plan
    await map.getByRole('button', { name: 'Recommend', exact: true }).click()
    const review = map.getByRole('dialog', { name: 'Context recommendation review' })
    await review.getByRole('button', { name: 'Apply proposed context' }).waitFor()
    expect(scaffold.ctx.contextify.get(enterprise).plan.revision).toBe(before.revision)
    expect(await review.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await review.screenshot({ path: join(output, 'review.png') })
    await review.getByRole('button', { name: 'Apply proposed context' }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(enterprise).plan.excluded.length).toBe(before.excluded.length + 1)
    await map.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(enterprise).plan.excluded.length).toBe(before.excluded.length)
    await map.getByRole('article', { name: `Assistant message: ${enterpriseAnswer}`, exact: true }).click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Archive node', exact: true }).click()
    const placeholder = map.getByRole('article', { name: 'Assistant empty placeholder', exact: true })
    await placeholder.waitFor()
    await placeholder.click({ button: 'right' })
    await map.screenshot({ path: join(output, 'archive.png') })
    await map.getByRole('menuitem', { name: 'Show original', exact: true }).click()
    await map.getByRole('dialog', { name: 'Original message' }).getByText(enterpriseAnswer, { exact: true }).waitFor()
    await map.getByRole('button', { name: 'Close original message' }).click()
    await placeholder.click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Restore node', exact: true }).click()
    await map.getByRole('article', { name: `Assistant message: ${enterpriseAnswer}`, exact: true }).waitFor()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Context Map prompts', exact: true }).click()
    await settings.getByRole('textbox', { name: 'Additional Context instructions', exact: true }).fill('Keep evidence and decisions. Suggest a branch when we explore a different launch strategy.')
    await settings.getByRole('button', { name: 'Save Context instructions', exact: true }).click()
    await settings.getByRole('button', { name: 'Save Context instructions', exact: true }).waitFor()
    await settings.screenshot({ path: join(output, 'prompts.png') })
    await writeFile(join(output, 'verified.json'), JSON.stringify({ nativeForks: 2, crossBranchContext: true, historyPreserved: true, reviewBeforeApply: true, undoVerified: true, archiveRestored: true, externalModelCalls: 0 }, null, 2))
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
  console.log('Gallery screenshots:', output)
}, 120000)

/** End-to-end proof that Contextify controls a real replay-backed Web Agent. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const REPLAY = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: pinned Context Map controls compiled history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: REPLAY, paceMs: 5 })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens beside Chat, forks a native child, mutates its plan, and survives reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-contextify-map'))
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })

    const map = page.getByRole('region', { name: 'Context Map' })
    await map.waitFor({ timeout: 15_000 })
    await expect.poll(() => map.getByText(/2 \/ 2 in context/).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => map.locator('.react-flow__node').count(), { timeout: 5_000 }).toBe(2)

    await map.getByRole('article', { name: 'Assistant message: LIGHTHOUSE' }).click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Branch from Here' }).click()
    await expect.poll(
      () => scaffold.ctx.agents.list().find(agent => agent.session.header.parentSession === sessionId),
      { timeout: 15_000 },
    ).toBeDefined()
    const child = scaffold.ctx.agents.list()
      .find(agent => agent.session.header.parentSession === sessionId)
    if (child === undefined) throw new Error('Context Map did not create a native child Session')
    await expect.poll(() => map.locator('.react-flow__node').count(), { timeout: 10_000 }).toBe(2)
    await expect.poll(() => page.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBe(3)

    // Archive the native parent through the shipped Workspace action. Its
    // inherited messages remain useful in the active child, but every map
    // action must now address that visible child instead of the hidden owner.
    const sessionActions = page.locator('button[aria-label^="Session actions for "]')
    await expect.poll(() => sessionActions.count(), { timeout: 5_000 }).toBe(2)
    const rootAction = sessionActions.first()
    const rootActionName = await rootAction.getAttribute('aria-label')
    if (rootActionName === null) throw new Error('Context Map root row action has no accessible name')
    const rootRow = rootAction.locator('xpath=ancestor::*[@role="treeitem"][1]')
    await rootRow.hover()
    await expect.poll(() => rootAction.isVisible(), { timeout: 5_000 }).toBe(true)
    await rootAction.click()
    await page.getByRole('menuitem', { name: 'Archive session' }).click()
    await expect.poll(
      () => scaffold.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
      { timeout: 10_000 },
    ).toBe(true)
    await expect.poll(() => page.getByLabel(rootActionName, { exact: true }).count(), { timeout: 10_000 }).toBe(0)
    await expect.poll(() => map.locator('.react-flow__node').count(), { timeout: 10_000 }).toBe(2)

    await map.getByRole('article', { name: `User message: ${PROMPT}` }).click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Locate in Chat' }).click()
    await expect.poll(() => page.locator('[data-chat-revealed]').count(), { timeout: 5_000 }).toBe(1)
    expect(await page.locator('[role="treeitem"][aria-selected="true"]').count()).toBe(1)

    await map.getByLabel(`Include ${PROMPT} in context`).click()
    await expect.poll(() => map.getByText(/1 \/ 2 in context/).count(), { timeout: 5_000 }).toBe(1)
    await expect.poll(() => scaffold.ctx.contextify.get(child).plan.excluded.length, { timeout: 5_000 }).toBe(1)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    const reloadedMap = page.getByRole('region', { name: 'Context Map' })
    await reloadedMap.waitFor({ timeout: 15_000 })
    await expect.poll(() => reloadedMap.getByText(/1 \/ 2 in context/).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => reloadedMap.locator('.react-flow__node').count(), { timeout: 10_000 }).toBe(2)
    await reloadedMap.getByRole('article', { name: `User message: ${PROMPT}` }).click({ button: 'right' })
    await reloadedMap.getByRole('menuitem', { name: 'Restore automatic' }).waitFor()
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})

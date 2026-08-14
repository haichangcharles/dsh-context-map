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

  it('opens beside chat, mutates a node, branches, and reopens after reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-contextify-map'))
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('textarea').first()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })

    const map = page.getByRole('region', { name: 'Context Map' })
    await map.waitFor({ timeout: 15_000 })
    // The replay contains the user and assistant messages plus one locked
    // runtime-context insertion. Contextify exposes all three but prevents
    // mutation of the policy-owned middle node.
    await expect.poll(() => map.getByText(/3 \/ 3 selected/).count(), { timeout: 5_000 }).toBe(1)

    await map.getByRole('button', { name: 'Branch from LIGHTHOUSE' }).click()
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('Contextify e2e lost its live Agent')
    await expect.poll(() => scaffold.ctx.contextify.get(agent).plan.paths.length, { timeout: 5_000 }).toBe(2)
    await map.getByRole('button', { name: 'New branch', exact: true }).waitFor({ timeout: 5_000 })
    await map.getByRole('button', { name: `Exclude ${PROMPT}` }).click()
    await expect.poll(() => map.getByText(/2 \/ 3 selected/).count(), { timeout: 5_000 }).toBe(1)

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('region', { name: 'Context Map' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: 'New branch', exact: true }).waitFor({ timeout: 5_000 })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})

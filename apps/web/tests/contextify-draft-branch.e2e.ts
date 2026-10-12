/** Keyless assembled-Web proof that Context Map branching carries an unsent draft. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Browser, Page } from 'playwright'
import { CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings } from '@deepseek-ai/dsh-contextify/types'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const REPLAY = fileURLToPath(new URL('../../../snapshots/web/lifecycle-chrome/session.v3.jsonl', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./snapshots/contextify-draft-branch/composer.expected.md', import.meta.url))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const DRAFT = 'Write an introduction in the new branch'
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: draft-safe Context Map branch', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: REPLAY, compareReplaySession: false, paceMs: 5 })
    const contextify = scaffold.ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
    }
    contextify.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('moves the draft into the child composer before selecting the child', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-contextify-draft-branch'))
    const settled = scaffold.whenTurnSettled()
    const input = page.locator('[data-composer-input]').first()
    await writeComposerDraft(page, input, PROMPT)
    await input.press('Enter')
    const sourceId = await settled
    await page.getByText('LIGHTHOUSE', { exact: true }).waitFor({ timeout: 15_000 })
    await writeComposerDraft(page, input, DRAFT)
    const map = page.getByRole('region', { name: 'Context Map' })
    await map.getByRole('article', { name: 'Assistant message: LIGHTHOUSE' }).click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Branch from Here' }).click()
    await expect.poll(() => scaffold.ctx.agents.list()
      .find(agent => agent.session.header.parentSession === sourceId), { timeout: 15_000 })
      .toBeDefined()
    const source = scaffold.ctx.sessions.get(sourceId)
    if (source === undefined) throw new Error('source Session disappeared after manual Branch')
    await expect.poll(() => source.snapshotEvents().filter(event => event.type === 'contextify/manual-branch')
      .map(event => event.data.objective), { timeout: 10_000 }).toEqual([DRAFT])
    await expect.poll(() => input.innerText(), { timeout: 10_000 }).toBe(DRAFT)
    const aria = await captureStableAria(page, '[data-composer-input]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(EXPECTED, aria, MODE)
  }, 60_000)
})

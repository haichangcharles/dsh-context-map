/** End-to-end proof that Contextify controls a real replay-backed Web Agent. */
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  CONTEXTIFY_DEFAULT_SETTINGS,
  CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT,
  type ContextifyPromptSettings,
} from '@deepseek-ai/dsh-contextify/types'
import {
  acknowledgeReloadConnectionLoss, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const REPLAY = fileURLToPath(new URL('./snapshots/lifecycle-chrome/session.jsonl', import.meta.url))
const COMPILED_PLACEHOLDER_EXPECTED = fileURLToPath(new URL(
  './snapshots/contextify-map/compiled-placeholder.expected.md', import.meta.url,
))
const PROMPT = 'Reply with the single word LIGHTHOUSE and stop.'
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: pinned Context Map controls compiled history', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    let recommendationCall = 0
    scaffold = await launchWebScaffold({
      replayFixture: REPLAY,
      paceMs: 5,
      contextRecommendation: (prompt) => {
        const marker = 'Conversation graph JSON:\n'
        const graph = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
          nodes: { id: string; content: string }[]
        }
        const promptNode = graph.nodes.find(node => node.content === PROMPT)
        const answerNode = graph.nodes.find(node => node.content === 'LIGHTHOUSE')
        if (promptNode === undefined || answerNode === undefined) {
          throw new Error('Context recommendation fixture could not resolve projected messages')
        }
        recommendationCall += 1
        return recommendationCall === 1
          ? {
            exclude: [{ nodeId: answerNode.id, reason: 'Exercise explicit approval' }],
            include: [],
            archive: [],
          }
          : {
            exclude: [],
            include: [],
            archive: [{
              nodeId: promptNode.id,
              category: 'obsolete',
              reason: 'Exercise one-item archive confirmation',
              evidenceNodeIds: [answerNode.id],
            }],
          }
      },
    })
    let deepCall = 0
    const contextify = scaffold.ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
      deepRecommendation: (request: { signal: AbortSignal }) => Promise<{
        exclude: readonly unknown[]
        include: readonly unknown[]
        archive: readonly unknown[]
      }>
    }
    // This replay owns recommendation calls explicitly. Disable the unrelated
    // automatic classifier and provide a deterministic Deep runner: first
    // invocation waits for cancellation, second returns an empty valid diff.
    contextify.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false })
    contextify.deepRecommendation = ({ signal }) => {
      deepCall += 1
      if (deepCall > 1) return Promise.resolve({ exclude: [], include: [], archive: [] })
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('cancelled by assembled replay')) }, { once: true })
      })
    }
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

    const beforeProposal = scaffold.ctx.contextify.get(child)
    const beforeProposalMessages = scaffold.ctx.contextCompiler.compile({
      session: child.session, turn: 2, step: 1,
    }).messages
    await map.getByRole('button', { name: 'Recommend', exact: true }).click()
    const review = map.getByRole('dialog', { name: 'Context recommendation review' })
    await review.waitFor({ timeout: 10_000 })
    await review.getByText('Fast review', { exact: true }).waitFor()
    expect(scaffold.ctx.contextify.get(child).plan.revision).toBe(beforeProposal.plan.revision)
    expect(scaffold.ctx.contextCompiler.compile({ session: child.session, turn: 2, step: 1 }).messages)
      .toEqual(beforeProposalMessages)
    await review.getByRole('button', { name: 'Apply proposed context' }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(child).plan.excluded.length, { timeout: 5_000 }).toBe(1)
    expect(scaffold.ctx.contextCompiler.compile({ session: child.session, turn: 2, step: 1 }).messages
      .flatMap(message => message.content)
      .some(block => block.type === 'text' && block.text === 'LIGHTHOUSE')).toBe(false)
    await map.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(child).plan.excluded.length, { timeout: 5_000 }).toBe(0)

    const beforeCleanup = scaffold.ctx.contextify.get(child)
    await map.getByRole('button', { name: 'Recommend', exact: true }).click()
    await review.waitFor({ timeout: 10_000 })
    expect(scaffold.ctx.contextify.get(child).plan.revision).toBe(beforeCleanup.plan.revision)
    expect(scaffold.ctx.contextCompiler.compile({ session: child.session, turn: 2, step: 1 }).messages
      .flatMap(message => message.content)
      .some(block => block.type === 'text' && block.text === PROMPT)).toBe(true)
    await review.getByRole('button', { name: 'Review archive' }).click()
    expect(scaffold.ctx.contextify.get(child).plan.replacements).toHaveLength(0)
    await review.getByRole('button', { name: 'Archive node' }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(child).plan.replacements.length, { timeout: 5_000 }).toBe(1)

    const compiledPlaceholder = scaffold.ctx.contextCompiler.compile({
      session: child.session, turn: 2, step: 1,
    }).messages.flatMap(message => message.content)
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .filter(text => text === PROMPT || text === CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT)
      .join('\n')
    await compareOrRefreshGolden(COMPILED_PLACEHOLDER_EXPECTED, compiledPlaceholder, MODE)
    const placeholderCard = map.getByRole('article', {
      name: 'User empty placeholder',
    })
    await placeholderCard.waitFor({ timeout: 10_000 })
    await placeholderCard.click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Show original' }).click()
    expect(await map.getByRole('dialog', { name: 'Original message' }).textContent()).toContain(PROMPT)
    await map.getByRole('button', { name: 'Close original message' }).click()
    await placeholderCard.click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Restore node' }).click()
    await map.getByRole('article', { name: `User message: ${PROMPT}` }).waitFor({ timeout: 10_000 })

    await map.getByRole('button', { name: 'Recommendation mode' }).click()
    await map.getByRole('menuitem', { name: 'Deep tree review' }).click()
    await map.getByRole('button', { name: 'Inspecting tree…' }).waitFor()
    await map.getByRole('button', { name: 'Cancel Deep review' }).click()
    await expect.poll(() => map.getByRole('button', { name: 'Recommend', exact: true }).count()).toBe(1)
    await map.getByRole('button', { name: 'Recommendation mode' }).click()
    await map.getByRole('menuitem', { name: 'Deep tree review' }).click()
    await review.waitFor({ timeout: 10_000 })
    await review.getByText('Deep tree review', { exact: true }).waitFor()
    await review.getByRole('button', { name: 'Close recommendation review' }).click()

    await expect.poll(() => map.getByText(/2 \/ 2 in context/).count(), { timeout: 5_000 }).toBe(1)
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
    await page.keyboard.press('Escape')

    const longOutput = `LONG OUTPUT ${'measured layout content '.repeat(34)}`
    child.session.append('turn/start', { turn: 2 })
    child.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Generate a long layout probe.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    child.session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: longOutput }],
        source: { provider: 'mock', model: 'layout-probe' },
      }),
    }, { surfaceOp: 'append' })
    child.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    child.session.append('turn/start', { turn: 3 })
    child.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Short child after long output.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    child.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    const longCard = reloadedMap.getByRole('article', { name: /Assistant message: LONG OUTPUT/ })
    const shortCard = reloadedMap.getByRole('article', { name: 'User message: Short child after long output.' })
    await longCard.waitFor({ timeout: 10_000 })
    await shortCard.waitFor({ timeout: 10_000 })
    const viewport = reloadedMap.locator('.react-flow__viewport')
    await expect.poll(async () => {
      const parent = await longCard.boundingBox()
      const next = await shortCard.boundingBox()
      if (parent === null || next === null) return -1
      const scale = await viewport.evaluate(element => new DOMMatrixReadOnly(
        getComputedStyle(element).transform,
      ).a)
      return (next.y - (parent.y + parent.height)) / scale
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(85)
    const transformBeforePolling = await viewport.getAttribute('style')
    await page.waitForTimeout(3_200)
    expect(await viewport.getAttribute('style')).toBe(transformBeforePolling)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})

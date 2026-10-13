/** Long-horizon Chat acceptance: a branch and a Context edit change real requests. */
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import {
  createAssistantMessage, createUserMessage,
  type GenerateOptions, type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title'
import {
  CONTEXTIFY_DEFAULT_SETTINGS, type ContextifyPromptSettings,
} from '@deepseek-ai/dsh-contextify/types'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, writeComposerDraft } from './support.ts'

const STALE = 'A_STALE_LIMIT: laptop budget is 1000 dollars.'
const CURRENT = 'A_CURRENT_LIMIT: laptop budget is now 700 dollars.'
const OLD_SCREEN = 'A_OLD_SCREEN: laptop display must be 17 inches.'
const CURRENT_SCREEN = 'A_CURRENT_SCREEN: laptop display is now 13 inches.'
const DETOUR = 'B_DETOUR_FACT: camera lens is 35 millimeters.'

it('keeps a returned topic active across 30 chat turns and removes a corrected constraint', async () => {
  const scaffold = await launchWebScaffold({
    contextRecommendation: (prompt) => {
      const marker = 'Conversation graph JSON:\n'
      const graph = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length)) as {
        nodes: { id: string; content: string }[]
        preferenceExamples: { content: string; mode: string }[]
      }
      if (!graph.preferenceExamples.some(example => example.content === STALE
        && example.mode === 'exclude')) {
        throw new Error('Fast review did not receive the earlier confirmed Context choice')
      }
      const old = graph.nodes.find(node => node.content === OLD_SCREEN)
      const current = graph.nodes.find(node => node.content === CURRENT_SCREEN)
      if (old === undefined || current === undefined) {
        throw new Error(`Fast review did not route both distant screen constraints: ${JSON.stringify(graph.nodes.filter(node => node.content.includes('SCREEN')).map(node => node.content))}`)
      }
      return { exclude: [
        { nodeId: old.id, reason: 'The user replaced this screen constraint.' },
        { nodeId: current.id, reason: 'Possibly unnecessary screen constraint.' },
      ],
      include: [], archive: [] }
    },
  })
  let browser: Browser | undefined
  try {
    const requests: Array<{ sessionId: string | undefined; body: string }> = []
    const contextify = scaffold.ctx.contextify as unknown as {
      promptSettings: () => ContextifyPromptSettings
    }
    contextify.promptSettings = () => ({ ...CONTEXTIFY_DEFAULT_SETTINGS, automaticBranchReview: false })
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const root = (await scaffold.ctx.agents.create({
      sessionId: SessionId('long-chat-context-root'), meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })).agent
    const append = (turn: number, user: string, answer: string): void => {
      root.session.append('turn/start', { turn })
      root.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: user }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      root.session.append('assistant/message', { stream: [], turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: answer }],
          source: { provider: 'prepared-sample', model: 'long-chat' },
        }),
      }, { surfaceOp: 'append' })
      root.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    // Fifteen turns establish laptop topic A; a fifteen-turn camera detour follows in
    // the original linear Session. The browser will fork at the old A boundary.
    for (let turn = 1; turn <= 15; turn += 1) {
      append(turn, turn === 1 ? STALE : turn === 3 ? OLD_SCREEN
        : turn === 8 ? CURRENT : turn === 9 ? CURRENT_SCREEN
          : `A_LAPTOP_TOPIC turn ${turn}: compare battery and portability.`,
      turn === 15 ? 'A_LAPTOP_BOUNDARY: prefer the compact model.'
        : `A laptop answer ${turn}.`)
    }
    for (let turn = 16; turn <= 30; turn += 1) {
      append(turn, turn === 16 ? DETOUR
        : `B_CAMERA_TOPIC turn ${turn}: compare lenses and sensors.`,
      `B camera answer ${turn}.`)
    }
    scaffold.ctx.sessionTitle.rename(root.session, 'Laptop and camera history')
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, locale: 'en-US' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('prepared workspace missing')
    await workspace.attachSession(root.session.id)
    await page.getByRole('treeitem').filter({ hasText: 'Laptop and camera history' }).click()
    const map = page.getByRole('region', { name: 'Context Map' })
    await map.getByText('60 / 60 in context', { exact: true }).waitFor({ timeout: 15_000 })
    await map.getByRole('textbox', { name: 'Search Context Map' }).fill('A_LAPTOP_BOUNDARY')
    const pivot = map.getByRole('article', {
      name: 'Assistant message: A_LAPTOP_BOUNDARY: prefer the compact model.',
    })
    await expect.poll(() => pivot.getAttribute('data-focused'), { timeout: 5_000 }).toBe('true')
    await pivot.click({ button: 'right' })
    await map.getByRole('menuitem', { name: 'Branch from Here' }).click()
    await expect.poll(() => scaffold.ctx.agents.list().find(agent =>
      agent.session.header.parentSession === root.session.id), { timeout: 15_000 }).toBeDefined()
    const active = scaffold.ctx.agents.list().find(agent =>
      agent.session.header.parentSession === root.session.id)
    if (active === undefined) throw new Error('Chat did not activate the returned-topic branch')
    scaffold.ctx.on('llm/stream', (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
      if (options.sessionId !== active.session.id) return next()
      const body = JSON.stringify(options.messages)
      requests.push({ sessionId: options.sessionId, body })
      return (async function* (): AsyncIterable<StreamChunk> {
        const answer = 'A_ACTIVE_OK'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: answer }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    })
    expect(active.session.snapshotEvents().some(event => JSON.stringify(event).includes(DETOUR))).toBe(false)
    await expect.poll(() => map.getByText('30 / 60 in context', { exact: true }).count(),
      { timeout: 15_000 }).toBe(1)

    const send = async (prompt: string): Promise<void> => {
      const settled = scaffold.whenTurnSettled(30_000)
      const composer = page.locator('[data-composer-input]').first()
      await writeComposerDraft(page, composer, prompt)
      await composer.press('Enter')
      expect(await settled).toBe(active.session.id)
    }
    await send('Return to laptop A. Which compact model and budget are active?')
    const first = requests.findLast(request => request.sessionId === active.session.id)?.body
    if (first === undefined) throw new Error(`missing active request: active=${String(active.session.id)}, seen=${JSON.stringify(requests.map(request => request.sessionId))}`)
    expect(first).toContain(CURRENT)
    expect(first).toContain(STALE)
    expect(first).not.toContain(DETOUR)
    expect(first).not.toContain('B_CAMERA_TOPIC')

    await map.getByRole('textbox', { name: 'Search Context Map' }).fill(STALE)
    const staleNode = map.getByRole('article', { name: `User message: ${STALE}`, exact: true })
    await expect.poll(() => staleNode.getAttribute('data-focused'), { timeout: 5_000 }).toBe('true')
    await staleNode.getByRole('checkbox', { name: `Include ${STALE} in context`, exact: true }).uncheck()
    await expect.poll(() => scaffold.ctx.contextify.get(active).plan.excluded.length,
      { timeout: 10_000 }).toBe(1)
    await send('Use the corrected laptop budget and screen size; ignore old values.')
    const second = requests.findLast(request => request.sessionId === active.session.id)?.body
    if (second === undefined) throw new Error(`missing corrected request: active=${String(active.session.id)}, seen=${JSON.stringify(requests.map(request => request.sessionId))}`)
    expect(second).toContain(CURRENT)
    expect(second).not.toContain(STALE)
    expect(second).not.toContain(DETOUR)
    expect(second).toContain(OLD_SCREEN)
    await map.getByText('33 / 64 in context', { exact: true }).waitFor({ timeout: 10_000 })
    await map.getByRole('button', { name: 'Recommend', exact: true }).click()
    const review = map.getByRole('dialog', { name: 'Context recommendation review' })
    try { await review.waitFor({ timeout: 10_000 }) } catch (cause) {
      const alerts = await map.getByRole('alert').allTextContents()
      throw new Error(`Long-chat review did not open: ${JSON.stringify(alerts)}`, { cause })
    }
    await review.getByText('The user replaced this screen constraint.').waitFor()
    await expect.poll(() => active.session.snapshotEvents()
      .filter(event => event.type === 'contextify/recommendation-presented').length,
    { timeout: 10_000 }).toBe(1)
    await review.getByRole('button', { name: 'Close recommendation review' }).click()
    await expect.poll(() => active.session.snapshotEvents()
      .filter(event => event.type === 'contextify/recommendation-dismissed').length,
    { timeout: 10_000 }).toBe(1)
    expect(scaffold.ctx.contextify.get(active).plan.excluded).toHaveLength(1)
    await map.getByRole('button', { name: 'Recommend', exact: true }).click()
    await review.waitFor({ timeout: 10_000 })
    await expect.poll(() => active.session.snapshotEvents()
      .filter(event => event.type === 'contextify/recommendation-presented').length,
    { timeout: 10_000 }).toBe(2)
    await review.getByRole('button', { name: 'Keep current context for ' + CURRENT_SCREEN }).click()
    await review.getByRole('button', { name: 'Apply selected changes' }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(active).plan.excluded.length,
      { timeout: 10_000 }).toBe(2)
    const family = await scaffold.ctx.contextify.familyPage(active, undefined, 100)
    const oldNodeId = family.records.find(node => node.preview === OLD_SCREEN)?.id
    const currentNodeId = family.records.find(node => node.preview === CURRENT_SCREEN)?.id
    expect(oldNodeId).toBeDefined()
    expect(currentNodeId).toBeDefined()
    const reviewed = active.session.snapshotEvents().findLast(event =>
      event.type === 'contextify/recommendation-reviewed')
    expect(reviewed?.data).toMatchObject({
      acceptedNodeIds: [oldNodeId],
      declinedNodeIds: [currentNodeId],
    })
    await send('Now answer with both corrected laptop constraints.')
    const third = requests.findLast(request => request.sessionId === active.session.id)?.body
    if (third === undefined) throw new Error('missing request after reviewed Context recommendation')
    expect(third).toContain(CURRENT)
    expect(third).toContain(CURRENT_SCREEN)
    expect(third).not.toContain(STALE)
    expect(third).not.toContain(OLD_SCREEN)
    expect(third).not.toContain(DETOUR)
    expect(active.session.snapshotEvents()
      .filter(event => event.type === 'contextify/node-choice')
      .map(event => ({ origin: event.data.origin, uiOrigin: event.data.uiOrigin })))
      .toEqual([
        { origin: 'direct', uiOrigin: 'contextify-client' },
        { origin: 'recommendation', uiOrigin: 'contextify-client' },
      ])
    expect(root.session.snapshotEvents().some(event => JSON.stringify(event).includes(STALE))).toBe(true)

    // An explicit Keep survives sheet closure, without labeling unchosen items
    // or changing either the native Context Plan or the unsent draft.
    await map.getByText('34 / 66 in context', { exact: true }).waitFor({ timeout: 10_000 })
    const draft = 'Write the laptop comparison with the corrected screen size.'
    const composer = page.locator('[data-composer-input]').first()
    const planRevision = scaffold.ctx.contextify.get(active).plan.revision
    const support = (await scaffold.ctx.contextify.stewardProfile(active)).release.support
    await writeComposerDraft(page, composer, draft)
    await page.getByRole('button', { name: 'Review context for draft', exact: true }).click()
    try { await review.waitFor({ timeout: 10_000 }) } catch (cause) {
      const alerts = await page.getByRole('alert').allTextContents()
      throw new Error(`Draft Keep review did not open: ${JSON.stringify(alerts)}`, { cause })
    }
    await review.getByRole('button', { name: 'Keep current context for ' + CURRENT_SCREEN }).click()
    await review.getByRole('button', { name: 'Close recommendation review' }).click()
    await expect.poll(() => active.session.snapshotEvents().findLast(event =>
      event.type === 'contextify/recommendation-dismissed')?.data,
    { timeout: 10_000 }).toMatchObject({ objective: draft, declinedNodeIds: [currentNodeId] })
    expect(scaffold.ctx.contextify.get(active).plan.revision).toBe(planRevision)
    expect((await scaffold.ctx.contextify.stewardProfile(active)).release.support).toBe(support + 1)
    expect(await composer.innerText()).toBe(draft)

    await page.getByRole('button', { name: 'Review context for draft', exact: true }).click()
    await review.waitFor({ timeout: 10_000 })
    await review.getByText('The proposed context matches the current version.', { exact: true }).waitFor()
    expect(await review.getByRole('button', { name: 'Keep current context for ' + CURRENT_SCREEN }).count())
      .toBe(0)
    await review.getByRole('button', { name: 'Close recommendation review' }).click()
    await send(draft)
    const afterDismissal = requests.findLast(request => request.sessionId === active.session.id)?.body
    expect(afterDismissal).toContain(CURRENT_SCREEN)
    expect(afterDismissal).not.toContain(OLD_SCREEN)
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120_000)

/**
 * Opt-in capture: build the app, then run
 * pnpm exec vitest run --config product-site/capture.config.ts
 *
 * Uses a hermetic sample Session, the real Web UI and the real context compiler.
 * No model calls. Writes footage, three screenshots, trim offset and verification
 * metadata under a unique temporary directory printed at completion. Trim only
 * the setup interval before
 * publishing; keep the sample disclosure and the three narrative chapters.
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
import type {} from '@deepseek-ai/dsh-contextify'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'
it('captures a real context change without deleting history', async () => {
  const output = await mkdtemp(join(tmpdir(), 'dsh-walkthrough-'))
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, locale: 'en-US', colorScheme: 'dark', recordVideo: { dir: output, size: { width: 1440, height: 940 } } })
    const page = await context.newPage()
    const videoStart = Date.now()
    const cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    const handle = await scaffold.ctx.agents.create({ sessionId: SessionId('launch-plan-demo'), meta: { cwd }, agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } })
    const pairs = [
      ['Help me launch Context Map. Keep the demo short and easy to understand.', 'Show one useful workflow: choose what the model sees next.'],
      ['Make it enterprise-only. Require a sales call and a paid subscription.', 'The launch page will say: Book a demo. Contact sales for pricing.'],
      ['Change of plan: launch it free and open source. No sales calls, no subscription.', 'The new direction is a public GitHub launch with a self-serve install.'],
    ]
    pairs.forEach(([user, answer], index) => {
      const turn = index + 1
      handle.agent.session.append('turn/start', { turn })
      handle.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: user! }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      handle.agent.session.append('assistant/message', {
        stream: [], turn, step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: answer! }],
          source: { provider: 'prepared-sample', model: 'scripted-demo' },
        }),
      }, { surfaceOp: 'append' })
      handle.agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('sample workspace was not registered')
    await workspace.attachSession(handle.agent.session.id)
    await page.getByRole('treeitem').filter({ hasText: 'Help me launch Context Map' }).click()
    const map = page.getByRole('region', { name: 'Context Map' })
    if (!await map.isVisible())
      await page.getByRole('button', { name: 'Context Map', exact: true }).click()
    await map.getByText('6 / 6 in context', { exact: true }).waitFor({ timeout: 15000 })
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
    await page.waitForTimeout(2000)
    await writeFile(join(output, 'aria.txt'), await page.locator('body').ariaSnapshot())
    await page.screenshot({ path: join(output, 'before.png') })
    const start = Date.now()
    await writeFile(join(output, 'trim-offset.txt'), String((start - videoStart) / 1000))
    // These holds pace the footage for a viewer; readiness uses UI assertions.
    await page.waitForTimeout(4000)
    await map.getByRole('button', { name: 'Zoom In', exact: true }).click({ clickCount: 2, delay: 300 })
    await page.waitForTimeout(2000)
    await map.getByRole('checkbox', { name: `Include ${pairs[1]![0]} in context`, exact: true }).uncheck()
    await page.waitForTimeout(1200)
    await map.getByRole('checkbox', { name: `Include ${pairs[1]![1]} in context`, exact: true }).uncheck()
    await map.getByText('4 / 6 in context', { exact: true }).waitFor()
    await page.waitForTimeout(2500)
    await page.screenshot({ path: join(output, 'after.png') })
    const compiled = JSON.stringify(scaffold.ctx.contextCompiler.compile({ session: handle.agent.session, turn: 4, step: 1 }).messages)
    expect(compiled).not.toContain(pairs[1]![0])
    expect(compiled).not.toContain(pairs[1]![1])
    expect(compiled).toContain(pairs[2]![0])
    const history = JSON.stringify(handle.agent.session.snapshotEvents())
    expect(history).toContain(pairs[1]![0])
    expect(history).toContain(pairs[1]![1])
    await map.getByRole('article', { name: `User message: ${pairs[1]![0]}`, exact: true }).click({ button: 'right' })
    await page.waitForTimeout(1000)
    await map.getByRole('menuitem', { name: 'Locate in Chat' }).click()
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(output, 'history.png') })
    await page.waitForTimeout(4500)
    await map.getByRole('button', { name: 'Fit View', exact: true }).click()
    await page.waitForTimeout(2000)
    await context.close()
    console.log('Walkthrough artifacts:', output)
    await writeFile(join(output, 'verified.json'), JSON.stringify({ excludedMessages: 2, retainedMessages: 4, totalMessages: 6, compiledContextVerified: true, originalHistoryVerified: true, modelCalls: 0 }, null, 2))
  }
  finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120000)

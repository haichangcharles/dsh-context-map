/** Long-horizon graph mutations retain measured nodes and searchable off-branch sources. */
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

it('keeps a borrowed source visible and focusable after long-horizon plan edits', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const { agent } = await scaffold.ctx.agents.create({
      sessionId: SessionId('graph-refresh-root'), meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    let turn = 0
    const append = (session: Session, prompt: string, response: string) => {
      const current = ++turn
      session.append('turn/start', { turn: current })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      session.append('assistant/message', { stream: [], turn: current, step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: response }],
          source: { provider: 'prepared-sample', model: 'keyless' } }),
      }, { surfaceOp: 'append' })
      return session.append('turn/end', { turn: current, reason: { kind: 'completed' } })
    }
    for (let index = 0; index < 12; index++) append(agent.session,
      `Plan the community website: phase ${index}.`, `Shared launch constraint ${index}.`)
    const boundary = agent.session.snapshotEvents().at(-1)
    if (boundary === undefined) throw new Error('prepared history missing')
    const branches: Session[] = []
    for (const [topic, count] of [['Research', 8], ['Writing', 6], ['Brainstorming', 4]] as const) {
      const fork = await scaffold.ctx.sessionController.fork({ sessionId: agent.id, atSeq: boundary.seq })
      const child = scaffold.ctx.sessions.get(fork.sessionId)
      if (child === undefined) throw new Error('native fork missing')
      for (let index = 0; index < count; index++) append(child,
        `${topic} task ${index}.`, `${topic} result ${index}.`)
      branches.push(child)
    }
    scaffold.ctx.sessionTitle.rename(agent.session, 'Long-horizon graph refresh')
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('prepared workspace missing')
    await workspace.attachSession(agent.id)
    await page.getByRole('treeitem').filter({ hasText: 'Long-horizon graph refresh' }).click()
    const map = page.getByRole('region', { name: 'Context Map', exact: true })
    await map.getByText('24 / 60 in context', { exact: true }).waitFor()
    // Verify actual browser colors, including the inherited vendor controls,
    // under both system themes rather than merely checking source declarations.
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect.poll(async () => await page.locator('body').getAttribute('data-ds-dark-theme') !== null).toBe(scheme === 'dark')
      const colors = await map.getByRole('button', { name: 'Zoom In', exact: true }).evaluate((element) => {
        const style = getComputedStyle(element)
        const icon = element.querySelector('svg')
        return {
          background: style.backgroundColor,
          foreground: style.color,
          icon: icon === null ? null : getComputedStyle(icon).fill,
          controlBackground: style.getPropertyValue('--xy-controls-button-background-color').trim(),
          surface: style.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
          controlForeground: style.getPropertyValue('--xy-controls-button-color').trim(),
          label: style.getPropertyValue('--dsw-alias-label-primary').trim(),
        }
      })
      expect(colors.surface).not.toBe('')
      expect(colors.label).not.toBe('')
      expect(colors.controlBackground).toBe(colors.surface)
      expect(colors.controlForeground).toBe(colors.label)
      expect(colors.icon).toBe(colors.foreground)
      const luminance = (color: string): number => {
        const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
        if (channels?.length !== 3) throw new Error(`Unexpected browser color: ${color}`)
        return channels.map(value => value / 255).map(value => value <= 0.04045
          ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
          .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
      }
      const bright = luminance(colors.foreground)
      const dark = luminance(colors.background)
      expect((Math.max(bright, dark) + 0.05) / (Math.min(bright, dark) + 0.05)).toBeGreaterThanOrEqual(3)
    }
    const search = map.getByRole('textbox', { name: 'Search Context Map', exact: true })
    await search.fill('Shared launch constraint 0.')
    await search.press('Enter')
    const oldConstraint = map.getByRole('checkbox', { name: 'Include Shared launch constraint 0. in context', exact: true })
    await oldConstraint.waitFor()
    await oldConstraint.click()
    await map.getByText('23 / 60 in context', { exact: true }).waitFor()
    await map.getByRole('button', { name: 'Undo', exact: true }).click()
    await map.getByText('24 / 60 in context', { exact: true }).waitFor()
    await map.getByRole('button', { name: 'Redo', exact: true }).click()
    await map.getByText('23 / 60 in context', { exact: true }).waitFor()
    await search.fill('Research result 7.')
    await search.press('Enter')
    const source = map.getByRole('article', { name: 'Assistant message: Research result 7.', exact: true })
    await source.waitFor({ timeout: 10_000 })
    await expect.poll(async () => source.evaluate((element) => {
      const canvas = element.closest('[data-context-map-canvas]')
      if (canvas === null) return false
      const box = element.getBoundingClientRect()
      const outer = canvas.getBoundingClientRect()
      return box.width > 100 && box.height > 40 && box.left >= outer.left && box.right <= outer.right
        && box.top >= outer.top && box.bottom <= outer.bottom
    }), { timeout: 10_000 }).toBe(true)
    await source.getByRole('checkbox', { name: 'Include Research result 7. in context', exact: true }).click()
    await map.getByText('24 / 60 in context', { exact: true }).waitFor()
    const research = branches[0]
    if (research === undefined) throw new Error('research branch missing')
    const resultNode = (await scaffold.ctx.contextify.familyPage(agent)).records
      .find(node => node.preview === 'Research result 7.')
    if (resultNode === undefined) throw new Error('research result missing')
    expect(resultNode.owner.sessionId).toBe(research.id)
    expect(scaffold.ctx.contextify.get(agent).plan.included.some(item => item.nodeId === resultNode.id)).toBe(true)
    const compiled = JSON.stringify(scaffold.ctx.contextCompiler.compile({ session: agent.session, turn: 31, step: 1 }).messages)
    expect(compiled).toContain('Research result 7.')
    expect(compiled).not.toContain('Shared launch constraint 0.')
    await source.waitFor()
    await expect.poll(() => source.locator('..').getAttribute('style')).not.toContain('visibility: hidden')
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120_000)

/** A reviewed branch lifecycle choice reaches the native Session graph through the browser. */
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

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
    const child = scaffold.ctx.sessions.fork(agent.session, SessionSeq(boundary.seq),
      SessionId('work-state-announcement'))
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
    const childRow = map.locator('[data-work-session-id="work-state-announcement"]')
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
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120_000)

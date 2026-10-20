/** An exact Web correction travels from unsent draft through review into the next DSH request. */
import type { Browser } from 'playwright'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { ToolCallId, createAssistantMessage, createToolResultMessage,
  createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-title'
import { launchWebScaffold } from './scaffold.ts'
import { connectFreshWorkspace } from './support.ts'

it('reviews an exact source correction in the composer before changing the next request', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const { agent } = await scaffold.ctx.agents.create({
      sessionId: SessionId('explicit-web-correction-ui'), meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    const callId = ToolCallId('explicit-web-correction-call')
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Compare these supplier reports.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const call = agent.session.append('tool/call', { turn: 1, step: 1, callId,
      name: 'web_fetch', arguments: '{"url":"https://research.test/obsolete"}' })
    const source = agent.session.append('tool/result', { turn: 1, step: 1,
      message: createToolResultMessage({ callId,
        content: [{ type: 'text', text: 'OBSOLETE-SUPPLIER-REPORT' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
    agent.session.append('assistant/message', { stream: [], turn: 1, step: 2,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'I found the first report.' }],
        source: { provider: 'prepared-sample', model: 'browser-check' },
      }),
    }, { surfaceOp: 'append' })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    scaffold.ctx.sessionTitle.rename(agent.session, 'Explicit Web correction')

    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('sample workspace missing')
    await workspace.attachSession(agent.id)
    await page.getByRole('treeitem').filter({ hasText: 'Explicit Web correction' }).click()
    const draft = 'Ignore https://research.test/obsolete. Continue with the current comparison.'
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(draft)
    const before = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    expect(before).toContain('OBSOLETE-SUPPLIER-REPORT')
    await page.getByRole('button', { name: 'Review context for draft' }).click()
    const map = page.getByRole('region', { name: 'Context Map' })
    await map.getByText('You asked to exclude this exact Web source from the next request.')
      .waitFor()
    expect(scaffold.ctx.contextify.get(agent).plan.excluded).toHaveLength(0)
    await map.getByRole('button', { name: 'Apply proposed context' }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(agent).plan.excluded.map(item => item.eventSeq))
      .toContain(source.seq)
    expect(await composer.textContent()).toBe(draft)
    const after = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    expect(after).not.toContain('OBSOLETE-SUPPLIER-REPORT')
    expect(after).not.toContain('https://research.test/obsolete')
    expect(agent.session.snapshotEvents().some(event => event.type === 'contextify/recommendation-reviewed'
      && event.data.uiOrigin === 'contextify-client')).toBe(true)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'contextify/recommendation-reviewed')
      .every(event => event.data.scopePolicy === undefined)).toBe(true)
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120_000)

it('reviews an exact off-path Web source for Include before the next request', async () => {
  const scaffold = await launchWebScaffold()
  let browser: Browser | undefined
  try {
    const cwd = `${scaffold.workspaceCwd}/workspace`
    const { agent } = await scaffold.ctx.agents.create({
      sessionId: SessionId('explicit-web-include-ui'), meta: { cwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Compare supplier reports.' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('assistant/message', { stream: [], turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'We can compare sources.' }],
        source: { provider: 'prepared-sample', model: 'browser-check' },
      }),
    }, { surfaceOp: 'append' })
    const boundary = agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const sibling = scaffold.ctx.sessions.fork(agent.session, SessionSeq(boundary.seq),
      SessionId('explicit-web-include-sibling'))
    const callId = ToolCallId('explicit-web-include-call')
    sibling.append('turn/start', { turn: 2 })
    const call = sibling.append('tool/call', { turn: 2, step: 1, callId,
      name: 'web_fetch', arguments: '{"url":"https://research.test/previous"}' })
    const source = sibling.append('tool/result', { turn: 2, step: 1,
      message: createToolResultMessage({ callId,
        content: [{ type: 'text', text: 'PREVIOUS-SUPPLIER-SOURCE' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(call.seq)] })
    sibling.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    scaffold.ctx.sessionTitle.rename(agent.session, 'Explicit Web include')

    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const workspace = await scaffold.ctx.workspaceRegistry.resolveByPath(cwd)
    if (workspace === undefined) throw new Error('sample workspace missing')
    await workspace.attachSession(agent.id)
    await page.getByRole('treeitem').filter({ hasText: 'Explicit Web include' }).click()
    const draft = 'Use https://research.test/previous for this answer.'
    const composer = page.locator('[data-composer-input][contenteditable="true"]').last()
    await composer.fill(draft)
    const before = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    expect(before).not.toContain('PREVIOUS-SUPPLIER-SOURCE')
    await page.getByRole('button', { name: 'Review context for draft' }).click()
    const map = page.getByRole('region', { name: 'Context Map' })
    await map.getByText('You asked to include this exact Web source in the next request.')
      .waitFor()
    expect(scaffold.ctx.contextify.get(agent).plan.included).toHaveLength(0)
    await map.getByRole('button', { name: 'Apply proposed context' }).click()
    await expect.poll(() => scaffold.ctx.contextify.get(agent).plan.included.map(item => item.nodeId))
      .toContain(`${sibling.id}:${String(source.seq)}`)
    expect(await composer.textContent()).toBe(draft)
    const after = JSON.stringify(scaffold.ctx.contextCompiler.compile({
      session: agent.session, turn: 2, step: 1,
    }).messages)
    expect(after).toContain('PREVIOUS-SUPPLIER-SOURCE')
    expect(after).toContain('https://research.test/previous')
  } finally {
    try { await browser?.close() } finally { await scaffold.close() }
  }
}, 120_000)

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import type { TerminalSendOperation } from '@deepseek-ai/dsh-terminal'
import type { SubprocessTerminalForeground } from '@deepseek-ai/dsh-subprocess'
import { LocalPtySession } from '@deepseek-ai/dsh-terminal-bash/src/session.ts'
import { TerminalSanitizer, CONTROLLED_PROMPT } from '@deepseek-ai/dsh-terminal-bash/src/sanitize.ts'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local/src/resolve.ts'
import * as ptyLocal from '@deepseek-ai/dsh-terminal-bash'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

class PassthroughSandbox extends SandboxProvider {
  calls: { argv: readonly string[]; policy: SandboxPolicy }[] = []

  confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    this.calls.push({ argv, policy })
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id)
  const agent: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

async function harness(
  mode: 'danger-full-access' | 'workspace-write',
  timing: { idleSilenceMs?: number; handoffGraceMs?: number; timeoutMs?: number } = {},
  dialect: 'bash' | 'pwsh' = 'bash',
) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pty-local-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  await ctx.plugin(PassthroughSandbox)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
  await ctx.plugin(LocalSubprocessRuntime)
  const fiber = await ctx.plugin(ptyLocal, {
    shellDialect: dialect,
    pollIntervalMs: 10,
    exactProbeAfterMs: 20,
    idleSilenceMs: timing.idleSilenceMs ?? 250,
    handoffGraceMs: timing.handoffGraceMs ?? 250,
    timeoutMs: timing.timeoutMs ?? 2_000,
    disposeGraceMs: 500,
    scrollbackLines: 100,
    scrollbackMaxBytes: 32_768,
    maxReadBytes: 16_384,
  })
  const agent = stubAgent(ctx, `agent-${mode}`)
  ctx.agents.register(agent)
  return { ctx, root, agent, fiber, sandbox: ctx.sandbox as PassthroughSandbox }
}

// TerminalSendOperation.append drops output once the operation settles, so this only
// observes a marker the child prints while `operation` is still active. A caller
// whose child is slow to print must raise the harness `timing` bounds too;
// extending this deadline alone cannot recover output the operation never collected.
async function waitForOutput(operation: TerminalSendOperation, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let output = ''
  while (!output.includes(expected) && Date.now() < deadline) {
    output += operation.readOutput().delta
    if (!output.includes(expected)) await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(output).toContain(expected)
}

// A send the test interrupts settles when bash returns to its prompt, so the
// kernel may publish the foreground handoff on either side of the silence
// bound. `handoffGraceMs` widens the window that wins the exact attribution but
// cannot remove the race on a loaded host, so these settles assert that the
// session became usable again, not which readiness tier observed it.
function expectReadyForNextSend(waitReason: string): void {
  expect(['stdin_read', 'inferred_idle']).toContain(waitReason)
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (_missingProcess) {
    return false
  }
  if (process.platform !== 'linux') return true
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/, 1)[0]
    return !/^[ZXx]$/.test(state ?? '')
  } catch (_unreadableProcEntry) {
    return false
  }
}

function canReadLinuxProcessSyscall(pid: number): boolean {
  try {
    readFileSync(`/proc/${pid}/task/${pid}/syscall`, 'utf8')
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return false
    throw error
  }
}

// The real-shell suite drives a POSIX bash over the actual node-pty terminal;
// Windows has no bash, and its pwsh counterpart lives in the describe below.
describe.skipIf(process.platform === 'win32')('terminal-bash real shell', () => {
  it('persists cwd and environment across sends, scrubs secrets, and closes', async () => {
    const previous = process.env.DSH_TEST_SECRET
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    try {
      const { ctx, root, agent } = await harness('danger-full-access')
      const created = await ctx.terminals.spawn(agent, { type: 'shell', name: 'main', cwd: root })
      expect(created.motd).toContain('dsh> ')

      const first = ctx.terminals.startSend(agent, created.sessionId, { text: 'export KEEP=ok; cd /', submit: true })
      expect((await first.done).waitReason).toBe('stdin_read')
      const second = ctx.terminals.startSend(agent, created.sessionId, { text: 'printf "cwd=%s keep=%s secret=%s\\n" "$PWD" "$KEEP" "${DSH_TEST_SECRET-unset}"', submit: true })
      expect((await second.done).viewport).toContain('cwd=/ keep=ok secret=unset')

      expect(ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 20 }).text).toContain('cwd=/ keep=ok secret=unset')
      expect(await ctx.terminals.kill(agent, created.sessionId)).toBe(true)
      expect(ctx.terminals.list(agent)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_TEST_SECRET
      else process.env.DSH_TEST_SECRET = previous
    }
  }, 10_000)

  it('restores the controlled prompt after an in-shell PS1 override', async () => {
    // The silence tier is pushed beyond every assertion below, so each settle
    // proves prompt-based readiness survives the override rather than the
    // inferred_idle fallback absorbing a broken prompt.
    const { ctx, agent } = await harness('danger-full-access', {
      idleSilenceMs: 5_000,
      timeoutMs: 8_000,
    })
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })

    const override = ctx.terminals.startSend(agent, created.sessionId, { text: 'PS1=broken-prompt', submit: true })
    expect((await override.done).waitReason).toBe('stdin_read')

    const after = ctx.terminals.startSend(agent, created.sessionId, { text: 'printf "healed=[%s]\\n" "$PS1"', submit: true })
    const result = await after.done
    expect(result.waitReason).toBe('stdin_read')
    expect(result.viewport).toContain('healed=[dsh> ]')
    await ctx.terminals.kill(agent, created.sessionId)
  }, 20_000)

  it.skipIf(process.platform !== 'linux')('recognizes a foreground read opened through /dev/tty', async () => {
    const { ctx, root, agent } = await harness('danger-full-access', {
      idleSilenceMs: 5_000,
      timeoutMs: 8_000,
    })
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    const readerPidFile = join(root, 'tty-reader.pid')

    const waiting = ctx.terminals.startSend(agent, created.sessionId, {
      text: `bash -c 'exec </dev/tty; printf "%s" "$BASHPID" > "$1"; printf "WAITING\\n"; read -r answer; printf "ANSWER=%s\\n" "$answer"' dsh "${readerPidFile}"`,
      submit: true,
    })
    await waitForOutput(waiting, 'WAITING')
    const result = await waiting.done
    const readerPid = Number(readFileSync(readerPidFile, 'utf8'))
    expect(readerPid).toBeGreaterThan(0)
    expect(result.waitReason).toBe(canReadLinuxProcessSyscall(readerPid) ? 'stdin_read' : 'inferred_idle')

    const answer = ctx.terminals.startSend(agent, created.sessionId, { text: 'accepted', submit: true })
    const answered = await answer.done
    expect(answered.waitReason).toBe('stdin_read')
    expect(answered.viewport).toContain('ANSWER=accepted')
    await ctx.terminals.kill(agent, created.sessionId)
  }, 20_000)

  it('wraps the exact shell argv under confined policy and unregisters on reload', async () => {
    const { ctx, root, agent, fiber, sandbox } = await harness('workspace-write')
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    expect(sandbox.calls).toEqual([{
      argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
      policy: { mode: 'workspace-write', workspaceRoot: realpathSync.native(root), sessionId: 'agent-workspace-write' },
    }])
    await fiber.dispose()
    expect(ctx.terminals.listBackends()).toEqual([])
    expect(ctx.terminals.list(agent)).toHaveLength(1)
    await ctx.terminals.kill(agent, created.sessionId)
  }, 10_000)

  it('signals a foreground command and kills a TERM-ignoring background descendant', async () => {
    const { ctx, agent } = await harness('danger-full-access')
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })

    const foreground = ctx.terminals.startSend(agent, created.sessionId, { text: 'sleep 60', submit: true })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await ctx.terminals.signal(agent, created.sessionId, 'SIGINT')).delivered).toBe(true)
    expectReadyForNextSend((await foreground.done).waitReason)

    const background = ctx.terminals.startSend(agent, created.sessionId, {
      text: 'sh -c \'trap "" TERM; sleep 60\' & echo CHILD=$!',
      submit: true,
    })
    const output = (await background.done).viewport
    const child = /CHILD=(\d+)/.exec(output)?.[1]
    expect(child).toBeDefined()
    const pid = Number(child)
    expect(() => process.kill(pid, 0)).not.toThrow()
    await ctx.terminals.kill(agent, created.sessionId)
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  it('quiesces a disowned same-session descendant after the shell exits naturally', async () => {
    const { ctx, root, agent } = await harness('danger-full-access')
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    const pidFile = join(root, 'disowned.pid')
    let pid: number | undefined
    try {
      const background = ctx.terminals.startSend(agent, created.sessionId, {
        text: `sh -c 'trap "" TERM; printf "%s" "$$" > "$1"; sleep 60' dsh "${pidFile}" & disown`,
        submit: true,
      })
      await background.done
      const pidDeadline = Date.now() + 2_000
      let childPid = 0
      while (childPid === 0 && Date.now() < pidDeadline) {
        if (existsSync(pidFile)) childPid = Number(readFileSync(pidFile, 'utf8'))
        if (childPid > 0) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(existsSync(pidFile), ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 100 }).text).toBe(true)
      expect(childPid).toBeGreaterThan(0)
      pid = childPid
      expect(() => process.kill(childPid, 0)).not.toThrow()
      await ctx.terminals.startSend(agent, created.sessionId, { text: 'exit', submit: true }).done
      const deadline = Date.now() + 2_000
      while (ctx.terminals.list(agent)[0]?.status.kind !== 'exited' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(ctx.terminals.list(agent)[0]?.status.kind).toBe('exited')
      await ctx.terminals.kill(agent, created.sessionId)
      expect(processIsRunning(childPid)).toBe(false)
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (_alreadyReaped) {
          // Product cleanup is the expected path; this only contains a failed regression.
        }
      }
    }
  }, 10_000)

  it('cancels a slow-starting raw-mode foreground process with a real SIGINT', async () => {
    const { ctx, agent } = await harness('danger-full-access', {
      idleSilenceMs: 10_000,
      timeoutMs: 15_000,
    })
    const created = await ctx.terminals.spawn(agent, { type: 'shell' })
    const controller = new AbortController()
    const ready = 'RAW_READY'
    // Delay readiness beyond the shared harness's short send bound so this
    // process test owns enough slack for loaded macOS startup and shell echo.
    // The interactive shell echoes the command, so only child output may contain the readiness marker.
    const command = 'python3 -c \'import signal,sys,termios,time; signal.signal(signal.SIGINT, lambda *_: (print("SIGINT_SEEN", flush=True), sys.exit(0))); attrs=termios.tcgetattr(0); attrs[3] &= ~termios.ISIG; termios.tcsetattr(0, termios.TCSANOW, attrs); time.sleep(2.1); print("RAW_" + "READY", flush=True); time.sleep(60)\''
    expect(command).not.toContain(ready)
    const foreground = ctx.terminals.startSend(agent, created.sessionId, {
      text: command,
      submit: true,
      signal: controller.signal,
    })
    await waitForOutput(foreground, ready, 15_000)
    controller.abort()
    const result = await foreground.done
    expectReadyForNextSend(result.waitReason)
    const afterReady = 'AFTER_SIGINT'
    const afterCommand = 'printf "AFTER_%s\\n" SIGINT'
    expect(afterCommand).not.toContain(afterReady)
    const after = ctx.terminals.startSend(agent, created.sessionId, {
      text: afterCommand,
      submit: true,
    })
    await waitForOutput(after, afterReady, 15_000)
    expectReadyForNextSend((await after.done).waitReason)
    await ctx.terminals.kill(agent, created.sessionId)
  }, 35_000)
})

/** Observe public PTY/session seams without retaining input, environment or output text in the report. */
function pwshStartupDiagnostics(ctx: Context) {
  const start = Date.now()
  const sanitizer = new TerminalSanitizer(16_384)
  const decoder = new TextDecoder()
  let chunks = 0
  let bytes = 0
  let markerCount = 0
  let exactPromptTails = 0
  let promptInvalidations = 0
  let tailCarriageReturns = 0
  let tailNewlines = 0
  let tailOverflowSeen = false
  let ownedReadySeen = false
  let firstMarkerAt: number | undefined
  let firstExactTailAt: number | undefined
  let firstInvalidationAt: number | undefined
  let promptTail = ''
  let setupEchoSeen = false
  let defaultPromptSeen = false
  let continuationSeen = false
  let parserErrorSeen = false
  let foreground: SubprocessTerminalForeground | undefined
  let inspectionFailed = false
  let readSession: (() => ReturnType<LocalPtySession['read']>) | undefined
  let ownedPrompt: (() => boolean) | undefined
  let observeOutput: (() => void) | undefined
  let setupWriteCount = 0
  let submitWriteCount = 0
  let cursorReplyCount = 0
  let cursorQueryChunks = 0
  const writes: Array<{ bytes: number; setup: boolean; submit: boolean; cursorReply: boolean }> = []
  const sends: Array<{ elapsedMs: number; reason: string; bytes: number; ownedPrompt: boolean }> = []
  const restorers: Array<() => void> = []
  // Default spies delegate to the native method; no replacement implementation or extra await.
  const startSpy = vi.spyOn(LocalPtySession.prototype, 'startSend')
  let observedSends = 0
  const captureSends = (): void => {
    const candidate: unknown = startSpy.mock.contexts.at(-1)
    if (candidate instanceof LocalPtySession) {
      readSession = () => candidate.read({})
      ownedPrompt = () => candidate.controlledPromptReady
      // The real session already owns its stream before adding this observer.
      observeOutput?.()
      observeOutput = undefined
    }
    for (const result of startSpy.mock.results.slice(observedSends)) {
      if (result.type === 'incomplete') break
      observedSends += 1
      if (result.type !== 'return') continue
      void result.value.done.then((settled) => {
        sends.push({ elapsedMs: Date.now() - start, reason: settled.waitReason,
          bytes: Buffer.byteLength(settled.viewport), ownedPrompt: ownedPrompt?.() ?? false })
        if (sends.length > 12) sends.shift()
      }).catch(() => { /* The original operation remains the rejection authority. */ })
    }
  }
  restorers.push(() => { startSpy.mockRestore() })
  const originalSpawn = ctx.subprocess.spawnTerminal.bind(ctx.subprocess)
  const spawnSpy = vi.spyOn(ctx.subprocess, 'spawnTerminal').mockImplementation(async (spec) => {
    const handle = await originalSpawn(spec)
    const onData = (chunk: Buffer): void => {
      chunks += 1
      bytes += chunk.byteLength
      const decoded = decoder.decode(chunk, { stream: true })
      if (decoded.includes('\x1b[6n')) cursorQueryChunks += 1
      const classified = sanitizer.push(decoded)
      setupEchoSeen ||= classified.text.includes('function prompt')
      defaultPromptSeen ||= classified.text.includes('PS ')
      continuationSeen ||= /(?:^|\n)>>/.test(classified.text)
      parserErrorSeen ||= classified.text.includes('ParserError')
      if (classified.prompt) {
        markerCount += 1
        firstMarkerAt ??= Date.now() - start
        promptTail = ''
      }
      if (classified.promptTail !== undefined) {
        const previouslyExact = promptTail === CONTROLLED_PROMPT
        if (classified.promptTail.includes('\r')) tailCarriageReturns += 1
        if (classified.promptTail.includes('\n')) tailNewlines += 1
        tailOverflowSeen ||= promptTail.length + classified.promptTail.length > CONTROLLED_PROMPT.length
        promptTail = (promptTail + classified.promptTail).slice(0, 32)
        if (promptTail === CONTROLLED_PROMPT) {
          exactPromptTails += 1
          firstExactTailAt ??= Date.now() - start
        } else if (previouslyExact) {
          promptInvalidations += 1
          firstInvalidationAt ??= Date.now() - start
        }
      }
      ownedReadySeen ||= ownedPrompt?.() === true
    }
    observeOutput = () => { handle.output.on('data', onData) }
    restorers.push(() => { handle.output.off('data', onData) })
    const originalWrite = handle.write.bind(handle)
    const writeSpy = vi.spyOn(handle, 'write').mockImplementation((data) => {
      const setup = data.includes('function prompt')
      const submit = data.endsWith('\r')
      const cursorReply = /^\x1b\[\d+;\d+R$/.test(data)
      if (setup) setupWriteCount += 1
      if (submit) submitWriteCount += 1
      if (cursorReply) cursorReplyCount += 1
      writes.push({ bytes: Buffer.byteLength(data), setup, submit, cursorReply })
      if (writes.length > 12) writes.shift()
      return originalWrite(data)
    })
    restorers.push(() => { writeSpy.mockRestore() })
    const originalInspect = handle.inspectForeground.bind(handle)
    const inspectSpy = vi.spyOn(handle, 'inspectForeground').mockImplementation(() => {
      captureSends()
      const inspecting = originalInspect()
      void inspecting.then((state) => { foreground = state }).catch(() => {
        inspectionFailed = true // Observe failure without changing its original promise.
      })
      return inspecting
    })
    restorers.push(() => { inspectSpy.mockRestore() })
    return handle
  })
  restorers.push(() => { spawnSpy.mockRestore() })
  return {
    report: () => {
      captureSends()
      const read = readSession?.()
      console.error(JSON.stringify({ diagnostic: 'pwsh-startup-protocol', platform: process.platform,
        elapsedMs: Date.now() - start, chunks, bytes, markerCount, exactPromptTails,
        setupWriteCount, submitWriteCount, cursorQueryChunks, cursorReplyCount,
        promptInvalidations, tailCarriageReturns, tailNewlines, tailOverflowSeen, ownedReadySeen,
        firstMarkerAt: firstMarkerAt ?? null, firstExactTailAt: firstExactTailAt ?? null,
        firstInvalidationAt: firstInvalidationAt ?? null,
        tailLength: promptTail.length, tailStartsAtPrompt: promptTail.startsWith(CONTROLLED_PROMPT),
        tailContainsPrompt: promptTail.includes(CONTROLLED_PROMPT),
        setupEchoSeen, defaultPromptSeen, continuationSeen, parserErrorSeen,
        ownedPrompt: ownedPrompt?.() ?? null, viewportBytes: read === undefined ? null : Buffer.byteLength(read.text),
        viewportLines: read?.totalLines ?? null, viewportTruncated: read?.truncated ?? null,
        viewportEndsAtPrompt: read?.text.endsWith(CONTROLLED_PROMPT) ?? null,
        foregroundPgid: foreground?.processGroupId ?? null, inputWaiting: foreground?.inputWaiting ?? null,
        inspectionFailed, sendCount: startSpy.mock.calls.length, writes, sends }))
    },
    restore: () => { for (const restore of restorers.reverse()) restore() },
  }
}

const hasPwsh = spawnSync(
  resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0

describe.skipIf(!hasPwsh)('terminal-bash pwsh real shell', () => {
  it.each([false, true])('bootstraps a persistent pwsh, persists state, and scrubs secrets (hold command: %s)', async (holdCommand) => {
    const previous = process.env.DSH_TEST_SECRET
    process.env.DSH_TEST_SECRET = 'must-not-leak'
    try {
      const { ctx, root, agent } = await harness('danger-full-access', {
        idleSilenceMs: 300,
        handoffGraceMs: 300,
        timeoutMs: 8_000,
      }, 'pwsh')
      const diagnostics = pwshStartupDiagnostics(ctx)
      let created
      try {
        created = await ctx.terminals.spawn(agent, { type: 'shell', name: 'main', cwd: root })
      } catch (error: unknown) {
        diagnostics.report()
        throw error
      } finally { diagnostics.restore() }
      expect(created.motd).toContain('dsh> ')

      const releaseFile = join(root, 'release-command')
      // Hold the command across the silence settlement without relying on host load.
      const barrier = holdCommand
        ? `while (-not [IO.File]::Exists('${releaseFile.replaceAll("'", "''")}')) { [Threading.Thread]::Sleep(10) }; `
        : ''
      const first = ctx.terminals.startSend(agent, created.sessionId, {
        text: barrier + '$env:KEEP = "ok"; Set-Location /',
        submit: true,
      })
      expect(['stdin_read', 'inferred_idle']).toContain((await first.done).waitReason)
      const expected = 'keep=ok cwd=/ secret=END'
      const command = "Write-Output ('keep={0} cwd={1} secret={2}END' -f $env:KEEP, (Get-Location).Path, $env:DSH_TEST_SECRET)"
      expect(command).not.toContain(expected)
      const second = ctx.terminals.startSend(agent, created.sessionId, { text: command, submit: true })
      const result = await second.done
      expect(['stdin_read', 'inferred_idle']).toContain(result.waitReason)
      if (holdCommand) {
        expect(result.waitReason).toBe('inferred_idle')
        expect(result.viewport).not.toContain(expected)
        writeFileSync(releaseFile, '')
      }

      // A silence-settled send stops collecting output; scrollback still receives
      // the command's later output. Only the child can produce this formatted token.
      const read = () => ctx.terminals.read(agent, created.sessionId, { offset: 0, count: 100 }).text
      await expect.poll(read, { timeout: 8_000 }).toContain(expected)
      expect(read()).not.toContain('must-not-leak')
      expect(await ctx.terminals.kill(agent, created.sessionId)).toBe(true)
      expect(ctx.terminals.list(agent)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.DSH_TEST_SECRET
      else process.env.DSH_TEST_SECRET = previous
    }
  }, 30_000)

  it('pins UTF-8 output encoding so non-ASCII output survives the byte decode', async () => {
    const { ctx, root, agent } = await harness('danger-full-access', {
      idleSilenceMs: 300,
      handoffGraceMs: 300,
      timeoutMs: 8_000,
    }, 'pwsh')
    const created = await ctx.terminals.spawn(agent, { type: 'shell', name: 'main', cwd: root })
    // The bootstrap itself must have pinned both encodings: the session byte
    // decode is UTF-8, so an un-pinned console writing its host code page
    // garbles every non-ASCII byte that follows.
    const pinned = ctx.terminals.startSend(agent, created.sessionId, {
      text: '"console=" + [Console]::OutputEncoding.WebName + " out=" + $OutputEncoding.WebName',
      submit: true,
    })
    const pinnedResult = await pinned.done
    expect(pinnedResult.viewport).toContain('console=utf-8 out=utf-8')
    // Char codes keep the submitted line ASCII-only, so the assertion is a
    // pure output-decode check.
    const sent = ctx.terminals.startSend(agent, created.sessionId, {
      text: "[Console]::Write([char]0x4E2D + [char]0x6587 + ' encoding-ok')",
      submit: true,
    })
    const result = await sent.done
    expect(result.viewport).toContain('中文 encoding-ok')
    await ctx.terminals.kill(agent, created.sessionId)
  }, 30_000)
})

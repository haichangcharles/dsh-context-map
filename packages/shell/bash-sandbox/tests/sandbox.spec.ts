/**
 * Consumer-side `SandboxBashExecutor` tests. A fake Cordis sandbox service makes wrapping,
 * policy hand-off, fail-closed propagation, classification, and fact stamping deterministic;
 * real-provider integration lives in `tests/landlock.e2e.ts`. A mode-0555 directory supplies
 * the Unix denial signature used by the classifier without requiring a real sandbox runner.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ShellRunResult, CollectedOutput, ShellProcess } from '@deepseek-ai/dsh-shell'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SANDBOX_UNAVAILABLE, SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxMode, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure } from '../src/helpers.ts'
import type { Config } from '@deepseek-ai/dsh-bash-sandbox'

// Observe the real native command adapter only for the immediate-disposal fixture.
const nativeTrace = vi.hoisted(() => ({
  active: false,
  startedAt: 0,
  scopeName: undefined as string | undefined,
  events: [] as {
    event: 'show' | 'kill' | 'probe'
    phase?: 'start' | 'result'
    elapsedMs: number
    status?: number | null
    errorCode?: string | number | undefined
    signal?: 'SIGTERM' | 'SIGKILL' | undefined
    loadState?: string | undefined
    activeState?: string | undefined
  }[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const errno = (error: unknown): string | number | undefined => {
    if (!(error instanceof Error) || !('code' in error)) return undefined
    const code = error.code
    return typeof code === 'number' ? code
      : typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ESRCH'].includes(code) ? code : 'other'
  }
  const state = (text: string, field: string, allowed: readonly string[]): string | undefined => {
    const value = text.split(/\r?\n/u).find(line => line.startsWith(`${field}=`))?.slice(field.length + 1)
    return value === undefined ? undefined : allowed.includes(value) ? value : 'other'
  }
  const matches = (args: unknown[], operation: string): boolean => nativeTrace.active
    && args[0] === 'systemctl' && Array.isArray(args[1]) && args[1].includes(operation)
  return {
    ...actual,
    execFile: ((...args: unknown[]) => {
      const callback = args.at(-1)
      if (matches(args, 'show') && typeof callback === 'function') {
        const argv = args[1] as unknown[]
        nativeTrace.scopeName = argv.find((value): value is string =>
          typeof value === 'string' && /^dsh-subprocess-\d+-[a-f0-9]+\.scope$/u.test(value))
        nativeTrace.events.push({ event: 'show', phase: 'start',
          elapsedMs: Math.round(performance.now() - nativeTrace.startedAt) })
        args[args.length - 1] = function (this: unknown, ...results: unknown[]) {
          const text = typeof results[1] === 'string' ? results[1] : ''
          if (nativeTrace.active) nativeTrace.events.push({ event: 'show', phase: 'result',
            elapsedMs: Math.round(performance.now() - nativeTrace.startedAt),
            errorCode: errno(results[0]),
            loadState: state(text, 'LoadState', ['loaded', 'not-found', 'masked', 'error', 'bad-setting', 'merged', 'stub']),
            activeState: state(text, 'ActiveState', ['active', 'inactive', 'activating', 'deactivating', 'reloading', 'failed']) })
          Reflect.apply(callback, this, results)
        }
      }
      return actual.execFile(...args as Parameters<typeof actual.execFile>)
    }) as typeof actual.execFile,
    spawnSync: ((...args: unknown[]) => {
      const result = actual.spawnSync(...args as Parameters<typeof actual.spawnSync>)
      if (nativeTrace.active && args[0] === 'systemd-run' && Array.isArray(args[1]) && args[1].includes('--scope')) {
        nativeTrace.events.push({ event: 'probe', elapsedMs: Math.round(performance.now() - nativeTrace.startedAt),
          status: result.status, errorCode: errno(result.error) })
      }
      if (matches(args, 'kill')) {
        const argv = args[1] as unknown[]
        const signal = argv.includes('--signal=SIGKILL') ? 'SIGKILL' : argv.includes('--signal=SIGTERM') ? 'SIGTERM' : undefined
        nativeTrace.events.push({ event: 'kill', elapsedMs: Math.round(performance.now() - nativeTrace.startedAt),
          status: result.status, errorCode: errno(result.error), signal })
      }
      return result
    }) as typeof actual.spawnSync,
  }
})

/** Read only the selected native scope's failure facts, never exposing its private identity. */
async function failedScopeFacts(unit: string | undefined) {
  const facts = {
    controlGroupPresent: undefined as boolean | undefined,
    subState: undefined as string | undefined,
    tasksCurrent: undefined as number | 'unknown' | undefined,
    populated: undefined as 0 | 1 | undefined,
    liveCount: undefined as number | undefined,
    zombieCount: undefined as number | undefined,
    deadCount: undefined as number | undefined,
    unreadableCount: 0,
    readError: undefined as string | undefined,
  }
  const errorCode = (error: unknown): string => {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    return typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ESRCH'].includes(code) ? code : 'other'
  }
  if (unit === undefined) return { ...facts, readError: 'no-native-scope' }
  const text = await new Promise<string | undefined>((resolveText) => {
    execFile('systemctl', ['--user', 'show', unit, '--property=SubState', '--property=TasksCurrent', '--property=ControlGroup'],
      { encoding: 'utf8', timeout: 2_000 }, (error, stdout) => {
        if (error !== null) { facts.readError = errorCode(error); resolveText(undefined) }
        else resolveText(stdout)
      })
  })
  if (text === undefined) return facts
  const value = (field: string): string | undefined =>
    text.split(/\r?\n/u).find(line => line.startsWith(`${field}=`))?.slice(field.length + 1)
  const subState = value('SubState')
  facts.subState = subState === undefined ? undefined
    : ['running', 'dead', 'failed', 'stop-sigterm', 'stop-sigkill', 'abandoned', 'start-chown'].includes(subState) ? subState : 'other'
  const tasks = value('TasksCurrent')
  facts.tasksCurrent = tasks === undefined ? undefined
    : /^\d+$/u.test(tasks) && Number.isSafeInteger(Number(tasks)) ? Number(tasks) : 'unknown'
  const controlGroup = value('ControlGroup')
  facts.controlGroupPresent = controlGroup === undefined ? undefined : controlGroup.length > 0
  if (!controlGroup) return facts
  // The manager owns the cgroup. Inspect only this operation's exact unit path.
  if (!controlGroup.startsWith('/') || !controlGroup.endsWith(`/${unit}`)
    || controlGroup.split('/').some(segment => segment === '.' || segment === '..')) {
    return { ...facts, readError: 'unverified-cgroup-path' }
  }
  try {
    const root = `/sys/fs/cgroup${controlGroup}`
    const events = await readFile(`${root}/cgroup.events`, 'utf8')
    const populated = /^populated ([01])$/mu.exec(events)?.[1]
    facts.populated = populated === '0' ? 0 : populated === '1' ? 1 : undefined
    const pids = (await readFile(`${root}/cgroup.procs`, 'utf8')).split(/\s+/u).filter(pid => /^\d+$/u.test(pid))
    facts.liveCount = 0
    facts.zombieCount = 0
    facts.deadCount = 0
    // Fixed read bound; unread members cannot be mistaken for an empty group.
    facts.unreadableCount = Math.max(0, pids.length - 100)
    for (const pid of pids.slice(0, 100)) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
        if (state === 'Z') facts.zombieCount += 1
        else if (state === 'X' || state === 'x') facts.deadCount += 1
        else if (state !== undefined && /^[RSDITWP]$/u.test(state)) facts.liveCount += 1
        else facts.unreadableCount += 1
      } catch { facts.unreadableCount += 1 }
    }
  } catch (error) { facts.readError = errorCode(error) }
  return facts
}

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-sandbox-spec-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

/** One recorded provider call: the argv handed over and the policy it rode with. */
interface ConfineCall {
  argv: string[]
  policy: SandboxPolicy
}

/** The Linux file-denial dialects the fake wraps carry — matches the unix-permission denials the tests below produce. */
const UNIX_SIGNATURES = ['read-only file system', 'permission denied'] as const

/** The runner-failure rule the fake wraps carry (a fake-runner: error line marks the sandbox itself failing). */
const RUNNER_FAILURE = [{ fatalSignatures: ['fake-runner: '] }] as const

/** Provider argv[0] forms that all share the caller-owned cwd spawn precondition. */
const RUNNER_FORMS = [
  ['absolute', process.execPath],
  ['bare', 'node'],
  ['relative', './sandbox-runner'],
] as const

/** A passthrough wrap: the caller's argv unchanged, asserted full — commands run unconfined, deterministically. */
const passthrough = (argv: readonly string[]): ConfinedArgv =>
  ({ argv: [...argv], enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE })

/**
 * Boot a context with a recording fake `ctx.sandbox` (behavior injectable
 * per test) and the executor under test on top of it.
 */
async function setup(
  config: { mode?: SandboxMode; workspaceRoot?: string } & Config = {},
  behavior: (argv: readonly string[], policy: SandboxPolicy) => ConfinedArgv = passthrough,
) {
  const { mode, workspaceRoot, ...execConfig } = config
  const calls: ConfineCall[] = []
  class FakeSandboxProvider extends SandboxProvider {
    confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
      calls.push({ argv: [...argv], policy })
      return behavior(argv, policy)
    }
  }
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(FakeSandboxProvider)
  await ctx.plugin(SandboxPolicyService, {
    ...mode !== undefined ? { mode } : {},
    ...workspaceRoot !== undefined ? { workspaceRoot } : {},
  })
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(SandboxBashExecutor, { graceMs: 200, ...execConfig })
  const bash = ctx.shell as SandboxBashExecutor
  return { ctx, bash, calls }
}

function output(text: string): CollectedOutput {
  return { text, truncated: false }
}

function runResult(exitCode: number | null, stderr: string): ShellRunResult {
  return { exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 1000, stdout: output(''), stderr: output(stderr) }
}

function executionPolicy(mode: SandboxMode, workspaceRoot = resolve(process.cwd())): SandboxExecutionPolicy {
  return { mode, workspaceRoot }
}

describe('the provider hand-off', () => {
  it('hands the provider the exact bash argv and the per-call policy, and runs the returned argv', async () => {
    const { bash, calls } = await setup()
    const result = await bash.run(bash.resolve({ command: 'echo \'a b\' "c\'d"' }))
    expect(result.stdout.text).toBe('a b c\'d\n')
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
    expect(calls).toEqual([{
      argv: ['bash', '-c', 'echo \'a b\' "c\'d"'],
      policy: { mode: 'read-only', workspaceRoot: resolve(process.cwd()) },
    }])
  })

  it('hands the provider\'s returned argv directly to ctx.subprocess.spawn', async () => {
    const returnedArgv = ['env', 'DSH_WRAP=1', 'bash', '-c', 'printf "%s" "$DSH_WRAP"']
    const { ctx, bash } = await setup({}, () => ({ argv: returnedArgv, enforcement: 'full', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE }))
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const result = await bash.run(bash.resolve({ command: 'printf "%s" "$DSH_WRAP"' }))
    expect(result.stdout.text).toBe('1')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].argv).toEqual(returnedArgv)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('starts a non-Bash runner before the confined inner Bash evaluates BASH_ENV', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-env-order-'))
    const hook = join(dir, 'hook.sh')
    const order = join(dir, 'order.txt')
    writeFileSync(hook, 'printf "hook\\n" >> "$DSH_ORDER_FILE"\n')
    const runnerScript = [
      'const { appendFileSync } = require("node:fs");',
      'const { spawnSync } = require("node:child_process");',
      'appendFileSync(process.env.DSH_ORDER_FILE, "runner\\n");',
      'const child = spawnSync(process.argv[1], process.argv.slice(2), { env: process.env, stdio: "inherit" });',
      'process.exit(child.status ?? 125);',
    ].join('')
    const { bash } = await setup({}, argv => ({
      argv: [process.execPath, '-e', runnerScript, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))

    try {
      const result = await bash.run(bash.resolve({
        command: 'true',
        env: { BASH_ENV: hook },
        dshEnv: { DSH_ORDER_FILE: order },
      }))
      expect(result.exitCode).toBe(0)
      expect(readFileSync(order, 'utf8')).toBe('runner\nhook\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('workspace-write rides the policy, workspaceRoot falling back to process.cwd() when not configured', async () => {
    const { bash, calls } = await setup({ mode: 'workspace-write' })
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    expect(calls[0]?.policy).toEqual({ mode: 'workspace-write', workspaceRoot: resolve(process.cwd()) })
  })

  it('an explicit workspaceRoot on the policy wins', async () => {
    const { calls, bash } = await setup({ mode: 'workspace-write', workspaceRoot: '/ws', cwd: tmpdir() })
    await bash.run(bash.resolve({ command: 'true' }))
    expect(calls[0]?.policy.workspaceRoot).toBe(resolve('/ws'))
  })

  it('the provider is consulted per wrap (no caching in the consumer): run and start each hand off', async () => {
    const { bash, calls } = await setup()
    await bash.run(bash.resolve({ command: 'true' }))
    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done
    expect(calls).toHaveLength(2)
  })

})

describe('fail closed', () => {
  it('propagates the provider\'s structured SANDBOX_UNAVAILABLE on run() and start()', async () => {
    const { bash } = await setup({}, () => { throw new SandboxUnavailableError('read-only') })
    const spec = bash.resolve({ command: 'echo hi' })
    await expect(bash.run(spec)).rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(() => bash.start(spec)).toThrow(SandboxUnavailableError)
  })

  it('preserves an already-aborted foreground call as cancellation', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const reason = new Error('caller cancelled before spawn')
    controller.abort(reason)
    await expect(bash.run(bash.resolve({ command: 'true', signal: controller.signal }))).rejects.toBe(reason)
  })

  it.each(RUNNER_FORMS)(
    'keeps an invalid workdir ordinary with the %s provider-runner form',
    async (_form, runner) => {
      const { bash } = await setup({}, argv => ({
        argv: [runner, ...argv],
        enforcement: 'full',
        denialSignatures: UNIX_SIGNATURES,
        runnerFailureRules: RUNNER_FAILURE,
      }))
      const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
      try {
        const failure = await bash.run(bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
          .catch((error: unknown) => error)
        expect(failure).toMatchObject({ code: 'ENOENT' })
        expect(failure).not.toBeInstanceOf(SandboxUnavailableError)
      } finally {
        rmSync(parent, { recursive: true, force: true })
      }
    },
  )

  it('keeps an invalid workdir ordinary when danger-full-access bypasses the provider', async () => {
    const { bash } = await setup({ mode: 'danger-full-access' })
    const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
    try {
      const failure = await bash.run(bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'ENOENT' })
      expect(failure).not.toBeInstanceOf(SandboxUnavailableError)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('keeps Node-shaped synchronous ENOEXEC ordinary in run() and start()', async () => {
    const runner = join(spillDir, 'malformed-runner')
    const { ctx, bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      throw Object.assign(new Error('spawn ENOEXEC'), { code: 'ENOEXEC', syscall: 'spawn' })
    })

    const foreground = await bash.run(bash.resolve({ command: 'true' })).catch((error: unknown) => error)
    expect(foreground).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
    expect(foreground).not.toBeInstanceOf(SandboxUnavailableError)

    let background: unknown
    try {
      bash.start(bash.resolve({ command: 'true' }))
    } catch (error) {
      background = error
    }
    expect(background).toMatchObject({ code: 'ENOEXEC', syscall: 'spawn' })
    expect(background).not.toBeInstanceOf(SandboxUnavailableError)
  })

  it('classifies a synchronous SubprocessRuntime EACCES with the exact runner path', async () => {
    const runner = join(spillDir, 'unexecutable-runner')
    const { ctx, bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    // This pins an alternative SubprocessRuntime's synchronous seam, not the
    // shipped local behavior.
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => {
      throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES', syscall: 'spawn', path: runner })
    })

    await expect(bash.run(bash.resolve({ command: 'true' })))
      .rejects.toMatchObject({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE })
    expect(() => bash.start(bash.resolve({ command: 'true' })))
      .toThrow(expect.objectContaining({ name: 'SandboxUnavailableError', code: SANDBOX_UNAVAILABLE }))
  })

  it('keeps a synchronous cwd-owned ENOENT as the original start() error', async () => {
    const runner = './sandbox-runner'
    const { ctx, bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
    const workdir = join(parent, 'missing')
    const failure = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT', syscall: `spawn ${runner}`, path: runner })
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => { throw failure })
    try {
      let thrown: unknown
      try {
        bash.start(bash.resolve({ command: 'true', workdir }))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(failure)
      expect(thrown).not.toBeInstanceOf(SandboxUnavailableError)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('danger-full-access', () => {
  it('runs unwrapped: the provider is never consulted, facts carry no enforcement', async () => {
    const { bash, calls } = await setup({ mode: 'danger-full-access' })
    const result = await bash.run(bash.resolve({ command: 'echo free' }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('start() passes through unwrapped and stamps nothing at settle', async () => {
    const { bash, calls } = await setup({ mode: 'danger-full-access' })
    const task = bash.start(bash.resolve({ command: 'echo free-bg' }))
    await task.done
    expect(task.sandbox).toBeUndefined()
    expect(task.readOutput().delta).toContain('free-bg')
    expect(calls).toHaveLength(0)
  })
})

describe('per-call sandbox policy (the session and escalation carrier)', () => {
  it('exposes the configured default as the capability fact, and resolve() stamps it', async () => {
    const { bash } = await setup()
    expect(bash.sandboxMode).toBe('read-only')
    expect(bash.resolve({ command: 'true' }).sandboxPolicy).toEqual(executionPolicy('read-only'))
  })

  it('an explicit policy outranks the default at resolve(), and the wrap follows its mode and root', async () => {
    const { bash, calls } = await setup()
    const explicit = executionPolicy('workspace-write', '/session/project')
    expect(bash.resolve({ command: 'true', sandboxPolicy: explicit }).sandboxPolicy).toEqual(explicit)
    await bash.run(bash.resolve({ command: 'true', sandboxPolicy: explicit }))
    await bash.run(bash.resolve({ command: 'true' }))
    expect(calls.map(call => call.policy)).toEqual([explicit, executionPolicy('read-only')])
  })

  it('an escalated run reports the mode it ACTUALLY ran under', async () => {
    const { bash } = await setup()
    const result = await bash.run(bash.resolve({ command: 'true', sandboxPolicy: executionPolicy('workspace-write') }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
  })

  it('escalating to danger-full-access bypasses the provider entirely — the grant, not a probe, is the authority there', async () => {
    const { bash, calls } = await setup()
    const result = await bash.run(bash.resolve({ command: 'echo free', sandboxPolicy: executionPolicy('danger-full-access') }))
    expect(result.stdout.text).toBe('free\n')
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(calls).toHaveLength(0)
  })

  it('overlapping background jobs settle with their OWN modes (an escalated task next to a default one)', async () => {
    // With per-call policy, tasks under different modes are in flight at
    // once — anything keyed off the configured default would misreport the
    // escalated one at its settle stamp.
    const { bash } = await setup()
    const escalated = bash.start(bash.resolve({ command: 'sleep 0.3; echo "x: Permission denied" >&2; exit 1', sandboxPolicy: executionPolicy('workspace-write') }))
    const plain = bash.start(bash.resolve({ command: 'true' }))
    await plain.done
    await escalated.done
    expect(escalated.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'full' })
    expect(plain.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('an escalated danger-full-access background job carries no facts (nothing confined it)', async () => {
    const { bash, calls } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo bg-free', sandboxPolicy: executionPolicy('danger-full-access') }))
    await task.done
    expect(task.sandbox).toBeUndefined()
    expect(task.readOutput().delta).toContain('bg-free')
    expect(calls).toHaveLength(0)
  })
})

describe('classifyDenial', () => {
  it('never classifies a clean exit or a signal kill as a denial', () => {
    expect(classifyDenial(runResult(0, 'Permission denied'), UNIX_SIGNATURES)).toBe(false)
    expect(classifyDenial(runResult(null, 'Permission denied'), UNIX_SIGNATURES)).toBe(false)
  })

  it('classifies failed runs by the wrap\'s own dialect, conservatively', () => {
    expect(classifyDenial(runResult(1, 'touch: cannot touch /x: Read-only file system'), UNIX_SIGNATURES)).toBe(true)
    expect(classifyDenial(runResult(1, 'sh: /x: Permission denied'), UNIX_SIGNATURES)).toBe(true)
    // Bare EPERM is not a Linux runner's dialect: mount/kill/ptrace fail with
    // it unsandboxed too, and the mode vocabulary governs file effects only —
    // claiming a file denial here would tell the model the sandbox blocked
    // something it never governed.
    expect(classifyDenial(runResult(1, 'mount: Operation not permitted'), UNIX_SIGNATURES)).toBe(false)
    expect(classifyDenial(runResult(1, 'No such file or directory'), UNIX_SIGNATURES)).toBe(false)
  })

  it('matches exactly the active backend\'s dialect: EPERM classifies under Seatbelt, EACCES does not under bwrap', () => {
    // The same stderr flips meaning with the backend: under Seatbelt, EPERM
    // text IS how the kernel refuses a governed file write; under bwrap's
    // EROFS-only dialect, `Permission denied` is ordinary DAC, not the
    // sandbox — per-wrap signatures are what keep both classifications honest.
    expect(classifyDenial(runResult(1, 'bash: /etc/x: Operation not permitted'), ['operation not permitted'])).toBe(true)
    expect(classifyDenial(runResult(1, 'sh: /x: Permission denied'), ['read-only file system'])).toBe(false)
  })
})

describe('isRunnerSpawnFailure', () => {
  it.each(['EACCES', 'ENOENT'])(
    'attributes executable-class spawn code %s to argv[0] once cwd ambiguity is eliminated',
    (code) => {
      const runner = join(spillDir, 'runner')
      const error = Object.assign(new Error('spawn failed'), { code, syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, process.cwd())).toBe(true)
    },
  )

  it.each(['ENOEXEC', 'ENOTDIR', 'EPERM'])(
    'keeps unproven executable code %s ordinary despite synthetic argv[0] fields',
    (code) => {
      const runner = join(spillDir, 'runner')
      const error = Object.assign(new Error('spawn failed'), { code, syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, process.cwd())).toBe(false)
    },
  )

  it('requires a usable caller cwd before classifying absolute, bare, or relative runners', () => {
    const missingWorkdir = join(spillDir, 'missing-workdir')
    for (const [, runner] of RUNNER_FORMS) {
      const error = Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall: `spawn ${runner}`, path: runner })
      expect(isRunnerSpawnFailure(error, runner, missingWorkdir)).toBe(false)
    }
    const fileWorkdir = join(spillDir, 'not-a-workdir')
    writeFileSync(fileWorkdir, '')
    const error = Object.assign(new Error('spawn failed'), { code: 'ENOTDIR', syscall: 'spawn node', path: 'node' })
    expect(isRunnerSpawnFailure(error, 'node', fileWorkdir)).toBe(false)
  })

  it('rejects resource, non-spawn, mismatched-program, and unstructured failures', () => {
    const missingRunner = join(spillDir, 'definitely-missing-runner')
    const spawnError = (code: unknown, syscall: unknown = `spawn ${missingRunner}`, path: unknown = missingRunner) =>
      Object.assign(new Error('spawn failed'), { code, syscall, path })
    const spawnErrorWithoutPath = (syscall: string) =>
      Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall })

    expect(isRunnerSpawnFailure(spawnError('EMFILE'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOMEM'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError(2), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'open'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 1), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', process.execPath), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', 1), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT', 'spawn', ''), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnErrorWithoutPath('spawn'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnErrorWithoutPath('spawn other-runner'), missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(undefined, missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(null, missingRunner, process.cwd())).toBe(false)
    expect(isRunnerSpawnFailure(spawnError('ENOENT'), undefined, process.cwd())).toBe(false)
  })

  it('accepts only syscall and error-path facts that identify the exact runner program', () => {
    const runner = join(spillDir, 'runner with spaces')
    const spawnError = (syscall: string, path?: string) =>
      Object.assign(new Error('spawn failed'), { code: 'ENOENT', syscall, path })

    expect(isRunnerSpawnFailure(spawnError('spawn', runner), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError(`spawn ${runner}`, runner), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError(`spawn ${runner}`), runner, process.cwd())).toBe(true)
    expect(isRunnerSpawnFailure(spawnError('spawn other-runner', runner), runner, process.cwd())).toBe(false)
  })
})

describe('classifyRunnerFailure', () => {
  it('ignores empty and whitespace-only fatal signatures instead of treating exit status or notice text as evidence', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const emptyRule = [{ allowedExitCodes: [125], fatalSignatures: ['', ' ', '\t'] }]
    expect(classifyRunnerFailure(125, '', emptyRule)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice, emptyRule)).toBeUndefined()
  })

  it('keeps valid fatal signatures active beside an ignored empty entry', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const fatal = 'landlock-run: ruleset creation failed'
    const rules = [{
      allowedExitCodes: [125],
      fatalSignatures: ['', ' ', 'landlock-run: '],
      informationalLines: [notice],
    }]
    expect(classifyRunnerFailure(125, `${notice}\nchild diagnostic\n${fatal}`, rules)).toEqual({ detail: fatal })
  })

  it('requires Landlock exit 125 plus a non-notice fatal line and returns that original line', () => {
    const notice = 'landlock-run: partial enforcement (older Landlock ABI)'
    const rules = [{ allowedExitCodes: [125], fatalSignatures: ['landlock-run: '], informationalLines: [notice] }]
    expect(classifyRunnerFailure(1, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(2, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice, rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, notice.toUpperCase(), rules)).toBeUndefined()
    expect(classifyRunnerFailure(125, `${notice}: extra detail`, rules))
      .toEqual({ detail: `${notice}: extra detail` })
    expect(classifyRunnerFailure(125, `${notice}\nlandlock-run: exec failed: No such file or directory`, rules))
      .toEqual({ detail: 'landlock-run: exec failed: No such file or directory' })
  })

  it.each([
    'landlock-run: usage error: missing `-- <argv>...` command',
    'landlock-run: landlock is not enforced by this kernel (ABI unsupported or disabled)',
    'landlock-run: cannot open rule path: /gone: No such file or directory',
    'landlock-run: landlock ruleset error: Invalid argument',
    'landlock-run: exec failed: Permission denied',
    'landlock-run: out of memory',
    'landlock-run: future fatal diagnostic',
  ])('keeps known and future Landlock fatal diagnostics fail-closed: %s', (fatal) => {
    const rules = [{
      allowedExitCodes: [125],
      fatalSignatures: ['landlock-run: '],
      informationalLines: ['landlock-run: partial enforcement (older Landlock ABI)'],
    }]
    expect(classifyRunnerFailure(125, fatal, rules)).toEqual({ detail: fatal })
  })
})

describe('result facts', () => {
  it.each([126, 127])('keeps a successfully launched wrapped child exit %i as an ordinary outcome', async (exitCode) => {
    const { bash } = await setup({}, argv => ({
      argv: ['env', ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    const result = await bash.run(bash.resolve({ command: `exit ${exitCode}` }))
    expect(result.exitCode).toBe(exitCode)
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('reports a real permission failure as a sandbox denial with the mode it ran under', async () => {
    const { bash } = await setup()
    const deniedRoot = mkdtempSync(join(tmpdir(), 'dsh-sandbox-denied-'))
    try {
      const lockedDir = join(deniedRoot, 'locked')
      mkdirSync(lockedDir)
      chmodSync(lockedDir, 0o555)
      const result = await bash.run(bash.resolve({ command: `echo x > ${lockedDir}/f` }))
      expect(result.exitCode).not.toBe(0)
      expect(result.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
    } finally {
      rmSync(deniedRoot, { recursive: true, force: true })
    }
  })

  it('carries the provider\'s partial-enforcement fact through unchanged', async () => {
    const { bash } = await setup({}, argv => ({ argv: [...argv], enforcement: 'partial', denialSignatures: UNIX_SIGNATURES, runnerFailureRules: RUNNER_FAILURE }))
    const result = await bash.run(bash.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })
})

describe('background sandbox facts', () => {
  it.each(RUNNER_FORMS)('keeps an invalid-workdir rejection ordinary for the %s provider-runner form', async (_form, runner) => {
    const { bash } = await setup({}, argv => ({
      argv: [runner, ...argv],
      enforcement: 'full',
      denialSignatures: UNIX_SIGNATURES,
      runnerFailureRules: RUNNER_FAILURE,
    }))
    const parent = mkdtempSync(join(tmpdir(), 'dsh-sandbox-missing-cwd-'))
    try {
      const task = bash.start(bash.resolve({ command: 'true', workdir: join(parent, 'missing') }))
      await task.done

      expect(task.status).toBe('killed')
      expect(task.readOutput().delta).toContain('subprocess failed before reporting an outcome:')
      expect(task.sandbox).toEqual({
        mode: 'read-only',
        denied: false,
        enforcement: 'full',
      })
      const accounting = (bash as unknown as { processFacts: Map<unknown, unknown> }).processFacts
      expect(accounting.size).toBe(0)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('does not invent runner evidence when a provider rejection has no structured reason', async () => {
    const { ctx, bash } = await setup()
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
    }
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: emptyReader, stderr: emptyReader },
      // Arbitrary subprocess providers can reject without a value or public stage.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      done: Promise.reject(undefined),
      terminate: vi.fn(),
      waitForExit: async () => true,
    } satisfies SubprocessHandle)

    const task = bash.start(bash.resolve({ command: 'true' }))
    await task.done

    expect(task.readOutput().delta).toContain('subprocess failed before reporting an outcome: undefined')
    expect(task.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'full',
    })
  })

  it('stamps a settled denial: nonzero exit + permission stderr under a confined mode', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "x: Permission denied" >&2; exit 1' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'full' })
  })

  it('a foreground runner failure throws the fail-closed error, never a task result', async () => {
    // The wrap's runner prefix on a failed run means the SANDBOX broke and
    // the command never ran — the late twin of the confine-time throw, with
    // the matched fatal stderr line carried as the cause.
    const { bash } = await setup()
    const run = bash.run(bash.resolve({ command: 'echo "fake-runner: ruleset rejected" >&2; exit 125' }))
    await expect(run).rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
    await expect(run).rejects.toThrow('fake-runner: ruleset rejected')
  })

  it('a foreground runner failure outranks denial: runner error text may contain denial words', async () => {
    const { bash } = await setup()
    await expect(bash.run(bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' })))
      .rejects.toThrow(expect.objectContaining({ code: SANDBOX_UNAVAILABLE }))
  })

  it('a settled background runner failure stamps runnerFailed (no error channel remains), not denied', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "fake-runner: cannot open rule path: /x: Permission denied" >&2; exit 125' }))
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true })
  })

  it('overlapping background jobs keep their OWN wrap facts (per-task, not latest-wrap)', async () => {
    // Facts belong to each wrap and may vary between calls. The slow task settles after the
    // quick task starts; a shared latest-wrap field would classify and stamp it with the wrong
    // task's dialect and enforcement.
    const wraps: Array<Pick<ConfinedArgv, 'enforcement' | 'denialSignatures'>> = [
      { enforcement: 'partial', denialSignatures: ['permission denied'] },
      { enforcement: 'full', denialSignatures: ['read-only file system'] },
    ]
    let call = 0
    const { bash } = await setup({}, (argv) => {
      const wrap = wraps[Math.min(call++, wraps.length - 1)] as Pick<ConfinedArgv, 'enforcement' | 'denialSignatures'>
      return { argv: [...argv], ...wrap, runnerFailureRules: RUNNER_FAILURE }
    })
    const slow = bash.start(bash.resolve({ command: 'sleep 0.4; echo "x: Permission denied" >&2; exit 1' }))
    const quick = bash.start(bash.resolve({ command: 'true' }))
    await quick.done
    await slow.done
    expect(slow.sandbox).toEqual({ mode: 'read-only', denied: true, enforcement: 'partial' })
    expect(quick.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('a signal-killed task is never a denial (null exit code)', async () => {
    const { bash } = await setup()
    const task = bash.start(bash.resolve({ command: 'echo "Permission denied" >&2; sleep 30' }))
    // Let the stderr land before the kill so the classifier sees the
    // signature and must still refuse it on the null exit code alone.
    await vi.waitFor(() => { expect(task.readOutput().delta).toContain('Permission denied') })
    task.kill()
    await task.done
    expect(task.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  const runtimeDiagnostics = process.env['DSH_RUNTIME_DIAGNOSTICS'] === '1'
  // Independent bounded trials are diagnostic samples, never retries of a failed assertion.
  for (const trial of runtimeDiagnostics ? [1, 2, 3] : [1]) {
    it(`disposal kills wrapped background jobs (inherited HMR safety)${trial === 1 ? '' : ` [trial ${String(trial)}]`}`, async () => {
      const startedAt = performance.now()
      nativeTrace.events = []
      nativeTrace.scopeName = undefined
      nativeTrace.startedAt = startedAt
      const stages: { event: string; elapsedMs: number }[] = []
      const mark = (event: string): void => {
        stages.push({ event, elapsedMs: Math.round(performance.now() - startedAt) })
      }
      const state: {
        context?: Context
        task?: ShellProcess
        fallbackWarning?: () => boolean
        facts?: Awaited<ReturnType<typeof failedScopeFacts>>
        reported: boolean
      } = { reported: false }
      const report = (): void => {
        if (state.reported) return
        state.reported = true
        // Fixed stage names and states only; never print command or environment data.
        process.stderr.write(`${JSON.stringify({ diagnostic: 'sandbox-immediate-disposal', trial, stages,
          rootFiberState: state.context?.fiber.state, processStatus: state.task?.status,
          fallback: state.fallbackWarning?.(), native: nativeTrace.events, scopeFacts: state.facts })}\n`)
      }
      onTestFailed(async () => {
        nativeTrace.active = false
        if (process.platform === 'linux') {
          state.facts = await failedScopeFacts(nativeTrace.scopeName)
        }
        report()
      })
      onTestFinished((context) => {
        nativeTrace.active = false
        // The failure callback owns collection and emission regardless of hook order.
        if (runtimeDiagnostics && context.task.result?.state !== 'fail') report()
      })
      mark('setup:start')
      const { ctx, bash } = await setup()
      state.context = ctx
      const fallbackWarning = vi.spyOn(ctx.logger, 'warn')
      state.fallbackWarning = () => fallbackWarning.mock.calls.some(([message]) =>
        String(message).startsWith('subprocess-local is using weaker process-tree containment'))
      mark('setup:ready')
      nativeTrace.active = true
      const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
      vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
        mark('spawn:start')
        const handle = spawn(spec)
        mark('spawn:returned')
        const terminate = handle.terminate.bind(handle)
        const waitForExit = handle.waitForExit.bind(handle)
        vi.spyOn(handle, 'terminate').mockImplementation(() => {
          mark('terminate:start')
          try { terminate() } finally { mark('terminate:return') }
        })
        vi.spyOn(handle, 'waitForExit').mockImplementation((signal) => {
          mark('range-wait:start')
          const waiting = waitForExit(signal)
          void waiting.then(() => { mark('range-wait:resolved') }, () => { mark('range-wait:rejected') })
          return waiting
        })
        void handle.done.then(() => { mark('direct-done:resolved') }, () => { mark('direct-done:rejected') })
        return handle
      })
      const task = bash.start(bash.resolve({ command: 'sleep 30' }))
      state.task = task
      mark('shell-start:returned')
      mark('root-dispose:start')
      await ctx.fiber.dispose()
      mark('root-dispose:resolved')
      expect(task.status).toBe('killed')
      if (runtimeDiagnostics) report()
    })
  }
})

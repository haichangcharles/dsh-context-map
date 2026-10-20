import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, vi } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { createProcessInspector } from '../src/process-inspector.ts'
import type { ProcessIdentity, ProcessInspector } from '../src/process-inspector.ts'
import * as spawnModule from '../src/spawn.ts'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'

type ExitTrigger = 'direct' | 'uncaught-exception' | 'unhandled-rejection' | 'dispose'
type ManagedKind = 'ordinary' | 'terminal'
interface TreeState { root: number; descendant: number }

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const hostScript = fileURLToPath(new URL('./fixtures/process-exit-host.ts', import.meta.url))
const scenarioTimeoutMs = process.platform === 'win32' ? 60_000 : 30_000
const testTimeoutMs = scenarioTimeoutMs + 15_000

async function readTree(path: string): Promise<TreeState> {
  return vi.waitFor(async () => {
    const text = await readFile(path, 'utf8')
    const state = JSON.parse(text) as Partial<TreeState>
    if (!Number.isSafeInteger(state.root) || !Number.isSafeInteger(state.descendant)
      || (state.root ?? 0) <= 0 || (state.descendant ?? 0) <= 0 || state.root === state.descendant) {
      throw new Error(`invalid managed-tree state: ${text}`)
    }
    return state as TreeState
  }, { interval: 10, timeout: scenarioTimeoutMs })
}

async function captureIdentities(inspector: ProcessInspector, state: TreeState): Promise<ProcessIdentity[]> {
  return vi.waitFor(() => {
    const expected = new Set([state.root, state.descendant])
    const identities = inspector.snapshot().tree(state.root).filter(identity => expected.has(identity.pid))
    if (identities.length !== expected.size) throw new Error('managed tree is not fully observable yet')
    return identities
  }, { interval: 10, timeout: scenarioTimeoutMs })
}

async function waitForGone(inspector: ProcessInspector, identities: readonly ProcessIdentity[]): Promise<void> {
  await Promise.all(identities.map(identity => vi.waitFor(() => {
    if (inspector.isAlive(identity)) throw new Error(`managed pid ${identity.pid} is still alive`)
  }, { interval: 25, timeout: 10_000 })))
}

function cleanupTree(state: TreeState | undefined, identities: ProcessIdentity[], inspector: ProcessInspector): void {
  if (state === undefined) return
  for (const identity of identities) {
    try {
      inspector.signalProcess(identity, 'SIGKILL')
    } catch (_cleanupSignalFailed) {
      // Best-effort cleanup never substitutes an unfenced PID after signal failure.
    }
  }
}

async function runScenario(kind: ManagedKind, trigger: ExitTrigger) {
  const root = await mkdtemp(join(tmpdir(), `dsh-subprocess-host-exit-${kind}-${trigger}-`))
  const launch = resolveExampleLaunch({
    srcBin: hostScript,
    mode: 'src',
    tsconfigPath: join(repoRoot, 'tsconfig.json'),
    configArgs: [kind, trigger, root],
  })
  const inspector = createProcessInspector()
  const child = execa(launch.command, launch.args, {
    cwd: repoRoot,
    env: launch.env,
    stdin: 'ignore',
    reject: false,
    timeout: scenarioTimeoutMs,
  })
  let state: TreeState | undefined
  let identities: ProcessIdentity[] = []
  let settled = false
  let treeGone = false
  try {
    // The host validates tree.json before waiting for proceed, so observing it
    // is sufficient readiness; a second marker only adds a redundant Windows poll.
    state = await readTree(join(root, 'tree.json'))
    identities = await captureIdentities(inspector, state)
    await writeFile(join(root, 'proceed'), 'proceed')
    const outcome = await child
    settled = true
    await waitForGone(inspector, identities)
    treeGone = true
    const disposeCounts = trigger === 'dispose'
      ? JSON.parse(await readFile(join(root, 'dispose.json'), 'utf8')) as {
        listenersBefore: number
        listenersAfterLoad: number
        listenersAfterDispose: number
      }
      : undefined
    return { outcome, disposeCounts }
  } finally {
    if (!settled) {
      child.kill('SIGKILL')
      await child.catch(() => {})
    }
    if (!treeGone) {
      cleanupTree(state, identities, inspector)
      if (state !== undefined) await waitForGone(inspector, identities).catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
}

describe('synchronous cleanup on host exit', () => {
  it.each([
    { trigger: 'direct' as const, expectedCode: 23, diagnostic: undefined },
    { trigger: 'uncaught-exception' as const, expectedCode: 1, diagnostic: 'host-exit-uncaught-exception' },
    { trigger: 'unhandled-rejection' as const, expectedCode: 1, diagnostic: 'host-exit-unhandled-rejection' },
  ])('removes an ordinary managed tree after $trigger', { timeout: testTimeoutMs }, async ({
    trigger,
    expectedCode,
    diagnostic,
  }) => {
    const { outcome } = await runScenario('ordinary', trigger)
    expect(outcome.exitCode).toBe(expectedCode)
    expect(outcome.signal).toBeUndefined()
    if (diagnostic !== undefined) expect(outcome.stderr).toContain(diagnostic)
  })

  it.skipIf(process.platform === 'win32')(
    'removes a terminal root and descendant after direct exit',
    { timeout: testTimeoutMs },
    async () => {
      const { outcome } = await runScenario('terminal', 'direct')
      expect(outcome.exitCode).toBe(23)
      expect(outcome.signal).toBeUndefined()
    },
  )

  it('preserves normal terminate-and-join disposal and removes the exit listener', { timeout: testTimeoutMs }, async () => {
    const { outcome, disposeCounts } = await runScenario('ordinary', 'dispose')
    expect(outcome.exitCode).toBe(0)
    expect(disposeCounts?.listenersAfterLoad).toBe((disposeCounts?.listenersBefore ?? 0) + 1)
    expect(disposeCounts?.listenersAfterDispose).toBe(disposeCounts?.listenersBefore)
  })
})

describe('failed-scenario cleanup ownership', () => {
  it('never signals a recycled Windows PID or falls back to bare PID cleanup', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const rawKill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const treeKill = vi.spyOn(spawnModule, 'taskkillProcessTree').mockImplementation(() => {})
    const kills: number[] = []
    const inspector = createWindowsProcessInspector({ snapshot: () => [],
      processState: pid => ({ active: true, started: pid === 123 ? 'recycled' : 'original-child' }),
      taskkill: (pid) => { kills.push(pid) } })
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
      cleanupTree({ root: 123, descendant: 456 }, [
        { pid: 456, started: 'original-child' }, { pid: 123, started: 'original-root' },
      ], inspector)
      expect(kills).toEqual([456])
      expect(treeKill).not.toHaveBeenCalled()
      expect(rawKill).not.toHaveBeenCalled()
      cleanupTree({ root: 123, descendant: 456 }, [], inspector)
      expect(kills).toEqual([456])
      expect(treeKill).not.toHaveBeenCalled()
      expect(rawKill).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
      rawKill.mockRestore()
      treeKill.mockRestore()
    }
  })
})

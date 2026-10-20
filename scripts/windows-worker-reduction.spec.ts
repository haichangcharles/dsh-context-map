/** Fixed native-heap reduction controls; no model or agent calls. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const driver = resolve(root, 'packages/workflow/workflow-worker-thread/tests/fixtures/worker-lifecycle-probe.mjs')
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['DEEPSEEK_API_KEY', 'SILICONFLOW_API_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'JEV_API_KEY', 'OPENAI_BASE_URL'].includes(key)))
environment.TSX_TSCONFIG_PATH = resolve(root, 'tsconfig.base.json')

it.each(['dual-tsx-vm', 'dual-tsx-message', 'esm-tsx-vm'])('reduces normal worker settlement in an independent %s process', async (arm) => {
  expect(existsSync(driver)).toBe(true)
  const args = [...(arm === 'source' ? ['--import', 'tsx/esm'] : []), driver, arm]
  const { stdout } = await execute(process.execPath, args, { cwd: root, env: environment, timeout: 120_000 })
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line) as { arm: string; cycle: number; stage: string; threadId: number })
  expect(rows.every(row => row.arm === arm && Number.isInteger(row.threadId))).toBe(true)
  for (let cycle = 0; cycle < 4; cycle++) expect(rows.filter(row => row.cycle === cycle).map(row => row.stage))
    .toEqual(['spawn', 'online', 'result', 'terminate-start', 'exit', 'terminate-resolve'])
}, 150_000)

it('observes four registered VM timeout settlements without workflow imports', async () => {
  const arm = 'dual-tsx-vm-timeout'
  const { stdout } = await execute(process.execPath, [driver, arm], { cwd: root, env: environment, timeout: 120_000 })
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line) as { arm: string; cycle: number; stage: string; threadId: number; syncTimeoutMs?: number })
  expect(rows).toHaveLength(24)
  expect(rows.every(row => row.arm === arm && Number.isInteger(row.threadId))).toBe(true)
  for (let cycle = 0; cycle < 4; cycle++) {
    expect(rows.filter(row => row.cycle === cycle).map(row => row.stage))
      .toEqual(['spawn', 'online', 'result', 'terminate-start', 'exit', 'terminate-resolve'])
    expect(rows.find(row => row.cycle === cycle && row.stage === 'result')?.syncTimeoutMs).toBe(5000)
  }
}, 150_000)

it('observes a typed module import before the matched VM worker settlement', async () => {
  const arm = 'dual-tsx-typescript'
  const { stdout } = await execute(process.execPath, [driver, arm], { cwd: root, env: environment, timeout: 120_000 })
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line) as { arm: string; cycle: number; stage: string; typedModuleValue?: number })
  expect(rows).toHaveLength(24)
  expect(rows.every(row => row.arm === arm)).toBe(true)
  for (let cycle = 0; cycle < 4; cycle++) {
    expect(rows.filter(row => row.cycle === cycle).map(row => row.stage))
      .toEqual(['spawn', 'online', 'result', 'terminate-start', 'exit', 'terminate-resolve'])
    expect(rows.find(row => row.cycle === cycle && row.stage === 'result')?.typedModuleValue).toBe(42)
  }
}, 150_000)

it('rejects an unknown arm without starting a worker', async () => {
  expect(existsSync(driver)).toBe(true)
  const stderr: unknown = expect.stringContaining('Unknown reduction arm')
  await expect(execute(process.execPath, [driver, 'unknown'], { cwd: root, env: environment, timeout: 10_000 }))
    .rejects.toMatchObject({ code: 1, stdout: '', stderr })
})

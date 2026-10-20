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

it.each(['source', 'plain'])('reduces normal worker settlement in an independent %s process', async (arm) => {
  expect(existsSync(driver)).toBe(true)
  const args = [...(arm === 'source' ? ['--import', 'tsx/esm'] : []), driver, arm]
  const { stdout } = await execute(process.execPath, args, { cwd: root, env: environment, timeout: 120_000 })
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line) as { arm: string; cycle: number; stage: string; threadId: number })
  expect(rows.every(row => row.arm === arm && Number.isInteger(row.threadId))).toBe(true)
  for (let cycle = 0; cycle < 4; cycle++) expect(rows.filter(row => row.cycle === cycle).map(row => row.stage))
    .toEqual(['spawn', 'online', 'result', 'terminate-start', 'exit', 'terminate-resolve'])
}, 150_000)

it('rejects an unknown arm without starting a worker', async () => {
  expect(existsSync(driver)).toBe(true)
  await expect(execute(process.execPath, [driver, 'unknown'], { cwd: root, env: environment, timeout: 10_000 }))
    .rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('Unknown reduction arm') })
})

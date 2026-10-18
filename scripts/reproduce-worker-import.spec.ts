/** Exercise the standalone runtime diagnostic without any provider or project runtime. */
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const script = resolve(import.meta.dirname, 'reproduce-worker-import.mjs')
const env = process.platform === 'win32' ? { TMP: tmpdir(), TEMP: tmpdir() } : {}

it.each(['esm', 'cjs'])('imports and terminates every %s worker before reporting completion', (mode) => {
  const result = spawnSync(process.execPath, [script, mode, '2'], { encoding: 'utf8', env, timeout: 20_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ engineeringFixture: true, mode, iterations: 2, terminated: 2 })
})

it.each([['unknown', '2'], ['cjs', '257'], ['esm', '0']])('refuses an unbounded or unknown diagnostic %s %s', (mode, count) => {
  const result = spawnSync(process.execPath, [script, mode, count], { encoding: 'utf8', env, timeout: 20_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Expected esm|cjs and an iteration count from 1 to 256')
  expect(result.stdout).toBe('')
})

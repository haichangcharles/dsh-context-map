/** Private startup evidence for one explicitly admitted native diagnostic. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const witness = resolve(import.meta.dirname, 'native-image-witness.mjs')
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !['DEEPSEEK_API_KEY', 'SILICONFLOW_API_KEY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY', 'JEV_API_KEY', 'OPENAI_BASE_URL',
    'DSH_NATIVE_IMAGE_WITNESS_CONFIG'].includes(key)))

it.each(['vitest-cli', 'vitest-worker', 'other-node'] as const)('records %s image evidence without changing stdout', async (role) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-witness-'))
  try {
    const output = join(root, 'witness.jsonl')
    const target = join(root, 'entry.mjs')
    await writeFile(target, 'process.stdout.write("unchanged")')
    const config = { output, expectedExecutable: process.execPath,
      cli: role === 'vitest-cli' ? target : join(root, 'cli.mjs'),
      worker: role === 'vitest-worker' ? target : join(root, 'forks.mjs') }
    const { stdout } = await execute(process.execPath, ['--max-old-space-size=512', '--import', pathToFileURL(witness).href, target], {
      env: { ...environment, DSH_NATIVE_IMAGE_WITNESS_CONFIG: JSON.stringify(config) }, timeout: 10_000,
    })
    expect(stdout).toBe('unchanged')
    const rows = (await readFile(output, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown)
    expect(rows).toHaveLength(1)
    const pid: unknown = expect.any(Number)
    expect(rows[0]).toEqual({ kind: 'native-image-start', pid, ppid: process.pid,
      executable: process.execPath, version: process.version, expectedImage: true, role })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('records a different executable as unprotected without changing target success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-witness-'))
  try {
    const output = join(root, 'witness.jsonl')
    const config = { output, expectedExecutable: join(root, 'different.exe'), cli: join(root, 'cli.mjs'), worker: join(root, 'forks.mjs') }
    const { stdout } = await execute(process.execPath, ['--max-old-space-size=512', '--import', pathToFileURL(witness).href, '-e', 'process.stdout.write("unchanged")'], {
      env: { ...environment, DSH_NATIVE_IMAGE_WITNESS_CONFIG: JSON.stringify(config) }, timeout: 10_000,
    })
    expect(stdout).toBe('unchanged')
    expect(JSON.parse(await readFile(output, 'utf8'))).toMatchObject({ expectedImage: false, role: 'other-node' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([undefined, '{}', 'not-json', JSON.stringify({ output: 'relative.jsonl' })])('rejects invalid witness configuration before target execution: %s', async (config) => {
  const stderr: unknown = expect.stringContaining('Native image witness configuration')
  await expect(execute(process.execPath, ['--max-old-space-size=512', '--import', pathToFileURL(witness).href, '-e', 'process.stdout.write("must-not-run")'], {
    env: { ...environment, ...(config === undefined ? {} : { DSH_NATIVE_IMAGE_WITNESS_CONFIG: config }) }, timeout: 10_000,
  })).rejects.toMatchObject({ code: 1, stdout: '', stderr })
})

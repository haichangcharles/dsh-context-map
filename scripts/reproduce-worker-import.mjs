/** Bounded, keyless Node/tsx import diagnostic; no DSH or model code is loaded. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const [mode, rawCount] = process.argv.slice(2)
const iterations = Number(rawCount)
assert(process.argv.length === 4 && ['esm', 'cjs', 'tsx-esm', 'tsx-both'].includes(mode) && Number.isInteger(iterations)
  && iterations > 0 && iterations <= 256, 'Expected esm|cjs|tsx-esm|tsx-both and an iteration count from 1 to 256')
const root = mkdtempSync(join(tmpdir(), 'dsh-node-worker-import-'))
let terminated = 0
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n', { flag: 'wx', mode: 0o600 })
  const tsx = mode.startsWith('tsx-')
  const file = join(root, tsx ? 'fixture.ts' : mode === 'esm' ? 'fixture.mjs' : 'fixture.cjs')
  const source = tsx ? 'export enum Value { Answer = 42 }\nexport const answer = Value.Answer\n'
    : mode === 'esm' ? 'export const answer = 42\n' : 'exports.answer = 42\n'
  writeFileSync(file, source, { flag: 'wx', mode: 0o600 })
  const loader = tsx ? [
    `import { register as registerEsm } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};`,
    ...(mode === 'tsx-both' ? [
      `import { register as registerCjs } from ${JSON.stringify(import.meta.resolve('tsx/cjs/api'))};`,
      'registerCjs();',
    ] : []),
    'registerEsm();',
  ].join('\n') : ''
  const bootstrap = `${loader}\nimport { parentPort } from 'node:worker_threads';
const module = await import(${JSON.stringify(pathToFileURL(file).href)});
if (module.answer !== 42) throw new Error('Imported fixture did not execute');
parentPort.on('message', () => {});
parentPort.postMessage('ready');`
  const entry = new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`)
  const env = process.platform === 'win32' ? { TMP: tmpdir(), TEMP: tmpdir() } : {}
  for (let index = 0; index < iterations; index += 1) {
    const worker = new Worker(entry, { execArgv: [], env })
    let timer
    let ready = false
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('Worker import did not become ready within 10 seconds')) }, 10_000)
        worker.once('error', reject)
        worker.once('exit', code => { reject(new Error(`Worker exited before readiness: ${code}`)) })
        worker.once('message', message => { message === 'ready' ? resolve() : reject(new Error('Unexpected worker readiness message')) })
      })
      ready = true
    } finally {
      clearTimeout(timer)
      const code = await worker.terminate()
      if (ready) assert.equal(code, 1, 'Parked worker must terminate before the next iteration')
    }
    terminated += 1
  }
  console.log(JSON.stringify({ engineeringFixture: true, node: process.version, platform: process.platform, mode, iterations, terminated }))
} finally {
  rmSync(root, { recursive: true, force: true })
}

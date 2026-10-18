/** Verify the opt-in crash diagnostic without modifying the installed Vitest package. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

function diagnosticCode(): string {
  const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/e2e.yml'), 'utf8')) as {
    jobs: Record<string, { steps: { name: string; run?: string; shell?: string }[] }>
  }
  const step = workflow.jobs['runtime-diagnostics']!.steps.find(item => item.name === 'Preserve native worker exit evidence')
  expect(step?.shell).toBe('pwsh')
  const code = step?.run?.match(/@'\n([\s\S]*?)\n'@/)?.[1]
  if (code === undefined) throw new Error('Missing opt-in worker-exit diagnostic')
  return code
}

function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-worker-exit-diagnostic-'))
  const pkg = join(root, 'node_modules/vitest')
  mkdirSync(join(pkg, 'dist/chunks'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'vitest', version: '4.1.8', type: 'module', exports: { './node': './dist/node.js' } }))
  writeFileSync(join(pkg, 'dist/node.js'), 'export {}\n')
  const bundle = join(pkg, 'dist/chunks/cli-api.fixture.js')
  writeFileSync(bundle, body)
  return { root, bundle, close: () => { rmSync(root, { recursive: true, force: true }) } }
}

const original = `export class Runner {
  error;
  _eventEmitter = { emit: (_event, error) => { this.error = error } };
  emitUnexpectedExit = () => {
\t\tconst error = /* @__PURE__ */ new Error("Worker exited unexpectedly");
    this._eventEmitter.emit('error', error);
  };
}
`

it('applies to an isolated copy of the actual locked Vitest bundle', () => {
  const dist = dirname(createRequire(import.meta.url).resolve('vitest/node'))
  const chunks = join(dist, 'chunks')
  const bundle = readdirSync(chunks).find(name => /^cli-api\..+\.js$/.test(name))
  if (bundle === undefined) throw new Error('Installed Vitest bundle missing')
  const source = readFileSync(join(chunks, bundle), 'utf8'), f = fixture(source)
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], { cwd: f.root,
      input: diagnosticCode(), encoding: 'utf8', timeout: 15_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(f.bundle, 'utf8')).toContain('code=${code}, signal=${signal}')
    expect(readFileSync(join(chunks, bundle), 'utf8')).toBe(source)
  } finally { f.close() }
})

it('preserves Windows exit codes and process signals using the upstream diagnostic approach', () => {
  const code = diagnosticCode(), f = fixture(original)
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], { cwd: f.root, input: code, encoding: 'utf8', timeout: 15_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    const inspect = spawnSync(process.execPath, ['--input-type=module'], { cwd: f.root, encoding: 'utf8', timeout: 15_000,
      input: `import assert from 'node:assert/strict';
import { Runner } from './node_modules/vitest/dist/chunks/cli-api.fixture.js';
const runner = new Runner();
runner.emitUnexpectedExit(3221226505, null);
assert.match(runner.error.message, /code=3221226505, signal=null/);
runner.emitUnexpectedExit(null, 'SIGKILL');
assert.match(runner.error.message, /code=null, signal=SIGKILL/);
` })
    expect(inspect.error).toBeUndefined()
    expect(inspect.signal).toBeNull()
    expect(inspect.status, inspect.stderr).toBe(0)
  } finally { f.close() }
})

it('refuses an unexpected handler without rewriting its bundle', () => {
  const code = diagnosticCode(), f = fixture('export const changed = true;\n')
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], { cwd: f.root, input: code, encoding: 'utf8', timeout: 15_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Verify the upstream worker exit handler')
    expect(readFileSync(f.bundle, 'utf8')).toBe('export const changed = true;\n')
  } finally { f.close() }
})

/** Reject debugger successes that lost tests or hid a native/unhandled failure. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const paths = [
  'packages/shell/tool-pwsh/tests/loader.spec.ts',
  'packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts',
  'packages/workflow/tool-ralph/tests/integration.spec.ts',
  'packages/subprocess/subprocess-local/tests/process-exit.spec.ts',
]
const valid = () => ({ success: true, numTotalTests: 68, numPassedTests: 67, numPendingTests: 1,
  numFailedTests: 0, numFailedTestSuites: 0,
  testResults: paths.map(name => ({ name: `D:/a/repo/${name}`, status: 'passed' })),
})

function verify(report: unknown, log = 'Debuggee exited normally', console = 'Vitest finished') {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-debugger-report-'))
  try {
    const json = join(root, 'result.json'), text = join(root, 'debugger.log'), output = join(root, 'console.log')
    writeFileSync(json, JSON.stringify(report)); writeFileSync(text, log); writeFileSync(output, console)
    return spawnSync(process.execPath, [resolve(import.meta.dirname, 'verify-native-debugger-result.mjs'), json, text, output], {
      encoding: 'utf8', timeout: 10_000,
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
}

it('accepts the complete original Windows native inventory', () => {
  const result = verify(valid())
  expect(result.status, result.stderr).toBe(0)
})

it('does not mistake the echoed debugger command for an exception', () => {
  expect(verify(valid(), 'cdb: Reading initial command \'sxd -c2 ".echo DSH_UNHANDLED_NATIVE_EXCEPTION;.exr -1" av;g\'').status).toBe(0)
})

it('rejects an unhandled error captured only in the console stream', () => {
  expect(verify(valid(), 'Debuggee exited normally', 'Vitest caught 1 unhandled error').status).toBe(1)
})

it.each(['DSH_UNHANDLED_NATIVE_EXCEPTION', 'Vitest caught 1 unhandled error', '\u001b[31mUnhandled Errors\u001b[0m'])('rejects %s despite passing JSON', (failure) => {
  expect(verify(valid(), failure).status).toBe(1)
})

it('rejects a lost test even when the JSON success field is true', () => {
  expect(verify({ ...valid(), numPassedTests: 66 }).status).toBe(1)
})

it('rejects a substituted or duplicated file', () => {
  const report = valid(); report.testResults[0] = report.testResults[1]!
  expect(verify(report).status).toBe(1)
})

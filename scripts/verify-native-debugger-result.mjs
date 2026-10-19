/** A debugger exit alone cannot certify the original native test inventory. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const [reportPath, logPath, consolePath] = process.argv.slice(2)
assert(reportPath && logPath && consolePath, 'Expected native JSON report, debugger log and console capture')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const log = [logPath, consolePath].map(path => readFileSync(path, 'utf8')).join('\n').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
assert(!/^\s*DSH_UNHANDLED_NATIVE_EXCEPTION\s*$/m.test(log)
  && !/Vitest caught \d+ unhandled|Unhandled (?:Errors?|Rejections?|Exceptions?)/i.test(log),
  'Native debugger or Vitest reported an unhandled failure')
assert(report.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0, 'Native assertions failed')
assert(report.numTotalTests === 68 && report.numPassedTests === 67 && report.numPendingTests === 1, 'Native test inventory is incomplete')
const expected = [
  'packages/shell/tool-pwsh/tests/loader.spec.ts',
  'packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts',
  'packages/workflow/tool-ralph/tests/integration.spec.ts',
  'packages/subprocess/subprocess-local/tests/process-exit.spec.ts',
]
assert(Array.isArray(report.testResults) && report.testResults.length === expected.length, 'Native file inventory is incomplete')
const names = report.testResults.map(file => {
  assert(file.status === 'passed', 'Native file did not pass')
  return file.name.replaceAll('\\', '/')
})
assert(new Set(names).size === expected.length && expected.every(path => names.some(name => name.endsWith(`/${path}`))),
  'Native file inventory was substituted')
console.log(JSON.stringify({ engineeringFixture: true, nativeFiles: names.length, passed: 67, skipped: 1, nativeDebuggerCapture: true }))

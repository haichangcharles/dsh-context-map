/** Bounded repetition of the unchanged cancellation assertion through Vitest's API. */
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { startVitest } from 'vitest/node'

const ctx = await startVitest('test', ['packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts'], {
  run: true,
  config: fileURLToPath(new URL('./native-worker-repro.config.ts', import.meta.url)),
  testNamePattern: 'a worker death AFTER a cancel reports cancelled, not error',
  maxWorkers: 2,
  fileParallelism: false,
  testTimeout: 90_000,
})
assert(ctx, 'Native diagnostic did not start')
try {
  const tasks = []
  const visit = (items) => {
    for (const item of items) {
      if (item.type === 'suite') visit(item.tasks)
      else if (item.mode !== 'skip' && item.mode !== 'todo') tasks.push(item)
    }
  }
  visit(ctx.state.getFiles())
  assert.equal(tasks.length, 1, 'Expected one executed native cancellation case')
  assert.equal(tasks[0].result?.state, 'pass', 'Native cancellation did not pass')
  assert.equal(tasks[0].result?.repeatCount, 31, 'Native cancellation did not execute all 32 repetitions')
  assert.equal(ctx.state.getUnhandledErrors().length, 0, 'Native diagnostic has unhandled errors')
  console.log(JSON.stringify({ engineeringFixture: true, nativeCancellationExecutions: 32, selectedTests: 1, repeatCount: 31 }))
} finally {
  await ctx.close()
}

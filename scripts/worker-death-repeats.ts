/** Opt-in Vitest repetition of the unchanged native cancellation case, never a retry. */
import assert from 'node:assert/strict'
import type { RunnerTask, RunnerTestCase, RunnerTestFile } from 'vitest'
import { VitestTestRunner } from 'vitest/runners'

/** Exact owning case; renaming it must not create a zero-match diagnostic success. */
export const WORKER_DEATH_CASE = 'a worker death AFTER a cancel reports cancelled, not error'

/**
 * Configure one existing case for 32 executions using Vitest's repetition mechanism.
 * @param files - collected native test files.
 */
export function repeatWorkerDeathCase(files: readonly RunnerTestFile[]): void {
  const selected: RunnerTestCase[] = []
  const visit = (tasks: readonly RunnerTask[]): void => {
    for (const task of tasks) {
      if (task.type === 'suite') visit(task.tasks)
      else if (task.name === WORKER_DEATH_CASE) selected.push(task)
    }
  }
  visit(files)
  assert(selected.length === 1 && selected[0] !== undefined, 'Expected exactly one native cancellation case')
  selected[0].repeats = 31
  selected[0].retry = 0
}

/** Preserve Vitest's normal assertion lifecycle and expose each diagnostic execution. */
export default class WorkerDeathRepeatRunner extends VitestTestRunner {
  /** @param files - collected files from the manually selected native test. */
  onCollected(files: RunnerTestFile[]): void {
    repeatWorkerDeathCase(files)
  }

}

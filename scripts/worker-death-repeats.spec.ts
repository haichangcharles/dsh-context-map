/** The diagnostic must preserve the selected assertions and refuse a missing case. */
import type { RunnerTestFile, RunnerTestCase } from 'vitest'
import { expect, it } from 'vitest'
import { repeatWorkerDeathCase, WORKER_DEATH_CASE } from './worker-death-repeats.ts'

function collection(names: string[]) {
  const tests = names.map(name => ({ type: 'test', name, repeats: 0 }) as RunnerTestCase)
  const files = [{ type: 'suite', tasks: tests }] as unknown as RunnerTestFile[]
  return { tests, files }
}

it('repeats only the existing cancellation case with no assertion changes', () => {
  const { tests, files } = collection(['other', WORKER_DEATH_CASE])
  repeatWorkerDeathCase(files)
  expect(tests.map(test => test.repeats)).toEqual([0, 31])
  expect(tests[1]?.retry).toBe(0)
})

it.each([{ names: [] }, { names: ['renamed'] }, { names: [WORKER_DEATH_CASE, WORKER_DEATH_CASE] }])('rejects a missing or ambiguous target $names', ({ names }) => {
  const { tests, files } = collection(names)
  expect(() => { repeatWorkerDeathCase(files) }).toThrow('Expected exactly one native cancellation case')
  expect(tests.every(test => test.repeats === 0)).toBe(true)
})

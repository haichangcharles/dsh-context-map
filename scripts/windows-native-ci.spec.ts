/** Keep required native crash evidence from weakening its original keyless verdict. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8')
it('keeps crash capture hosted-only and all model credentials empty', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { env: Record<string, string>
      steps: { name?: string; if?: string; run?: string; env?: Record<string, string> }[] }>
  }
  const job = workflow.jobs['windows-native-tests']!
  for (const key of ['DEEPSEEK_API_KEY', 'SILICONFLOW_API_KEY', 'TYPESAFE_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY']) expect(job.env[key]).toBe('')
  expect(job.steps.find(s => s.name === 'Verify crash-capture registry restoration')?.if).toBe("runner.environment == 'github-hosted'")
  const run = job.steps.find(s => s.name === 'Run Windows-specific native tests')!
  expect(run.env?.DSH_EPHEMERAL_NATIVE_CAPTURE).toBe("${{ runner.environment == 'github-hosted' && '1' || '0' }}")
  expect(run.run).toContain('./scripts/run-windows-native.ps1 -CaptureCrash:')
})

it('retains the original single invocation and propagates its failure', () => {
  const wrapper = read('scripts/run-windows-native.ps1')
  const command = wrapper.match(/& pnpm exec vitest run([\s\S]*?)\| Out-Host/)?.[1]?.replace(/`/g, '').trim().split(/\s+/)
  expect(command).toEqual(['--no-file-parallelism', '--testTimeout', '90000',
    'packages/shell/tool-pwsh/tests/loader.spec.ts',
    'packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts',
    'packages/workflow/tool-ralph/tests/integration.spec.ts',
    'packages/subprocess/subprocess-local/tests/process-exit.spec.ts'])
  expect(wrapper.match(/& pnpm exec/g)).toHaveLength(1)
  expect(wrapper).toContain('return $LASTEXITCODE')
  expect(wrapper).toContain('if ($nativeExitCode -ne 0) { throw')
  expect(wrapper).toContain("if ($env:DSH_EPHEMERAL_NATIVE_CAPTURE -cne '1') { throw")
})

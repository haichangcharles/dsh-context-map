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
  expect(command).toEqual(['--no-file-parallelism', '--testTimeout', '90000', '--reporter=default', '--reporter=json', '"--outputFile.json=$nativeReport"',
    'packages/shell/tool-pwsh/tests/loader.spec.ts',
    'packages/workflow/workflow-worker-thread/tests/workflow-worker-thread.spec.ts',
    'packages/workflow/tool-ralph/tests/integration.spec.ts',
    'packages/subprocess/subprocess-local/tests/process-exit.spec.ts'])
  expect(wrapper.match(/& pnpm exec/g)).toHaveLength(1)
  expect(wrapper).toContain('return $LASTEXITCODE')
  expect(wrapper).toContain('if ($nativeExitCode -ne 0) { throw')
  expect(wrapper).toContain("if ($env:DSH_EPHEMERAL_NATIVE_CAPTURE -cne '1') { throw")
})

it('captures the original coverage command without narrowing its partitions or ignoring a worker crash', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { env: Record<string, string>; steps: { name?: string; run?: string }[] }>
  }
  const job = workflow.jobs['windows-coverage']!
  for (const key of ['DEEPSEEK_API_KEY', 'SILICONFLOW_API_KEY', 'TYPESAFE_API_KEY', 'JEV_API_KEY', 'OPENAI_API_KEY']) expect(job.env[key]).toBe('')
  expect(job.steps.find(step => step.name === 'Run Windows coverage')?.run).toContain('-Lane coverage -CaptureCrash:')
  const wrapper = read('scripts/run-windows-native.ps1')
  expect(wrapper).toContain("[ValidateSet('native', 'coverage')]")
  expect(wrapper).toContain('pnpm run check:ci:coverage | Out-Host')
  expect(wrapper.match(/pnpm run check:ci:coverage/g)).toHaveLength(1)
  expect(wrapper).toContain("if ($Lane -eq 'coverage')")
  expect(wrapper).toContain('required-$Lane-crash.log')
})

it('records owned OS exit metadata without instrumenting or retrying the original command', () => {
  const wrapper = read('scripts/run-windows-native.ps1')
  expect(wrapper).toContain('Invoke-WithProcessExitEvidence { Invoke-OriginalWindowsCheck }')
  const observer = read('scripts/windows-process-exit-evidence.ps1')
  expect(observer).toContain('Win32_ProcessStartTrace')
  expect(observer).toContain('Win32_ProcessStopTrace')
  expect(observer).toContain('Unregister-Event')
  expect(observer).toContain('Remove-Event')
  expect(observer).toContain('BestEffort = $true')
  expect(observer).not.toMatch(/CommandLine|EnvironmentVariables|Start-Sleep|NODE_OPTIONS|Invoke-Expression/)
  const workflow = read('.github/workflows/ci.yml')
  expect(workflow).toContain('./scripts/windows-process-exit-evidence.ps1 -SelfTest')
})


it('retains failure-only Windows partition reports without retrying the coverage command', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps: { name?: string; if?: string; uses?: string; with?: Record<string, unknown> }[] }>
  }
  const step = workflow.jobs['windows-coverage']!.steps.find(s => s.name === 'Retain Windows coverage failure reports')
  expect(step?.if).toBe('failure()')
  expect(step?.uses).toBe('actions/upload-artifact@v4')
  expect(step?.with?.['retention-days']).toBe(3)
  expect(step?.with?.['include-hidden-files']).toBe(true)
  expect(step?.with?.path).toBe([
    'coverage/.partitioned/partition-*.report.json',
    '${{ runner.temp }}/required-coverage-crash.log',
  ].join('\n') + '\n')
})


it('retains failure-only native test state when a fork cannot report every case', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps: { name?: string; if?: string; uses?: string; with?: Record<string, unknown> }[] }>
  }
  const step = workflow.jobs['windows-native-tests']!.steps.find(s => s.name === 'Retain Windows native failure reports')
  expect(step?.if).toBe('failure()')
  expect(step?.uses).toBe('actions/upload-artifact@v4')
  expect(step?.with?.['retention-days']).toBe(3)
  expect(step?.with?.path).toBe([
    '${{ runner.temp }}/required-native-report.json',
    '${{ runner.temp }}/required-native-crash.log',
    '${{ runner.temp }}/worker-reduction-*',
  ].join('\n') + '\n')
  expect(read('scripts/run-windows-native.ps1')).toContain("$nativeReport = Join-Path $env:RUNNER_TEMP 'required-native-report.json'")
})


it('starts the native inventory under CDB and preserves the original result independently', () => {
  const live = read('scripts/native-live-debugger.ps1')
  expect(live).toContain("'-o', '-G'")
  expect(live).not.toContain("'-o', '-g', '-G'")
  expect(live).toContain('sxi ibp')
  expect(live).toContain('DSH_NATIVE_BREAKPOINT')
  expect(live).toContain('DSH_NATIVE_FILTERS_READY')
  expect(live).toContain("$arguments -ccontains '-g'")
  expect(live).toContain('detected heap corruption')
  expect(live).toContain('captured a verifier stop')
  expect(live).toContain("'VERIFIER STOP 00000008:")
  expect(live).toContain('DSH_FIRST_CHANCE_AV')
  expect(live).toContain('-c2')
  expect(live).toContain('.exr -1;.ecxr;kv 32')
  expect(live).toContain('gn')
  expect(live).toContain('Missing original native check result')
  expect(live).toContain('return [int] $result.exitCode')
  expect(live).not.toContain('.jdinfo')
  expect(read('scripts/run-windows-native.ps1')).toContain('Invoke-NativeLiveDebugger')
  expect(read('.github/workflows/ci.yml')).toContain('./scripts/native-live-debugger.ps1 -SelfTest')
})

it('runs a bounded worker reduction only after an actual required native failure', () => {
  const workflow = yaml.load(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, { steps: { name?: string; id?: string; if?: string; run?: string; 'timeout-minutes'?: number; with?: { path?: string } }[] }>
  }
  const steps = workflow.jobs['windows-native-tests']!.steps
  expect(steps.find(step => step.name === 'Run Windows-specific native tests')?.id).toBe('native-check')
  const probe = steps.find(step => step.name === 'Reduce the failing native worker lifecycle')
  expect(probe?.if).toBe("failure() && runner.environment == 'github-hosted' && steps.native-check.outcome == 'failure'")
  expect(probe?.run).toBe('./scripts/run-windows-worker-reduction.ps1')
  expect(probe?.['timeout-minutes']).toBe(12)
  const wrapper = read('scripts/run-windows-worker-reduction.ps1')
  expect(wrapper).toContain("@('source')")
  expect(wrapper).toContain('Invoke-NativeLiveDebugger')
  expect(wrapper).toContain('WaitForExit(150000)')
  expect(wrapper).toContain('Unclosed native diagnostic process: timeout')
  expect(wrapper).toContain('if ($ownership.unconfirmed)')
  expect(wrapper).toContain('.GetNewClosure()')
  expect(wrapper).toContain('.Kill($true)')
  expect(wrapper).toContain('[System.IO.FileMode]::CreateNew')
  expect(wrapper).not.toContain('pnpm run build:lib:host')
  expect(wrapper.indexOf('$rows =')).toBeLessThan(wrapper.indexOf('$tools ='))
  expect(wrapper.indexOf('try {')).toBeLessThan(wrapper.indexOf('$tools ='))
  expect(steps.find(step => step.name === 'Retain Windows native failure reports')?.with?.path).toContain('worker-reduction-*')
})


it('limits full PageHeap to an exclusively owned private image and verifies restoration', () => {
  const wrapper = read('scripts/run-windows-worker-reduction.ps1')
  expect(wrapper).toContain("'dsh-worker-probe-' + [guid]::NewGuid().ToString('N') + '.exe'")
  expect(wrapper).toContain('Copy-Item -LiteralPath $node -Destination $probeNode')
  expect(wrapper).toContain('Invoke-WithOwnedPageHeap')
  expect(wrapper).toContain("'/p' '/enable' $imageName '/full'")
  expect(wrapper).toContain("'/p' '/disable' $imageName")
  expect(wrapper).toContain('full traces')
  expect(wrapper).not.toContain("'/enable', 'node.exe'")
  const helper = read('scripts/native-pageheap-image.ps1')
  expect(helper).toContain('Owned PageHeap image key already exists')
  expect(helper.indexOf('Owned PageHeap image key already exists')).toBeLessThan(helper.indexOf('try {'))
  expect(helper).toContain('DeleteSubKeyTree($path, $false)')
  expect(helper).toContain('Owned PageHeap image key was not removed')
  expect(read('.github/workflows/ci.yml')).toContain('./scripts/native-pageheap-image.ps1 -SelfTest')
})

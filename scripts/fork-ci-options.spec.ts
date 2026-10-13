import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { COVERAGE_PARTITIONS_ENV, parseCoveragePartitionCount } from './coverage-partitions.ts'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
interface Step { name?: string; id?: string; if?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { if?: string; 'runs-on'?: string; env?: Record<string, string>; steps?: Step[] }
interface Workflow { jobs: Record<string, Job> }
function workflow(name: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', name), 'utf8')) as Workflow
}
function expression(source: string, vars: Record<string, string>): unknown {
  return runInNewContext(source.trim().replace(/^\$\{\{|\}\}$/g, ''), {
    vars, fromJSON: JSON.parse, github: { repository: 'local/project',
      event_name: 'pull_request', ref: 'refs/heads/master',
      event: { pull_request: { user: { login: 'owner' } } } },
  }, { timeout: 1000 }) as unknown
}
async function configuration(script: string, changes: Record<string, string>, project = false): Promise<{
  output: string
  summary: string
  stdout: string
  stderr: string
  code: number
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ci-options-'))
  const output = join(directory, 'output')
  const summary = join(directory, 'summary')
  try {
    await Promise.all([writeFile(output, ''), writeFile(summary, '')])
    if (project) {
      await mkdir(join(directory, '.github/issue-management'), { recursive: true })
      await writeFile(join(directory, '.github/issue-management/config.json'),
        JSON.stringify({ organization: 'local', repository: 'project' }))
    }
    let stdout = '', stderr = '', code = 0
    try {
      const result = await execute('bash', ['-e', '-c', script], { cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
          TRUSTED_PR: 'true', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '',
          CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '', APP_CLIENT_ID: '', APP_PRIVATE_KEY: '',
          GITHUB_REPOSITORY: 'local/project', ...changes } })
      stdout = result.stdout; stderr = result.stderr
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; code: number }
      stdout = failure.stdout; stderr = failure.stderr; code = failure.code
    }
    return { output: await readFile(output, 'utf8'), summary: await readFile(summary, 'utf8'), stdout, stderr, code }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('portable CI runner and optional integrations', () => {
  it.each(['node-24-coverage', 'windows-coverage'])('%s supplies a valid coordinator partition count', (name) => {
    const value = workflow('ci.yml').jobs[name]?.env?.[COVERAGE_PARTITIONS_ENV]
    if (value === undefined) throw new Error('Coverage partition expression is missing')
    const defaults = { DSH_CI_FAILOVER_LINUX: '', DSH_CI_FAILOVER_WINDOWS: '',
      DSH_CI_LINUX_RUNNER: '', DSH_CI_WINDOWS_RUNNER: '' }
    for (const changes of [{}, { DSH_CI_LINUX_RUNNER: 'larger-linux', DSH_CI_WINDOWS_RUNNER: 'larger-windows' },
      { DSH_CI_FAILOVER_LINUX: 'selfhosted', DSH_CI_FAILOVER_WINDOWS: 'selfhosted' }]) {
      const selected = expression(value, { ...defaults, ...changes })
      expect(typeof selected).toBe('string')
      expect(parseCoveragePartitionCount(String(selected))).toBeGreaterThanOrEqual(2)
    }
  })

  it.each([
    { source: 'local/project', fork: true, trusted: true },
    { source: 'local/project', fork: false, trusted: true },
    { source: 'outside/project', fork: true, trusted: false },
    { source: 'outside/project', fork: false, trusted: false },
  ])('checks repository identity for $source (fork=$fork)', ({ source, fork, trusted }) => {
    const guard = workflow('build-preview-cloudflare.yml').jobs.preview?.steps
      ?.find(step => step.id === 'deployment')?.env?.TRUSTED_PR
    if (guard === undefined) throw new Error('Preview trust guard is missing')
    const result: unknown = runInNewContext(guard.trim().replace(/^\$\{\{|\}\}$/g, ''), {
      github: { repository: 'local/project', event: { pull_request: { head: { repo: { full_name: source, fork } } } } },
    }, { timeout: 1000 })
    expect(result).toBe(trusted)
  })

  it('runs all required Linux and Windows checks on ordinary hosted runners by default', () => {
    const jobs = workflow('ci.yml').jobs
    const vars = { DSH_CI_FAILOVER_LINUX: '', DSH_CI_FAILOVER_WINDOWS: '',
      DSH_CI_LINUX_RUNNER: '', DSH_CI_WINDOWS_RUNNER: '' }
    for (const name of ['node-24', 'node-24-coverage', 'node-24-consumers']) {
      expect(expression(jobs[name]!['runs-on']!, vars)).toBe('ubuntu-24.04')
    }
    for (const name of ['windows-build', 'windows-coverage', 'windows-native-tests', 'windows-observational']) {
      expect(expression(jobs[name]!['runs-on']!, vars)).toBe('windows-2025')
    }
    expect(expression(jobs['node-24-coverage']!.env!.DSH_COVERAGE_MAX_WORKERS!, vars)).toBe('2')
    expect(expression(jobs['node-24-coverage']!.env!.DSH_COVERAGE_PARTITIONS!, vars)).toBe('2')
    expect(expression(jobs['node-24-consumers']!.env!.DSH_WEB_SNAPSHOT_WORKERS!, vars)).toBe('2')
    expect(expression(jobs['node-24']!['runs-on']!, { ...vars, DSH_CI_LINUX_RUNNER: 'larger-linux' }))
      .toBe('larger-linux')
    expect(expression(jobs['windows-build']!['runs-on']!, { ...vars, DSH_CI_WINDOWS_RUNNER: 'larger-windows' }))
      .toBe('larger-windows')
  })

  it('preserves preview build artifacts and gates every external publication step', () => {
    const preview = workflow('build-preview-cloudflare.yml').jobs.preview!
    expect(preview.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run build' }))
    const artifact = preview.steps?.find(step => step.name === 'Preserve the built preview artifact')
    expect(artifact).toBeDefined()
    expect(artifact?.with).toMatchObject({ 'if-no-files-found': 'error' })
    for (const name of ['Upload to Cloudflare Pages', 'Verify the protected deployment serves the image', 'Comment the preview URL']) {
      expect(preview.steps?.find(step => step.name === name)?.if).toBe("steps.deployment.outputs.enabled == 'true'")
    }
  })

  it('keeps local policy implementation tests even without a repository Project integration', () => {
    for (const name of ['issue-policy.yml', 'issue-lifecycle.yml']) {
      const job = Object.values(workflow(name).jobs)[0]!
      expect(job.if).toBeUndefined()
      expect(job.steps).toContainEqual(expect.objectContaining({ run: 'node --test .github/issue-management/policy.test.mjs' }))
      expect(job.steps?.filter(step => step.name?.startsWith('Create ')).every(step =>
        step.if?.includes("steps.project.outputs.enabled == 'true'"))).toBe(true)
    }
  })
})

// Workflow preparation is POSIX shell code; Windows CI retains its static checks above.
describe.skipIf(process.platform === 'win32')('integration configuration execution', () => {
  it('builds without publication when unconfigured or untrusted, and fails on partial Cloudflare setup', async () => {
    const script = workflow('build-preview-cloudflare.yml').jobs.preview!.steps!
      .find(step => step.id === 'deployment')!.run!
    const absent = await configuration(script, {})
    expect(absent).toMatchObject({ output: 'enabled=false\n', code: 0 })
    expect(absent.summary).toContain('not configured')
    const untrusted = await configuration(script, { TRUSTED_PR: 'false' })
    expect(untrusted).toMatchObject({ output: 'enabled=false\n', code: 0 })
    expect(untrusted.summary).toContain('fork PR')
    const partial = await configuration(script, { CLOUDFLARE_API_TOKEN: 'fixture-token' })
    expect(partial.code).toBe(1)
    expect(partial.output).toBe('')
    const configured = await configuration(script, { CLOUDFLARE_API_TOKEN: 'fixture-token',
      CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CF_ACCESS_CLIENT_ID: 'fixture-client', CF_ACCESS_CLIENT_SECRET: 'fixture-private' })
    expect(configured).toMatchObject({ output: 'enabled=true\n', code: 0 })
    expect(configured.stdout + configured.stderr).not.toContain('fixture-private')
  })

  it.each(['issue-policy.yml', 'issue-lifecycle.yml'])('%s authorizes only a matching fully configured Project', async (name) => {
    const script = Object.values(workflow(name).jobs)[0]!.steps!.find(step => step.id === 'project')!.run!
    expect(await configuration(script, {}, true)).toMatchObject({ output: 'enabled=false\n', code: 0 })
    expect(await configuration(script, { APP_CLIENT_ID: 'fixture-client' }, true)).toMatchObject({ code: 1 })
    const configured = await configuration(script, { APP_CLIENT_ID: 'fixture-client', APP_PRIVATE_KEY: 'fixture-private' }, true)
    expect(configured).toMatchObject({ output: 'enabled=true\n', code: 0 })
    expect(configured.stdout + configured.stderr).not.toContain('fixture-private')
    expect(await configuration(script, { GITHUB_REPOSITORY: 'another/fork',
      APP_CLIENT_ID: 'fixture-client', APP_PRIVATE_KEY: 'fixture-private' }, true))
      .toMatchObject({ output: 'enabled=false\n', code: 0 })
  })
})

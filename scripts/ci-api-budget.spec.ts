import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
interface Step { name?: string; if?: string; run?: string; env?: Record<string, unknown> }
interface Job { if?: string; steps?: Step[]; secrets?: unknown; with?: Record<string, unknown> }
interface Workflow { on: Record<string, unknown>; jobs: Record<string, Job> }
function workflow(name: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', name), 'utf8')) as Workflow
}
function permits(expression: string | undefined, event: string, realApi: boolean, runtimeDiagnostics = false): boolean {
  if (expression === undefined) return true
  return runInNewContext(expression.trim().replace(/^\$\{\{|\}\}$/g, ''), {
    github: { event_name: event }, inputs: { real_api: realApi, runtime_diagnostics: runtimeDiagnostics }, runner: { os: 'Linux' },
  }, { timeout: 1000 }) as boolean
}
function assertManualCostOnly(condition: string | undefined): void {
  for (const event of ['push', 'pull_request', 'schedule', 'workflow_call']) {
    expect(permits(condition, event, false)).toBe(false)
    expect(permits(condition, event, true)).toBe(false)
  }
  expect(permits(condition, 'workflow_dispatch', false)).toBe(false)
  expect(permits(condition, 'workflow_dispatch', true)).toBe(true)
}

describe('CI model API budget', () => {
  it('runs full keyless replay on ordinary PR and push events and keeps real APIs opt-in', () => {
    const e2e = workflow('e2e.yml')
    expect(Object.keys(e2e.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect((e2e.on.workflow_dispatch as { inputs: unknown }).inputs).toMatchObject({
      real_api: { type: 'boolean', default: false },
    })
    const keyless = e2e.jobs.e2e!
    for (const event of ['pull_request', 'push']) {
      for (const diagnostics of [false, true]) {
        expect(permits(keyless.if, event, false, diagnostics)).toBe(true)
      }
    }
    expect(permits(keyless.if, 'workflow_dispatch', false)).toBe(true)
    expect(permits(keyless.if, 'workflow_dispatch', false, true)).toBe(false)
    expect(JSON.stringify(keyless)).not.toContain('secrets.')
    expect(keyless.steps).toContainEqual(expect.objectContaining({ env: { DSH_SNAPSHOT: 'replay' }, run: 'pnpm run test:snapshot' }))
    expect(keyless.steps).toContainEqual(expect.objectContaining({
      env: { DSH_SNAPSHOT: 'replay' }, run: 'pnpm run test:web:built',
    }))
    assertManualCostOnly(e2e.jobs['real-api']?.if)
    assertManualCostOnly(e2e.jobs['python-real-api']?.if)
  })

  it('isolates explicit native diagnostics from ordinary replay and all provider credentials', () => {
    const e2e = workflow('e2e.yml')
    expect((e2e.on.workflow_dispatch as { inputs: unknown }).inputs).toMatchObject({
      runtime_diagnostics: { type: 'boolean', default: false },
    })
    const diagnostic = e2e.jobs['runtime-diagnostics']!
    for (const event of ['pull_request', 'push', 'workflow_call', 'schedule']) {
      expect(permits(diagnostic.if, event, false, true)).toBe(false)
    }
    expect(permits(diagnostic.if, 'workflow_dispatch', false)).toBe(false)
    expect(permits(diagnostic.if, 'workflow_dispatch', false, true)).toBe(true)
    expect(JSON.stringify(diagnostic)).not.toContain('secrets.')
    expect(diagnostic).toMatchObject({
      env: { DEEPSEEK_API_KEY: '', SILICONFLOW_API_KEY: '', OPENAI_API_KEY: '', TYPESAFE_API_KEY: '', JEV_API_KEY: '' },
    })
    const selected = diagnostic.steps!.find(step => step.run?.includes('--testTimeout=90000 --coverage'))
    expect(selected?.env).toEqual({ DSH_COVERAGE_PARTITION_MODE: '1' })
    expect(diagnostic.steps!.some(step => step.run?.includes('tests/sandbox.spec.ts'))).toBe(true)
    expect(diagnostic.steps!.some(step => step.run?.includes('tests/local.spec.ts'))).toBe(true)
  })

  it('never passes a model credential or opt-in into automatic Python runtime CI', () => {
    for (const name of ['ci.yml', 'ci-master.yml', 'python-release.yml']) {
      const calls = Object.values(workflow(name).jobs).filter(job => job.with?.targets !== undefined)
      expect(calls.length).toBeGreaterThan(0)
      for (const job of calls) {
        expect(job.secrets).toBeUndefined()
        expect(job.with?.real_api).not.toBe(true)
      }
    }
    const builder = workflow('build-exe-for-python-sdk.yml')
    for (const event of ['workflow_call', 'workflow_dispatch']) {
      expect((builder.on[event] as { inputs: unknown }).inputs).toMatchObject({
        real_api: { type: 'boolean', default: false },
      })
    }
    const live = builder.jobs.build!.steps!.filter(step => JSON.stringify(step.env ?? {}).includes('DEEPSEEK_API_KEY'))
    expect(live).toHaveLength(4)
    for (const step of live) {
      assertManualCostOnly(step.if?.replace(/&& runner\.os (?:==|!=) 'Windows'/g, ''))
    }
    expect(builder.jobs.build!.steps!.filter(step => step.name?.includes('keyless black-box'))).toHaveLength(2)
  })

  it('keeps provider and E2B spending workflows manual-only and checks the complete workflow corpus', () => {
    const names = readdirSync(resolve(root, '.github/workflows')).filter(name => name.endsWith('.yml'))
    expect(names.length).toBeGreaterThanOrEqual(20)
    const credentialWorkflows = names.filter(name =>
      /secrets\.(?:DEEPSEEK_API_KEY_EXTERNAL|AZURE_OPENAI_API_KEY_EXTERNAL|ANTHROPIC_API_KEY_EXTERNAL|E2B_API_KEY_EXTERNAL)/
        .test(JSON.stringify(workflow(name))))
    expect(credentialWorkflows.sort()).toEqual([
      'build-exe-for-python-sdk.yml', 'e2b-e2e.yml', 'e2e.yml', 'pi-ai-provider-e2e.yml',
    ])
    for (const name of ['pi-ai-provider-e2e.yml', 'e2b-e2e.yml']) {
      expect(Object.keys(workflow(name).on)).toEqual(['workflow_dispatch'])
    }
  })

  it('rejects an unconditional secret-bearing job or a missing explicit spending switch', () => {
    expect(() => { assertManualCostOnly(undefined) }).toThrow()
    expect(() => { assertManualCostOnly("github.event_name == 'workflow_dispatch'") }).toThrow()
    expect(() => { assertManualCostOnly('inputs.real_api') }).toThrow()
  })
})

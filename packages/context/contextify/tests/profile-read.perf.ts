/** Package-local source-plane characterization; no CI latency threshold or model requests. */
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, it, vi } from 'vitest'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { lineageHarness } from './lineage-coverage-harness.ts'
import { projectSessionFamily } from '../src/family.ts'
import { contextPolicyWatermarks } from '../src/policy-memory.ts'
import { scopePolicyExamplesFromInspections } from '../src/scope-policy.ts'

const SHAPES = [[1, 40], [1, 400], [8, 40], [8, 400]] as const
const WARM_READS = 5
const require = createRequire(import.meta.url)
const vitestPackage = JSON.parse(readFileSync(require.resolve('vitest/package.json'), 'utf8')) as { version: string }

function median(samples: readonly number[]) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!
}
function timed<T>(operation: () => T) {
  const started = performance.now()
  const value = operation()
  return { value, ms: performance.now() - started }
}
function fill(session: Session, messages: number) {
  for (let index = 0; index < messages / 2; index++) {
    const turn = index + 1
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({ source: { kind: 'user' },
      content: [{ type: 'text', text: `Engineering context message ${turn}.` }] }), { surfaceOp: 'append' })
    session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({
      source: { provider: 'fixture', model: 'keyless' }, content: [{ type: 'text', text: 'Engineering response.' }],
    }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

it('characterizes fixed native Profile reads and existing pure components before optimization', async () => {
  const all = []
  for (const [families, messages] of SHAPES) {
    const preparedAt = performance.now()
    const b = await lineageHarness()
    let restoreSpies = () => {}
    try {
      const agents = [b.parent]
      for (let index = 1; index < families; index++) agents.push((await b.ctx.agents.create({
        sessionId: SessionId(`profile-perf-${index}`), meta: { cwd: b.parent.session.header.cwd! },
        agentOptions: { provider: 'mock', model: 'mock' },
      })).agent)
      for (const agent of agents) fill(agent.session, messages)
      for (const agent of agents) await b.ctx.sessions.flush(agent.session)
      const inspections = agents.map(agent => ({ meta: agent.session.header,
        inheritedEventCount: agent.session.inheritedEventCount, events: agent.session.snapshotEvents() }))
      const currentFamily = inspections.filter(item => item.meta.id === b.parent.id)
      expect(currentFamily).toHaveLength(1)
      const cursors = agents.map(agent => agent.session.seq)
      const preparedMs = performance.now() - preparedAt
      const list = vi.spyOn(b.ctx.sessionPersistence, 'list')
      const open = vi.spyOn(b.ctx.sessionPersistence, 'open')
      restoreSpies = () => { list.mockRestore(); open.mockRestore() }
      const samples = []
      for (let ordinal = 0; ordinal <= WARM_READS; ordinal++) {
        const listsBefore = list.mock.calls.length, readsBefore = open.mock.calls.length
        const started = performance.now()
        const profile = await b.ctx.contextify.stewardProfile(b.parent)
        const fullMs = performance.now() - started
        const catalogCalls = list.mock.calls.length - listsBefore
        const openCalls = open.mock.calls.length - readsBefore
        const policy = timed(() => scopePolicyExamplesFromInspections(inspections, contextPolicyWatermarks(inspections)))
        const graph = timed(() => projectSessionFamily({ activeSessionId: b.parent.id, sessions: currentFamily }))
        expect(profile.scopePolicyExamples).toEqual([])
        expect(policy.value).toEqual(profile.scopePolicyExamples)
        expect(graph.value.nodes).toHaveLength(messages)
        samples.push({ ordinal, cache: ordinal === 0 ? 'first' : 'warm', fullMs,
          policyMs: policy.ms, graphMs: graph.ms, catalogCalls, openCalls, caseCount: policy.value.length })
      }
      expect(agents.map(agent => agent.session.seq)).toEqual(cursors)
      expect(b.adapter.requests).toHaveLength(0)
      const warm = samples.slice(1)
      const fullMs = median(warm.map(item => item.fullMs))
      const policyMs = median(warm.map(item => item.policyMs))
      const graphMs = median(warm.map(item => item.graphMs))
      const row = { families, messagesPerFamily: messages, rawEventCount: inspections.reduce((sum, item) => sum + item.events.length, 0),
        preparedMs, samples, warmMedian: { fullMs, policyMs, graphMs },
        standaloneRatios: { policy: policyMs / fullMs, graph: graphMs / fullMs }, heapUsedBytes: process.memoryUsage().heapUsed }
      all.push(row)
      console.log('CONTEXT_PROFILE_SHAPE ' + JSON.stringify(row))
    } finally {
      restoreSpies()
      await b.close()
    }
  }
  expect(all).toHaveLength(SHAPES.length)
  const largest = all.at(-1)!
  const ratios = largest.standaloneRatios
  const candidate = ratios.policy >= ratios.graph ? 'policy/reset' : 'current-family-graph'
  const material = largest.warmMedian.fullMs >= 1 && Math.max(ratios.policy, ratios.graph) >= .2
  const sources = ['index.ts', 'scope-policy.ts', 'policy-memory.ts', 'family.ts'].map(file => ({
    path: `packages/context/contextify/src/${file}`,
    sha256: createHash('sha256').update(readFileSync(new URL(`../src/${file}`, import.meta.url))).digest('hex'),
  }))
  console.log('CONTEXT_PROFILE_RESULT ' + JSON.stringify({ kind: 'engineering-source-profile-characterization-v1',
    node: process.version, vitest: vitestPackage.version, plane: 'Vitest source; not built-product latency',
    firstRead: 'first Profile cache read, not cold OS/JIT/deployment',
    samplingOrder: 'each fresh shape in declared order; full Profile, pure policy/reset, pure current-family graph; first plus five warm',
    workload: 'live standalone native families; no personal choice examples or inference',
    preparation: 'native persistence flush completed before sampling; preparation reported separately',
    counters: 'persistence list/open invocations; not bytes read or in-memory history access counts',
    standaloneRatios: 'approximate screening ratios, not exclusive CPU attribution',
    samplesPerSurface: all.reduce((sum, row) => sum + row.samples.length, 0),
    externalModelRequests: 0, sources, shapes: all, material, candidate: material ? candidate : null }))
}, 120_000)

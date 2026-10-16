import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as planner from '../src/route-plan.ts'
import type { ContextFamilyGraph, ContextRouteAdvice } from '../src/types.ts'

const main = SessionId('main'), active = SessionId('draft'), parked = SessionId('parked')
const graph = { activeSessionId: active, rootSessionId: main,
  sessions: [{ id: main, depth: 0 }, { id: active, parentSessionId: main, depth: 1 },
    { id: parked, parentSessionId: main, depth: 1, workState: 'parked' }],
  nodes: [{ id: 'main:1' }, { id: 'parked:2' }], edges: [],
} as unknown as ContextFamilyGraph
const legacyRoute: ContextRouteAdvice = { action: 'branch', objective: 'Another task', reason: 'Separate work',
  base: { activeSessionId: active, planRevision: 1, graphRevision: 'g1' },
}
const route: ContextRouteAdvice = { ...legacyRoute, forkParentSessionId: main }

describe('native multi-step route operation DAG', () => {
  it('orders parent navigation before native fork and complete scope after fork', () => {
    const result = planner.compileContextRoutePlan({ graph, route, selectedNodeIds: ['main:1'] })
    expect(result).toEqual([
      { id: 'destination', kind: 'navigate', sessionId: main, dependsOn: [] },
      { id: 'branch', kind: 'fork', parentSessionId: main, dependsOn: ['destination'] },
      { id: 'context', kind: 'set-context', destination: 'branch', sourceNodeIds: ['main:1'], dependsOn: ['branch'] },
    ])
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('reactivates a parked existing destination without forking or adding dependency cycles', () => {
    const result = planner.compileContextRoutePlan({ graph,
      route: { ...legacyRoute, action: 'navigate', targetSessionId: parked },
      selectedNodeIds: ['parked:2'] })
    expect(result.map(step => step.kind)).toEqual(['navigate', 'set-context'])
    expect(result.at(-1)).toMatchObject({ destination: 'destination', dependsOn: ['destination'], sourceNodeIds: ['parked:2'] })
  })

  it('rejects missing parents, foreign scope and a source route from another active Session', () => {
    for (const input of [
      { graph, route: { ...route, forkParentSessionId: SessionId('foreign') }, selectedNodeIds: [] },
      { graph, route, selectedNodeIds: ['foreign:1'] },
      { graph: { ...graph, activeSessionId: parked }, route, selectedNodeIds: [] },
    ]) expect(() => planner.compileContextRoutePlan(input)).toThrow()
  })

  it('defaults a legacy branch to the active parent and rejects fork fields on existing destinations', () => {
    const result = planner.compileContextRoutePlan({ graph,
      route: legacyRoute, selectedNodeIds: [] })
    expect(result[0]).toMatchObject({ kind: 'fork', parentSessionId: active, dependsOn: [] })
    expect(() => planner.compileContextRoutePlan({ graph,
      route: { ...route, action: 'return', targetSessionId: main }, selectedNodeIds: [] })).toThrow()
  })
})

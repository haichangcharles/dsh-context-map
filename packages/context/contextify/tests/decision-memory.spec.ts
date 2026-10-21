import { describe, expect, it } from 'vitest'
import { decisionMemorySnapshot } from '../src/decision-memory.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { buildManagementMemory } from '../src/management-memory.ts'

describe('decision memory provenance', () => {
  it('exposes the supplied rule projection without recomputing it and removes it when disabled', () => {
    const managementMemory = buildManagementMemory(Array.from({ length: 4 }, (_, at) => ({
      action: 'include', choice: 'accept', origin: 'manual-action', branchDepth: 0, at,
      sourceSessionId: SessionId('old-memory'), sourceEventSeq: at,
    })), { branchDepth: 0 })
    const input = { enabled: true, reviewer: 'local' as const, edits: [], observations: [],
      calibrated: false, routed: false, managementMemory }
    expect(decisionMemorySnapshot(input).managementMemory).toBe(managementMemory)
    expect(decisionMemorySnapshot({ ...input, enabled: false }).managementMemory).toBeUndefined()
  })
  it('exposes the same signed task-to-route case that the reviewer received', () => {
    const routeContext = { source: 'Write the invitation', target: 'Plan the event venue' }
    const value = decisionMemorySnapshot({ enabled: true, reviewer: 'jev', edits: [], observations: [],
      calibrated: false, routed: true, routeExamples: [{ action: 'return', choice: 'reject',
        origin: 'explicit-review', branchDepth: 1, at: 1, objective: 'Finish the invitation first',
        routeContext, sourceSessionId: SessionId('old-side'), sourceEventSeq: 4 }] })
    expect(value.examples).toEqual([{ action: 'return', choice: 'reject', objective: 'Finish the invitation first',
      content: JSON.stringify(routeContext), sourceSessionId: 'old-side', sourceEventSeq: 4 }])
  })

  it('retains rejection signs and grouped cases while bounding threshold provenance', () => {
    const missing = { action: 'return' as const, choice: 'reject' as const, origin: 'explicit-review' as const, branchDepth: 1, at: 0 }
    const observations = Array.from({ length: 42 }, (_, i) => ({ ...missing, sourceSessionId: SessionId('route'), sourceEventSeq: i, at: i }))
    const result = decisionMemorySnapshot({ enabled: true, reviewer: 'jev',
      input: { activeSessionId: 'now', objective: '', nodes: [],
        preferenceExamples: [undefined, 'bad', 'old:not-a-seq'].map(episodeId => ({ objective: 'task', content: 'note', mode: 'include' as const,
          ...(episodeId === undefined ? {} : { episodeId }) })),
        planExamples: [{ objective: 'group', choices: [{ content: 'a', action: 'include', beforeIncluded: false, afterIncluded: true, onActiveBranch: false }] }],
      }, routeExamples: [missing], edits: [{ objective: '', content: '', mode: 'include' }],
      observations: [...observations, { ...missing, at: -1 }, { ...missing, sourceSessionId: SessionId('partial'), at: -2 }],
      calibrated: true, routed: true })
    expect(result.examples).toContainEqual({ objective: '', action: 'return', choice: 'reject' })
    expect(result.examples).toContainEqual({ objective: 'group', action: 'include', content: 'a', choice: 'accept' })
    expect(result.thresholdSources).toHaveLength(40)
    expect(result.thresholdSources).not.toContain('route:0')
  })

  it('separates model examples from additional calibration and threshold evidence', () => {
    const result = decisionMemorySnapshot({ enabled: true, reviewer: 'jev',
      edits: [{ objective: 'old task', content: 'old note', mode: 'exclude', episodeId: 'old:4' }],
      observations: [{ action: 'return', choice: 'reject', origin: 'explicit-review', branchDepth: 1,
        sourceSessionId: SessionId('route'), sourceEventSeq: 7, at: 1 }], calibrated: true, routed: true })
    expect(result.examples).toEqual([])
    expect(result.calibrationSources).toEqual(['old:4'])
    expect(result.thresholdSources).toEqual(['route:7'])
    const disabled = decisionMemorySnapshot({ enabled: false, reviewer: 'local', edits: [], observations: [], calibrated: true, routed: true })
    expect(disabled).toMatchObject({ enabled: false, examples: [], calibrationSources: [], thresholdSources: [] })
  })

  it('never presents Local rules as model-visible examples, and deduplicates provenance', () => {
    const edit = { objective: 'old task', content: 'old note', mode: 'exclude' as const, episodeId: 'old:4' }
    const input = { activeSessionId: 'now', objective: 'now', nodes: [], preferenceExamples: [edit], planExamples: [] }
    const result = decisionMemorySnapshot({ enabled: true, reviewer: 'local', input, edits: [edit, edit], observations: [], calibrated: true, routed: false })
    expect(result.examples).toEqual([])
    expect(result.calibrationSources).toEqual(['old:4'])
    expect(decisionMemorySnapshot({ enabled: true, reviewer: 'jev', input, edits: [], observations: [], calibrated: false, routed: false }).examples)
      .toEqual([{ objective: 'old task', content: 'old note', action: 'exclude', choice: 'accept', sourceSessionId: 'old', sourceEventSeq: 4 }])
  })
})

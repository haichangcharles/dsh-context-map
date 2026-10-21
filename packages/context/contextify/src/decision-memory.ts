/** Inspectable provenance for model examples and deterministic personal calibration. */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextPolicyObservation, ContextRecommendationProposal } from './types.ts'
import type { FastRecommendationInput } from './fast-recommendation.ts'
import type { PersonalContextEdit } from './personal-context-policy.ts'

type Snapshot = NonNullable<ContextRecommendationProposal['personalization']>

function cursor(episodeId: string | undefined): { sourceSessionId?: SessionId; sourceEventSeq?: number } {
  if (episodeId === undefined) return {}
  const separator = episodeId.lastIndexOf(':')
  if (separator <= 0) return {}
  const seq = Number(episodeId.slice(separator + 1))
  return Number.isSafeInteger(seq) && seq >= 0
    ? { sourceSessionId: SessionId(episodeId.slice(0, separator)), sourceEventSeq: seq } : {}
}

/** Keep model-visible samples distinct from the larger, bounded calibration input pools.
 * @param request - Captured review settings, model packet and native feedback projections.
 * @returns Distinct model examples and owned calibration source identities.
 */
export function decisionMemorySnapshot(request: {
  readonly enabled: boolean
  readonly reviewer: Snapshot['reviewer']
  readonly input?: FastRecommendationInput
  readonly routeExamples?: readonly ContextPolicyObservation[]
  readonly managementMemory?: Snapshot['managementMemory']
  readonly scopePolicyExamples?: Snapshot['scopePolicyExamples']
  readonly edits: readonly PersonalContextEdit[]
  readonly observations: readonly ContextPolicyObservation[]
  readonly calibrated: boolean
  readonly routed: boolean
}): Snapshot {
  if (!request.enabled) return { enabled: false, reviewer: request.reviewer, examples: [], calibrationSources: [], thresholdSources: [] }
  const examples: Snapshot['examples'][number][] = []
  if (request.reviewer !== 'local') {
    for (const edit of request.input?.preferenceExamples ?? []) examples.push({
      objective: edit.objective, action: edit.mode, content: edit.content, choice: 'accept', ...cursor(edit.episodeId),
    })
    for (const item of request.routeExamples ?? []) examples.push({ objective: item.objective ?? '',
      action: item.action, choice: item.choice,
      ...(item.routeContext === undefined ? {} : { content: JSON.stringify(item.routeContext) }),
      ...(item.sourceSessionId === undefined ? {} : { sourceSessionId: item.sourceSessionId }),
      ...(item.sourceEventSeq === undefined ? {} : { sourceEventSeq: item.sourceEventSeq }),
    })
    for (const example of request.input?.planExamples ?? []) {
      for (const choice of example.choices) examples.push({ objective: example.objective, action: choice.action,
        content: choice.content, choice: 'accept',
        ...(example.sourceSessionId === undefined ? {} : { sourceSessionId: SessionId(example.sourceSessionId) }),
        ...(example.sourceEventSeq === undefined ? {} : { sourceEventSeq: example.sourceEventSeq }),
      })
    }
  }
  const calibrationSources = request.calibrated
    ? [...new Set(request.edits.flatMap(edit => edit.episodeId === undefined ? [] : [edit.episodeId]))] : []
  const recent = request.observations.filter(item => !item.undone && Number.isFinite(item.at))
    .sort((a, b) => b.at - a.at)
  const counts = new Map<string, number>()
  const thresholdSources = !request.routed ? [] : [...new Set(recent.flatMap((item) => {
    const count = counts.get(item.action) ?? 0
    counts.set(item.action, count + 1)
    return count < 40 && item.sourceSessionId !== undefined && item.sourceEventSeq !== undefined
      ? [`${item.sourceSessionId}:${String(item.sourceEventSeq)}`] : []
  }))]
  return { enabled: true, reviewer: request.reviewer,
    ...(request.reviewer === 'local' || request.scopePolicyExamples === undefined ? {} : { scopePolicyExamples: request.scopePolicyExamples }),
    ...(request.managementMemory === undefined ? {} : { managementMemory: request.managementMemory }),
    examples: [...new Map(examples.map(example => [JSON.stringify(example), example])).values()], calibrationSources, thresholdSources }
}

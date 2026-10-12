/** Compact policy memory for Context decisions, derived only from reviewed UI choices. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ContextFamilyGraph, ContextFamilyInspection, ContextPolicyAction, ContextPolicyEstimate,
  ContextPolicyObservation, ContextPolicyRule, ContextStewardProfile,
} from './types.ts'
import { contextPlanFeedbackStates } from './plan.ts'

const ACTIONS: readonly ContextPolicyAction[] = ['include', 'navigate', 'branch', 'return', 'release']
const SOURCE_KINDS: readonly NonNullable<ContextPolicyObservation['sourceKind']>[]
  = ['chat', 'web', 'worker']

function compactRules(observations: readonly ContextPolicyObservation[]): readonly ContextPolicyRule[] {
  const rules: ContextPolicyRule[] = []
  for (const action of ACTIONS) {
    const recent = observations.filter(item => item.action === action && !item.undone
      && Number.isFinite(item.at) && (item.weight ?? 1) > 0)
      .sort((a, b) => b.at - a.at).slice(0, 40)
    for (const sourceKind of [undefined, ...SOURCE_KINDS]) {
      const matching = sourceKind === undefined ? recent
        : recent.filter(item => item.sourceKind === sourceKind)
      const support = matching.reduce((sum, item) => sum + (item.weight ?? 1), 0)
      if (support < 4) continue
      const accepted = matching.reduce((sum, item) => sum
        + (item.choice === 'accept' ? item.weight ?? 1 : 0), 0)
      const acceptRate = (2 + accepted) / (4 + support)
      if (acceptRate > 0.35 && acceptRate < 0.65) continue
      rules.push(Object.freeze({ action,
        ...(sourceKind === undefined ? {} : { sourceKind }),
        tendency: acceptRate >= 0.65 ? 'favor' : 'avoid', support, acceptRate }))
    }
  }
  return Object.freeze(rules)
}

function estimate(
  action: ContextPolicyAction,
  observations: readonly ContextPolicyObservation[],
  context: { readonly activity?: ContextPolicyObservation['activity']
    readonly sourceKind?: ContextPolicyObservation['sourceKind']
    readonly branchDepth: number },
): ContextPolicyEstimate {
  const usable = observations.filter(item => item.action === action && !item.undone
    && Number.isFinite(item.at) && Number.isInteger(item.branchDepth) && item.branchDepth >= 0)
    .sort((a, b) => b.at - a.at).slice(0, 40)
  const sameContext = usable.filter(item => (context.activity === undefined || item.activity === context.activity)
    && (context.sourceKind === undefined || item.sourceKind === context.sourceKind)
    && Math.abs(item.branchDepth - context.branchDepth) <= 1)
  // Back off to global behavior until the local cell has four effective reviews.
  // A single multi-item sheet can produce several low-weight observations.
  const localSupport = sameContext.reduce((sum, item) => sum + (item.weight ?? 1), 0)
  const selected = localSupport >= 4 ? sameContext : usable
  const support = selected.reduce((sum, item) => sum + (item.weight ?? 1), 0)
  const accepted = selected.reduce((sum, item) => sum + (item.choice === 'accept' ? item.weight ?? 1 : 0), 0)
  return Object.freeze({ acceptRate: (2 + accepted) / (4 + support), support })
}

/**
 * Recover preference evidence only from owned, explicit Contextify UI events.
 * A recommendation sheet contributes at most one observation across its items.
 * @param graph - Native Session family and source-kind projection.
 * @param inspections - Session logs with inherited prefix lengths.
 * @returns Confirmed observations ordered by event time.
 */
export function contextPolicyObservationsFromFamily(
  graph: ContextFamilyGraph,
  inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
): readonly ContextPolicyObservation[] {
  const depths = new Map(graph.sessions.map(session => [session.id, session.depth]))
  const sourceKinds = new Map(graph.nodes.map(node => [node.id, node.sourceKind]))
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const observed: { readonly sessionId: SessionId
    readonly seq: number
    readonly observation: ContextPolicyObservation }[] = []
  for (const inspection of inspections.values()) {
    const branchDepth = depths.get(inspection.meta.id)
    if (branchDepth === undefined) continue
    const owned = inspection.events.slice(inspection.inheritedEventCount)
    const { stateByPlanRevision, undoneStates } = contextPlanFeedbackStates(owned)
    for (const [index, event] of owned.entries()) {
      if (event.type === 'contextify/recommendation-reviewed'
        && event.data.uiOrigin === 'contextify-client') {
        const selection = event.data.selection
        const accepted = new Set(event.data.acceptedNodeIds)
        const declined = new Set(event.data.declinedNodeIds)
        if (selection.length === 0 || accepted.size !== event.data.acceptedNodeIds.length
          || declined.size !== event.data.declinedNodeIds.length
          || accepted.size + declined.size !== selection.length
          || new Set(selection.map(item => item.nodeId)).size !== selection.length
          || selection.some(item => accepted.has(item.nodeId) === declined.has(item.nodeId))) continue
        const preceding = owned[index - 1]
        const reviewedState = preceding?.type === 'contextify/node-choice'
          && preceding.data.origin === 'recommendation'
          ? stateByPlanRevision.get(preceding.data.afterPlanRevision) : undefined
        for (const [displayedIndex, item] of selection.entries()) {
          const sourceKind = sourceKinds.get(item.nodeId)
          const target = nodes.get(item.nodeId)
          observed.push({ sessionId: inspection.meta.id, seq: event.seq,
            observation: Object.freeze({
              action: item.action === 'include' ? 'include' : 'release',
              choice: accepted.has(item.nodeId) ? 'accept' : 'reject',
              origin: 'explicit-review', branchDepth, at: event.time,
              ...(event.data.objective?.trim() ? { objective: event.data.objective } : {}),
              targetNodeId: item.nodeId, displayedIndex,
              ...(target === undefined ? {} : {
                onActiveBranch: target.sessionIds.includes(inspection.meta.id),
              }),
              ...(sourceKind === undefined ? {} : { sourceKind }),
              weight: 1 / selection.length,
              ...(reviewedState !== undefined && undoneStates.has(reviewedState)
                ? { undone: true } : {}),
            }) })
        }
      } else if (event.type === 'contextify/node-choice'
        && event.data.uiOrigin === 'contextify-client'
        && event.data.origin === 'direct' && event.data.changed
        && event.data.mutations.length === 1) {
        const mutation = event.data.mutations[0]
        const mode = mutation?.mode
        if (mutation === undefined || (mode !== 'include' && mode !== 'exclude')) continue
        const targetNodeId = mutation.nodeId
        const sourceKind = sourceKinds.get(targetNodeId)
        const target = nodes.get(targetNodeId)
        const changedState = stateByPlanRevision.get(event.data.afterPlanRevision)
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action: mode === 'include' ? 'include' : 'release',
            choice: 'accept', origin: 'manual-action', branchDepth, at: event.time, weight: 1,
            targetNodeId,
            ...(target === undefined ? {} : {
              onActiveBranch: target.sessionIds.includes(inspection.meta.id),
            }),
            ...(sourceKind === undefined ? {} : { sourceKind }),
            ...(changedState !== undefined && undoneStates.has(changedState) ? { undone: true } : {}) }) })
      } else if (event.type === 'contextify/branch-choice'
        && event.data.uiOrigin === 'contextify-client') {
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action: 'branch',
            choice: event.data.choice === 'move' ? 'accept' : 'reject',
            origin: 'explicit-review', branchDepth, at: event.time, weight: 1 }) })
      } else if (event.type === 'contextify/route-choice'
        && event.data.uiOrigin === 'contextify-client') {
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action: event.data.action,
            choice: event.data.choice, origin: 'explicit-review',
            branchDepth, at: event.time, weight: 1,
            ...(event.data.objective?.trim() ? { objective: event.data.objective } : {}),
            ...(event.data.targetSessionId === undefined ? {} : {
              targetSessionId: event.data.targetSessionId,
            }) }) })
      } else if (event.type === 'contextify/manual-branch'
        && event.data.uiOrigin === 'contextify-client') {
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action: 'branch', choice: 'accept',
            origin: 'manual-action', branchDepth, at: event.time, weight: 1,
            targetSessionId: event.data.childSessionId }) })
      }
    }
  }
  return Object.freeze(observed.sort((left, right) => left.observation.at - right.observation.at
    || left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
    .map(item => item.observation))
}

function threshold(base: number, value: ContextPolicyEstimate): number {
  if (value.support < 3) return base
  return Math.max(0.6, Math.min(0.82, base + 0.3 * (0.5 - value.acceptRate)))
}

/**
 * Prior-and-evidence policy projection. It changes suggestion sensitivity only;
 * it never grants permission to auto-apply a route or Context Plan mutation.
 * @param observations - Explicit Context choices from the native Session family.
 * @param context - Activity, source kind, and branch depth being reviewed.
 * @returns Smoothed estimates, thresholds, and repeated-choice rules.
 */
export function deriveContextStewardProfile(
  observations: readonly ContextPolicyObservation[],
  context: { readonly activity?: ContextPolicyObservation['activity']
    readonly sourceKind?: ContextPolicyObservation['sourceKind']
    readonly branchDepth: number },
): ContextStewardProfile {
  const evidence = estimate('include', observations, context)
  const destination = estimate('navigate', observations, context)
  return Object.freeze({
    evidence,
    destination,
    branch: estimate('branch', observations, context),
    return: estimate('return', observations, context),
    release: estimate('release', observations, context),
    thresholds: Object.freeze({
      evidence: threshold(0.7, evidence),
      destination: threshold(0.7, destination),
    }),
    rules: compactRules(observations),
  })
}

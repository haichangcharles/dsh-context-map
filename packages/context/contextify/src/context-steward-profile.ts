/** Compact policy memory for Context decisions, derived only from reviewed UI choices. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ContextFamilyGraph, ContextFamilyInspection, ContextPolicyAction, ContextPolicyEstimate,
  ContextPolicyObservation, ContextPolicyRule, ContextStewardProfile,
} from './types.ts'
import { contextPlanFeedbackStates } from './plan.ts'
import { contextActivityFromObjective } from './context-activity.ts'
import { contextReviewFeedback } from './context-review-feedback.ts'
import invariant from 'tiny-invariant'

const ACTIONS: readonly ContextPolicyAction[] = ['include', 'navigate', 'branch', 'return', 'release', 'park', 'complete', 'reopen']
const SOURCE_KINDS: readonly NonNullable<ContextPolicyObservation['sourceKind']>[]
  = ['chat', 'web', 'worker']
const ACTIVITIES: readonly NonNullable<ContextPolicyObservation['activity']>[]
  = ['planning', 'writing', 'brainstorming']

function compactRules(observations: readonly ContextPolicyObservation[]): readonly ContextPolicyRule[] {
  const rules: ContextPolicyRule[] = []
  for (const action of ACTIONS) {
    const recent = observations.filter(item => item.action === action && !item.undone
      && Number.isFinite(item.at) && (item.weight ?? 1) > 0)
      .sort((a, b) => b.at - a.at).slice(0, 40)
    const cells: readonly { readonly sourceKind?: ContextPolicyObservation['sourceKind']
      readonly activity?: ContextPolicyObservation['activity']
      readonly matching: readonly ContextPolicyObservation[] }[] = [
      { matching: recent },
      ...SOURCE_KINDS.map(sourceKind => ({ sourceKind,
        matching: recent.filter(item => item.sourceKind === sourceKind) })),
      ...ACTIVITIES.map(activity => ({ activity,
        matching: recent.filter(item => item.activity === activity) })),
      ...SOURCE_KINDS.flatMap(sourceKind => ACTIVITIES.map(activity => ({ sourceKind, activity,
        matching: recent.filter(item => item.sourceKind === sourceKind && item.activity === activity) }))),
    ]
    for (const cell of cells) {
      const { matching } = cell
      const support = matching.reduce((sum, item) => sum + (item.weight ?? 1), 0)
      if (support < 4) continue
      const accepted = matching.reduce((sum, item) => sum
        + (item.choice === 'accept' ? item.weight ?? 1 : 0), 0)
      const acceptRate = (2 + accepted) / (4 + support)
      if (acceptRate > 0.35 && acceptRate < 0.65) continue
      const tendency = acceptRate >= 0.65 ? 'favor' : 'avoid'
      // A contextual rule is useful only when it adds an exception to a
      // broader rule, or when the broader evidence is too mixed to summarize.
      const parents = rules.filter(rule => rule.action === action
        && (rule.sourceKind === undefined || rule.sourceKind === cell.sourceKind)
        && (rule.activity === undefined || rule.activity === cell.activity))
      const parentSpecificity = Math.max(-1, ...parents.map(rule =>
        Number(rule.sourceKind !== undefined) + Number(rule.activity !== undefined)))
      const nearestParents = parents.filter(rule => Number(rule.sourceKind !== undefined)
        + Number(rule.activity !== undefined) === parentSpecificity)
      if (nearestParents.length > 0 && nearestParents.every(rule => rule.tendency === tendency)) continue
      rules.push(Object.freeze({ action,
        ...(cell.sourceKind === undefined ? {} : { sourceKind: cell.sourceKind }),
        ...(cell.activity === undefined ? {} : { activity: cell.activity }),
        tendency, support, acceptRate }))
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
      const objective = event.type === 'contextify/recommendation-reviewed'
        || event.type === 'contextify/recommendation-dismissed'
        || event.type === 'contextify/route-choice'
        ? event.data.objective : undefined
      const activity = objective === undefined ? undefined : contextActivityFromObjective(objective)
      if ((event.type === 'contextify/recommendation-reviewed'
        || event.type === 'contextify/recommendation-dismissed')
        && event.data.uiOrigin === 'contextify-client') {
        const preceding = owned[index - 1]
        const reviewedState = event.type === 'contextify/recommendation-reviewed'
          && preceding?.type === 'contextify/node-choice'
          && preceding.data.origin === 'recommendation'
          ? stateByPlanRevision.get(preceding.data.afterPlanRevision) : undefined
        for (const item of contextReviewFeedback(event)) {
          const sourceKind = sourceKinds.get(item.nodeId)
          const target = nodes.get(item.nodeId)
          observed.push({ sessionId: inspection.meta.id, seq: event.seq,
            observation: Object.freeze({
              action: item.action === 'include' ? 'include' : 'release',
              choice: item.choice,
              origin: 'explicit-review', branchDepth, at: event.time,
              ...(activity === undefined ? {} : { activity }),
              ...(event.data.objective?.trim() ? { objective: event.data.objective } : {}),
              targetNodeId: item.nodeId, displayedIndex: item.displayedIndex,
              ...(target === undefined ? {} : {
                onActiveBranch: target.sessionIds.includes(inspection.meta.id),
              }),
              ...(sourceKind === undefined ? {} : { sourceKind }),
              weight: item.weight,
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
        if (mutation === undefined || (mode !== 'include' && mode !== 'exclude' && mode !== 'natural')
          || (mode === 'natural' && !nodes.has(mutation.nodeId))) continue
        const targetNodeId = mutation.nodeId
        const sourceKind = sourceKinds.get(targetNodeId)
        const target = nodes.get(targetNodeId)
        // Natural restores native membership: active material is included again,
        // while an off-path Include is released. Unknown targets supply no label.
        const action = mode === 'natural'
          ? (target?.sessionIds.includes(inspection.meta.id) ? 'include' : 'release')
          : mode === 'include' ? 'include' : 'release'
        const changedState = stateByPlanRevision.get(event.data.afterPlanRevision)
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action,
            choice: 'accept', origin: 'manual-action', branchDepth, at: event.time, weight: 1,
            targetNodeId,
            ...(target === undefined ? {} : {
              onActiveBranch: target.sessionIds.includes(inspection.meta.id),
            }),
            ...(sourceKind === undefined ? {} : { sourceKind }),
            ...(changedState !== undefined && undoneStates.has(changedState) ? { undone: true } : {}) }) })
      } else if (event.type === 'contextify/branch-choice'
        && event.data.uiOrigin === 'contextify-client') {
        // The reviewed suggestion points to a completed native Turn. Read the
        // authored request from that Turn, never a later draft or sibling.
        const turnInput = inspection.events.findLast(candidate =>
          candidate.seq <= event.data.turnEndSeq
          && candidate.type === 'user/message' && candidate.data.source.kind === 'user')
        const turnActivity = turnInput?.type === 'user/message'
          ? contextActivityFromObjective(turnInput.data.content.flatMap(block =>
            block.type === 'text' ? [block.text] : []).join('\n')) : undefined
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action: 'branch',
            choice: event.data.choice === 'move' ? 'accept' : 'reject',
            origin: 'explicit-review', branchDepth, at: event.time, weight: 1,
            ...(turnInput?.type === 'user/message' ? { objective: turnInput.data.content.flatMap(block =>
              block.type === 'text' ? [block.text] : []).join('\n') } : {}),
            ...(turnActivity === undefined ? {} : { activity: turnActivity }) }) })
      } else if (event.type === 'contextify/route-choice'
        && event.data.uiOrigin === 'contextify-client') {
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action: event.data.action,
            choice: event.data.choice, origin: 'explicit-review',
            branchDepth, at: event.time, weight: 1,
            ...(activity === undefined ? {} : { activity }),
            ...(event.data.objective?.trim() ? { objective: event.data.objective } : {}),
            ...(event.data.forkParentSessionId === undefined ? {} : { forkParentSessionId: event.data.forkParentSessionId }),
            ...(event.data.targetSessionId === undefined ? {} : {
              targetSessionId: event.data.targetSessionId,
            }) }) })
      } else if ((event.type === 'contextify/manual-route'
        || event.type === 'contextify/work-state-choice')
        && event.data.uiOrigin === 'contextify-client') {
        const action: ContextPolicyAction = event.type === 'contextify/manual-route'
          ? event.data.action : event.data.state === 'open' ? 'reopen'
            : event.data.state === 'parked' ? 'park' : 'complete'
        const choiceActivity = contextActivityFromObjective(event.data.objective)
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action,
            choice: event.type === 'contextify/manual-route' ? 'accept' : event.data.choice,
            origin: event.type === 'contextify/manual-route' ? 'manual-action' : 'explicit-review',
            branchDepth, at: event.time, weight: 1,
            objective: event.data.objective, targetSessionId: event.data.targetSessionId,
            ...(choiceActivity === undefined ? {} : { activity: choiceActivity }) }) })
      } else if (event.type === 'contextify/manual-branch'
        && event.data.uiOrigin === 'contextify-client') {
        const manualObjective = event.data.objective?.trim()
        const manualActivity = manualObjective === undefined
          ? undefined : contextActivityFromObjective(manualObjective)
        observed.push({ sessionId: inspection.meta.id, seq: event.seq,
          observation: Object.freeze({ action: 'branch', choice: 'accept',
            origin: 'manual-action', branchDepth, at: event.time, weight: 1,
            targetSessionId: event.data.childSessionId,
            ...(manualObjective === undefined || manualObjective === '' ? {}
              : { objective: manualObjective }),
            ...(manualActivity === undefined ? {} : { activity: manualActivity }) }) })
      }
    }
  }
  return Object.freeze(observed.sort((left, right) => left.observation.at - right.observation.at
    || left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
    .map((item) => {
      const observation = item.observation
      const source = inspections.get(item.sessionId)
      invariant(source, 'policy observations must have their owning inspection')
      const event = source.events.find(event => event.seq === item.seq)
      invariant(event, 'policy observations must have their owning event')
      const cutoff = event.type === 'contextify/branch-choice'
        ? source.events.findLast(candidate => candidate.seq <= event.data.turnEndSeq
          && candidate.type === 'user/message' && candidate.data.source.kind === 'user')?.seq ?? item.seq
        : item.seq
      const taskText = (inspection: ContextFamilyInspection | undefined): string => (inspection?.events
        .slice(inspection.inheritedEventCount).filter(candidate => candidate.type === 'user/message'
          && candidate.data.source.kind === 'user' && (inspection.meta.id === item.sessionId
          ? candidate.seq < cutoff : candidate.time < event.time))
        .slice(-2).flatMap((candidate) => {
          // The preceding filter admits only direct human messages.
          const message = candidate as Extract<typeof candidate, { type: 'user/message' }>
          return message.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
        }) ?? [])
        .map(text => Array.from(text).slice(0, 400).join('')).join('\n')
      const routeContext = observation.action === 'branch' || observation.action === 'navigate'
        || observation.action === 'return'
        ? { source: taskText(source),
          ...(observation.forkParentSessionId === undefined ? {}
            : { parent: taskText(inspections.get(observation.forkParentSessionId)) }),
          ...(observation.targetSessionId === undefined ? {}
            : { target: taskText(inspections.get(observation.targetSessionId)) }) } : undefined
      return Object.freeze({ ...observation,
        ...(routeContext === undefined ? {} : { routeContext: Object.freeze(routeContext) }),
        sourceSessionId: item.sessionId, sourceEventSeq: item.seq })
    }))
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

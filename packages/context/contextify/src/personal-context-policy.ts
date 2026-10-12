/** Bounded candidate-routing preference from reviewed Context Map choices. */
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContextRecommendationDecision } from './recommendation.ts'
import type { ContextFamilyGraph, ContextFamilyInspection } from './types.ts'
import { jaccardOverlap } from './lexical-tokens.ts'
import { contextPlanFeedbackStates } from './plan.ts'

/** One explicit UI choice paired with its reviewed objective when recorded. */
export interface PersonalContextEdit {
  readonly objective: string
  readonly content: string
  readonly mode: 'include' | 'exclude'
  /** One reviewed sheet is one feedback episode, even when it edits several nodes. */
  readonly episodeId?: string
  readonly sourceKind?: 'chat' | 'web' | 'worker'
  /** User-authored constraints and assistant-authored offers can have different reuse habits. */
  readonly speakerRole?: 'user' | 'assistant' | 'tool'
  readonly webAction?: 'web_search' | 'web_fetch'
  /** Whether the edited node was on the Session path where the edit occurred. */
  readonly onActiveBranch?: boolean
  /** Accepted items from one review contribute at most one total edit weight. */
  readonly weight?: number
}

/** One accepted, changed multi-node Context recommendation kept as one example. */
export interface PersonalContextPlanExample {
  readonly objective: string
  readonly choices: readonly {
    readonly content: string
    readonly action: 'include' | 'exclude'
    /** Selection state immediately before the accepted review. */
    readonly beforeIncluded: boolean
    /** Selection state immediately after the accepted review. */
    readonly afterIncluded: boolean
    readonly sourceKind?: 'chat' | 'web' | 'worker'
    readonly speakerRole?: 'user' | 'assistant' | 'tool'
    readonly webAction?: 'web_search' | 'web_fetch'
    readonly onActiveBranch: boolean
  }[]
}

interface ChangedSelection {
  readonly nodeId: string
  readonly action: 'include' | 'exclude'
  readonly beforeIncluded: boolean
  readonly afterIncluded: boolean
}

function completeChangedSelection(
  event: Extract<ContextFamilyInspection['events'][number], { type: 'contextify/node-choice' }>,
): readonly ChangedSelection[] | null {
  const proposal = event.data.proposal
  const selection = proposal?.selection
  if (event.data.origin !== 'recommendation' || !event.data.changed
    || proposal === undefined || selection === undefined
    || selection.length < 2 || selection.length > 4
    || selection.length !== event.data.mutations.length
    || event.data.afterPlanRevision !== event.data.beforePlanRevision + 1) return null
  const before = new Set(proposal.currentNodeIds)
  const after = new Set(proposal.proposedNodeIds)
  if (before.size !== proposal.currentNodeIds.length
    || after.size !== proposal.proposedNodeIds.length) return null
  const seen = new Set<string>()
  const choices = selection.map((choice, index) => {
    const mutation = event.data.mutations[index]
    if (mutation?.nodeId !== choice.nodeId || seen.has(choice.nodeId)) return null
    seen.add(choice.nodeId)
    const beforeIncluded = before.has(choice.nodeId)
    const afterIncluded = after.has(choice.nodeId)
    if (beforeIncluded === afterIncluded || afterIncluded !== (choice.action === 'include')) return null
    return { nodeId: choice.nodeId, action: choice.action, beforeIncluded, afterIncluded }
  })
  if (choices.some(choice => choice === null)) return null
  return choices.filter((choice): choice is NonNullable<typeof choice> => choice !== null)
}

/** One candidate already admitted by the bounded Fast graph router. */
export interface PersonalContextCandidate {
  readonly id: string
  readonly reason: string
  readonly active: boolean
  readonly included: boolean
  readonly sourceKind?: 'chat' | 'web' | 'worker'
  readonly role?: 'user' | 'assistant' | 'tool'
  readonly webAction?: 'web_search' | 'web_fetch'
  /** Shared lexical relevance, used to gate broad style-only Include proposals. */
  readonly lexicalScore?: number
}

type StyleAxis = 'source' | 'topology' | 'cell' | 'speaker' | 'speaker-topology'

interface PersonalStyleAdvice {
  readonly mode: 'include' | 'exclude'
  readonly support: number
  readonly axis: StyleAxis
}

function recentStyleReversal(
  history: readonly PersonalContextEdit[],
  candidate: Pick<PersonalContextEdit, 'sourceKind' | 'speakerRole' | 'webAction' | 'onActiveBranch'>,
): PersonalStyleAdvice | null {
  const matching = history.filter(edit => (edit.weight ?? 1) >= 1
    && edit.sourceKind === candidate.sourceKind
    && (candidate.speakerRole === undefined || edit.speakerRole === candidate.speakerRole)
    && edit.onActiveBranch === candidate.onActiveBranch
    && (candidate.sourceKind !== 'web' || edit.webAction === candidate.webAction))
  if (matching.length < 10) return null
  const recent = matching.slice(-5)
  const earlier = matching.slice(0, -5)
  const recentMode = recent[0]?.mode
  if (recentMode === undefined || !recent.every(edit => edit.mode === recentMode)) return null
  const earlierIncludeRate = (1 + earlier.filter(edit => edit.mode === 'include').length)
    / (2 + earlier.length)
  if ((recentMode === 'include' && earlierIncludeRate > 0.3)
    || (recentMode === 'exclude' && earlierIncludeRate < 0.7)) return null
  return { mode: recentMode, support: recent.length, axis: 'cell' }
}

function sameStyleCell(
  axis: StyleAxis,
  left: PersonalContextEdit,
  right: PersonalContextEdit,
): boolean {
  if (axis === 'speaker' || axis === 'speaker-topology') {
    return left.speakerRole !== undefined && left.speakerRole === right.speakerRole
      && (axis === 'speaker' || left.onActiveBranch === right.onActiveBranch)
  }
  return (axis === 'topology' || (left.sourceKind === right.sourceKind
    && (left.sourceKind !== 'web' || left.webAction === undefined
      || right.webAction === undefined || left.webAction === right.webAction)))
    && (axis === 'source' || left.onActiveBranch === right.onActiveBranch)
}

function styleRate(axis: StyleAxis, query: PersonalContextEdit,
  history: readonly PersonalContextEdit[]): { rate: number; support: number } {
  const matching = history.filter(edit => sameStyleCell(axis, query, edit))
  const support = matching.reduce((sum, edit) => sum + (edit.weight ?? 1), 0)
  const includes = matching.reduce((sum, edit) => sum
    + (edit.mode === 'include' ? (edit.weight ?? 1) : 0), 0)
  return { rate: (1 + includes) / (2 + support), support }
}

/**
 * Select the user's most predictive Context organization axis using only
 * prior confirmed edits. A sparse source×path cell backs off to source or
 * path style; the model's semantic recommendation still supplies candidates.
 * @param history - UI-confirmed Include/Exclude edits with known graph features.
 * @param candidate - Source kind and active-path relation to score.
 * @returns A strong personal action or null when evidence is too sparse.
 */
export function personalContextStyleAdvice(
  history: readonly PersonalContextEdit[],
  candidate: Pick<PersonalContextEdit, 'sourceKind' | 'speakerRole' | 'webAction' | 'onActiveBranch'>,
): PersonalStyleAdvice | null {
  if (candidate.sourceKind === undefined || candidate.onActiveBranch === undefined) return null
  const usable = history.filter(edit => edit.sourceKind !== undefined
    && edit.onActiveBranch !== undefined && (edit.weight ?? 1) > 0)
  if (usable.length < 5) return null
  const reversal = recentStyleReversal(usable, candidate)
  if (reversal !== null) return reversal
  const axes: readonly StyleAxis[] = candidate.speakerRole === undefined
    ? ['source', 'topology', 'cell']
    : ['source', 'topology', 'cell', 'speaker', 'speaker-topology']
  const scored = axes.map(axis => ({ axis, correct: usable.reduce((sum, edit, index) => {
    // Leave out the whole review episode. Keeping sibling items in the fold
    // leaks the same confirmation into an ostensibly held-out choice.
    const others = usable.filter((other, otherIndex) => otherIndex !== index
      && (edit.episodeId === undefined || other.episodeId !== edit.episodeId))
    const { rate, support } = styleRate(axis, edit, others)
    if (support < 2) return sum
    return sum + (rate >= 0.5 === (edit.mode === 'include') ? (edit.weight ?? 1) : 0)
  }, 0) }))
  const axis = scored.sort((left, right) => right.correct - left.correct)[0]?.axis
  if (axis === undefined) return null
  const { rate, support } = styleRate(axis, {
    objective: '', content: '', mode: 'include', ...candidate,
  }, usable)
  if (support < 3 || (rate > 0.3 && rate < 0.7)) return null
  return { mode: rate >= 0.7 ? 'include' : 'exclude', support, axis }
}

/**
 * Recover direct edits and confirmed reviewed proposal selections.
 * @param graph - Current native Session family projection.
 * @param inspections - Session logs with inherited-prefix counts.
 * @returns At most 32 owned, still-active choices, once each.
 */
export function contextEditEvidenceFromFamily(
  graph: ContextFamilyGraph,
  inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
): readonly { readonly at: number; readonly edit: PersonalContextEdit }[] {
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const edits: { time: number; sessionId: string; seq: number; edit: PersonalContextEdit }[] = []
  for (const inspection of inspections.values()) {
    const { stateByPlanRevision, undoneStates } = contextPlanFeedbackStates(
      inspection.events.slice(inspection.inheritedEventCount))
    for (let index = inspection.inheritedEventCount; index < inspection.events.length; index += 1) {
      const event = inspection.events[index]
      if ((event?.type !== 'contextify/node-choice'
        && event?.type !== 'contextify/recommendation-reviewed')
        || event.data.uiOrigin !== 'contextify-client') continue
      if (event.type === 'contextify/node-choice' && event.data.origin === 'recommendation'
        && inspection.events[index + 1]?.type === 'contextify/recommendation-reviewed') continue
      const preceding = inspection.events[index - 1]
      const changedRevision = event.type === 'contextify/node-choice'
        ? event.data.afterPlanRevision
        : preceding?.type === 'contextify/node-choice'
          && preceding.data.origin === 'recommendation'
          ? preceding.data.afterPlanRevision : undefined
      const changedState = changedRevision === undefined ? undefined : stateByPlanRevision.get(changedRevision)
      if (changedState !== undefined && undoneStates.has(changedState)) continue
      let choices: readonly { nodeId: string; mode: 'include' | 'exclude'; weight: number }[]
      if (event.type === 'contextify/recommendation-reviewed') {
        const accepted = new Set(event.data.acceptedNodeIds)
        const declined = new Set(event.data.declinedNodeIds)
        const selection = event.data.selection
        if (selection.length === 0
          || accepted.size !== event.data.acceptedNodeIds.length
          || declined.size !== event.data.declinedNodeIds.length
          || accepted.size + declined.size !== selection.length
          || new Set(selection.map(item => item.nodeId)).size !== selection.length
          || selection.some(item => accepted.has(item.nodeId) === declined.has(item.nodeId))) continue
        // Keep current rejects this proposal for the reviewed turn. It is
        // useful rejection evidence for suggestion calibration, but it is not
        // an affirmative Include/Exclude edit for the style-memory ranker.
        choices = selection.filter(item => accepted.has(item.nodeId)).map(({ nodeId, action }) => ({
          nodeId,
          mode: action,
          weight: 1 / selection.length,
        }))
      } else {
        const proposal = event.data.proposal
        choices = event.data.origin === 'direct'
          ? event.data.changed && event.data.mutations.length === 1
            ? event.data.mutations.map(({ nodeId, mode }) => ({ nodeId,
              mode: mode === 'natural'
                ? (nodeById.get(nodeId)?.sessionIds.includes(inspection.meta.id) ? 'include' : 'exclude')
                : mode,
              weight: 1 }))
            : []
          : proposal?.selection.length === event.data.mutations.length
            && proposal.selection.length > 0
            && proposal.selection.every((selection, position) =>
              selection.nodeId === event.data.mutations[position]?.nodeId)
            ? proposal.selection.map(({ nodeId, action }) => ({
              nodeId, mode: action, weight: 1 / proposal.selection.length,
            }))
            : []
      }
      if (choices.length === 0) continue
      const objectiveEvent = inspection.events.slice(0, index).findLast(candidate =>
        candidate.type === 'user/message' && candidate.data.source.kind === 'user')
      const objective = (event.type === 'contextify/recommendation-reviewed'
        ? event.data.objective
        : undefined) ?? (objectiveEvent?.type === 'user/message'
        ? objectiveEvent.data.content.flatMap(block =>
          block.type === 'text' ? [block.text] : []).join('\n') : '')
      const bounded = objective.slice(0, 500)
      if (bounded.trim().length === 0) continue
      for (const choice of choices) {
        const node = nodeById.get(choice.nodeId)
        if (node === undefined) continue
        const content = node.preview.slice(0, 500)
        if (content.trim().length === 0) continue
        edits.push({
          time: event.time, sessionId: String(inspection.meta.id), seq: event.seq,
          edit: { objective: bounded, content, mode: choice.mode,
            episodeId: `${String(inspection.meta.id)}:${String(event.seq)}`,
            ...(node.sourceKind === undefined ? {} : { sourceKind: node.sourceKind }),
            speakerRole: node.role,
            ...(node.webAction === undefined ? {} : { webAction: node.webAction }),
            onActiveBranch: node.sessionIds.includes(inspection.meta.id),
            ...(event.type === 'contextify/recommendation-reviewed'
              || event.data.origin === 'recommendation' ? { weight: choice.weight } : {}) },
        })
      }
    }
  }
  return edits.sort((left, right) => left.time - right.time
    || left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
    .slice(-32).map(item => ({ at: item.time, edit: item.edit }))
}

/** Latest UI-confirmed Context choices in one native Session family.
 * @param graph - Current native Session family projection.
 * @param inspections - Session logs with inherited-prefix counts.
 * @returns Confirmed, active Include and Exclude examples.
 */
export function contextEditsFromFamily(
  graph: ContextFamilyGraph,
  inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
): readonly PersonalContextEdit[] {
  return contextEditEvidenceFromFamily(graph, inspections).map(item => item.edit)
}

/**
 * Remember exact item-level Keep-current choices for the same draft objective.
 * This prevents immediate repeat suggestions without inventing an opposite
 * Include/Exclude style preference. An accepted later review clears a decline.
 * @param inspection - Active Session log, when available.
 * @param objective - Exact draft objective being reviewed.
 * @returns Action-node keys explicitly declined for that objective.
 */
export function declinedContextActionsForObjective(
  inspection: ContextFamilyInspection | undefined,
  objective: string,
): ReadonlySet<string> {
  const normalized = objective.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
  const declined = new Set<string>()
  // One Session history includes its inherited prefix, but not sibling reviews.
  for (const event of inspection?.events ?? []) {
    if (event.type !== 'contextify/recommendation-reviewed'
      || event.data.uiOrigin !== 'contextify-client'
      || event.data.objective?.trim().replace(/\s+/g, ' ').toLocaleLowerCase() !== normalized) continue
    const accepted = new Set(event.data.acceptedNodeIds)
    const rejected = new Set(event.data.declinedNodeIds)
    if (accepted.size !== event.data.acceptedNodeIds.length
      || rejected.size !== event.data.declinedNodeIds.length
      || accepted.size + rejected.size !== event.data.selection.length
      || new Set(event.data.selection.map(item => item.nodeId)).size !== event.data.selection.length
      || event.data.selection.some(item => accepted.has(item.nodeId) === rejected.has(item.nodeId))) continue
    for (const item of event.data.selection) {
      const key = `${item.action}:${item.nodeId}`
      if (accepted.has(item.nodeId)) declined.delete(key)
      else declined.add(key)
    }
  }
  return declined
}

/**
 * Recover complete accepted multi-node deltas, without treating each node as
 * a separate full-weight preference. No-ops and partial/ambiguous batches
 * are excluded; single-node choices already appear as preference edits.
 * @param graph - Current native Session family projection.
 * @param inspections - Session logs with inherited-prefix counts.
 * @returns Bounded confirmed multi-node Context Plan examples.
 */
export function contextPlanExamplesFromFamily(
  graph: ContextFamilyGraph,
  inspections: ReadonlyMap<SessionId, ContextFamilyInspection>,
): readonly PersonalContextPlanExample[] {
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  const examples: { time: number; sessionId: string; seq: number; example: PersonalContextPlanExample }[] = []
  for (const inspection of inspections.values()) {
    const { stateByPlanRevision, undoneStates } = contextPlanFeedbackStates(
      inspection.events.slice(inspection.inheritedEventCount))
    for (let index = inspection.inheritedEventCount; index < inspection.events.length; index += 1) {
      const event = inspection.events[index]
      if (event?.type !== 'contextify/node-choice' || event.data.uiOrigin !== 'contextify-client'
        || event.data.origin !== 'recommendation' || !event.data.changed) continue
      const changedState = stateByPlanRevision.get(event.data.afterPlanRevision)
      if (changedState !== undefined && undoneStates.has(changedState)) continue
      const selection = completeChangedSelection(event)
      if (selection === null) continue
      const reviewed = inspection.events[index + 1]
      const reviewedObjective = reviewed?.type === 'contextify/recommendation-reviewed'
        && reviewed.data.base.planRevision === event.data.beforePlanRevision
        ? reviewed.data.objective : undefined
      const objectiveEvent = inspection.events.slice(0, index).findLast(candidate =>
        candidate.type === 'user/message' && candidate.data.source.kind === 'user')
      const objective = (reviewedObjective ?? (objectiveEvent?.type === 'user/message'
        ? objectiveEvent.data.content.flatMap(block =>
          block.type === 'text' ? [block.text] : []).join('\n') : '')).slice(0, 500)
      if (objective.trim().length === 0) continue
      const choices = selection.flatMap((choice) => {
        const node = nodeById.get(choice.nodeId)
        if (node === undefined || node.preview.trim().length === 0) return []
        return [{ content: node.preview.slice(0, 500), action: choice.action,
          beforeIncluded: choice.beforeIncluded, afterIncluded: choice.afterIncluded,
          ...(node.sourceKind === undefined ? {} : { sourceKind: node.sourceKind }),
          speakerRole: node.role,
          ...(node.webAction === undefined ? {} : { webAction: node.webAction }),
          onActiveBranch: node.sessionIds.includes(inspection.meta.id) }]
      })
      if (choices.length !== selection.length) continue
      examples.push({ time: event.time, sessionId: String(inspection.meta.id), seq: event.seq,
        example: { objective, choices } })
    }
  }
  return examples.sort((left, right) => left.time - right.time
    || left.sessionId.localeCompare(right.sessionId) || left.seq - right.seq)
    .slice(-16).map(item => item.example)
}

/**
 * Score explicit Include/Exclude choices with a two-example shrinkage prior.
 * @param objective - Current user objective.
 * @param candidate - Candidate message content.
 * @param edits - Reviewed choices in the Session family.
 * @param candidateOnActiveBranch - Current candidate's position relative to the active path.
 * @param candidateSourceKind - Chat, Web, or worker evidence type when known.
 * @param candidateWebAction - Recorded Web tool action when the candidate is Web evidence.
 * @returns A bounded signed preference residual.
 */
export function personalContextCandidateBonus(
  objective: string,
  candidate: string,
  edits: readonly PersonalContextEdit[],
  candidateOnActiveBranch?: boolean,
  candidateSourceKind?: PersonalContextEdit['sourceKind'],
  candidateWebAction?: PersonalContextEdit['webAction'],
): number {
  const sameTopology = (edit: PersonalContextEdit) => edit.onActiveBranch === undefined
    || candidateOnActiveBranch === undefined || edit.onActiveBranch === candidateOnActiveBranch
  const sameSource = (edit: PersonalContextEdit) => edit.sourceKind === undefined
    || candidateSourceKind === undefined || (edit.sourceKind === candidateSourceKind
      && (edit.sourceKind !== 'web' || edit.webAction === undefined
        || candidateWebAction === undefined || edit.webAction === candidateWebAction))
  const useStyle = edits.reduce((sum, edit) => sum + (sameTopology(edit) && sameSource(edit)
    ? (edit.weight ?? 1) : 0), 0) >= 4
  let signed = 0
  let weightSum = 0
  for (const edit of edits) {
    if (!sameSource(edit)) continue
    const weight = (edit.weight ?? 1) * (jaccardOverlap(objective, edit.objective)
      * (0.5 + 0.5 * jaccardOverlap(candidate, edit.content))
      + (useStyle && sameTopology(edit) ? 0.5 : 0))
    signed += weight * (edit.mode === 'include' ? 1 : -1)
    weightSum += weight
  }
  return Math.max(-0.2, Math.min(0.2, 0.3 * signed / (2 + weightSum)))
}

/**
 * Suppress conflicting actions and suggest bounded, graph-routed off-path Includes.
 * @param decision - Already validated generic model decision.
 * @param objective - Current user objective.
 * @param contents - Full message content by graph node ID.
 * @param edits - Reviewed choices in the Session family.
 * @param candidates - Model-visible Fast packet; only its eligible nodes may be added.
 * @param reviewableExcludedNodeIds - Prior reviewed temporary exclusions eligible for a new Include proposal.
 * @returns A decision for ordinary graph validation before user review.
 */
export function calibrateContextRecommendation(
  decision: ContextRecommendationDecision,
  objective: string,
  contents: Readonly<Record<string, string>>,
  edits: readonly PersonalContextEdit[],
  candidates: readonly PersonalContextCandidate[] = [],
  reviewableExcludedNodeIds: readonly string[] = [],
): ContextRecommendationDecision {
  if (edits.length === 0) return decision
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const reviewable = new Set(reviewableExcludedNodeIds)
  const style = (nodeId: string) => {
    const candidate = byId.get(nodeId)
    return candidate?.sourceKind === undefined ? null : personalContextStyleAdvice(edits, {
      sourceKind: candidate.sourceKind,
      ...(candidate.role === undefined ? {} : { speakerRole: candidate.role }),
      ...(candidate.webAction === undefined ? {} : { webAction: candidate.webAction }),
      onActiveBranch: candidate.active,
    })
  }
  const bonus = (nodeId: string) => personalContextCandidateBonus(
    objective, contents[nodeId] ?? '', edits, byId.get(nodeId)?.active,
    byId.get(nodeId)?.sourceKind, byId.get(nodeId)?.webAction)
  const include = decision.include.filter((item) => {
    // A prior accepted temporary Exclude is evidence of past relevance, not a
    // permanent preference against restoring this exact source on a later turn.
    if (reviewable.has(item.nodeId)) return true
    const personalStyle = style(item.nodeId)?.mode
    return personalStyle === 'include' || (personalStyle !== 'exclude' && bonus(item.nodeId) > -0.075)
  })
  const exclude = decision.exclude.filter((item) => {
    const personalStyle = style(item.nodeId)?.mode
    return personalStyle === 'exclude' || (personalStyle !== 'include' && bonus(item.nodeId) < 0.075)
  })
  const selected = new Set([...include, ...exclude, ...decision.archive].map(item => item.nodeId))
  const styleExclusions = candidates.filter(candidate => candidate.active && candidate.included
    && candidate.sourceKind !== 'chat'
    && !selected.has(candidate.id)
    && style(candidate.id)?.mode === 'exclude')
    .slice(0, 2)
    .map(candidate => ({ nodeId: candidate.id,
      reason: 'Your earlier reviewed Context edits favored excluding this source type on the active branch.' }))
  const additions = candidates.filter(candidate => candidate.reason === 'off-path-candidate'
    && (candidate.sourceKind === undefined || candidate.sourceKind === 'chat'
      || (candidate.sourceKind === 'web' && candidate.webAction !== undefined))
    && !candidate.active && !candidate.included && !selected.has(candidate.id)
    && (bonus(candidate.id) >= 0.08 || style(candidate.id)?.mode === 'include')
    && (candidate.sourceKind === 'web'
      ? (candidate.lexicalScore ?? 0) >= 0.25
      : (candidate.lexicalScore ?? 0) >= 0.05 || edits.some(edit => edit.mode === 'include'
        && jaccardOverlap(objective, edit.objective) >= 0.2
        && jaccardOverlap(contents[candidate.id] ?? '', edit.content) >= 0.2)))
    .sort((left, right) => (right.lexicalScore ?? 0) + bonus(right.id)
      - (left.lexicalScore ?? 0) - bonus(left.id))
    .slice(0, 2)
    .map(candidate => ({ nodeId: candidate.id,
      reason: 'Similar earlier reviewed Context choices favored including this material.' }))
  return {
    exclude: [...exclude, ...styleExclusions],
    include: [...include, ...additions],
    archive: decision.archive,
  }
}

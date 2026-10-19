/** Incremental rule/workflow views over owned, already retraction-filtered events. */
import { deriveContextStewardProfile } from './context-steward-profile.ts'
import type { ContextManagementMemory, ContextManagementReference, ContextManagementRule,
  ContextManagementWorkflow, ContextPolicyObservation } from './types.ts'

type Evidence = ContextPolicyObservation & Required<Pick<ContextPolicyObservation, 'sourceSessionId' | 'sourceEventSeq'>>
type Condition = { readonly activity?: ContextPolicyObservation['activity']
  readonly sourceKind?: ContextPolicyObservation['sourceKind']
  readonly branchDepth: number }

function references(rows: readonly Evidence[]): readonly ContextManagementReference[] {
  const ordered = [...rows].sort((a, b) => b.at - a.at)
  const balanced = [...ordered.filter(row => row.choice === 'accept').slice(0, 3),
    ...ordered.filter(row => row.choice === 'reject').slice(0, 3), ...ordered]
  return [...new Map(balanced.map(row => [`${row.sourceSessionId}:${String(row.sourceEventSeq)}`,
    Object.freeze({ sessionId: row.sourceSessionId, eventSeq: row.sourceEventSeq })])).values()].slice(0, 6)
}

function connected(previous: Evidence, current: Evidence): boolean {
  if (previous.sourceSessionId === current.sourceSessionId) {
    return previous.sourceEventSeq < current.sourceEventSeq
      && (!['branch', 'navigate', 'return'].includes(previous.action)
        || previous.targetSessionId === current.sourceSessionId)
  }
  return ['branch', 'navigate', 'return'].includes(previous.action)
    && previous.targetSessionId === current.sourceSessionId && previous.at < current.at
}

/** Project conditional rules and repeated management workflows without inference or mutation.
 * @param observations - Owned confirmed events after Profile reset filtering; Undo remains explicit.
 * @param context - Current activity, source kind and native branch depth.
 * @returns At most eight rules/four workflows within a complete 16KiB UTF-8 payload.
 */
export function buildManagementMemory(observations: readonly ContextPolicyObservation[], context: Condition): ContextManagementMemory {
  const owned = observations.filter((row): row is Evidence => row.sourceSessionId !== undefined
    && row.sourceEventSeq !== undefined && Number.isSafeInteger(row.sourceEventSeq) && row.sourceEventSeq >= 0
    && Number.isFinite(row.at) && (row.weight ?? 1) > 0)
  const rows = [...new Map(owned.map(row => [JSON.stringify([row.sourceSessionId, row.sourceEventSeq,
    row.action, row.targetNodeId, row.targetSessionId]), row])).values()]
    .sort((a, b) => a.at - b.at || a.sourceSessionId.localeCompare(b.sourceSessionId) || a.sourceEventSeq - b.sourceEventSeq)
    .slice(-80)
  const ruleRows = rows.filter(row => row.branchDepth === context.branchDepth
    && (context.activity === undefined || row.activity === undefined || row.activity === context.activity)
    && (context.sourceKind === undefined || row.sourceKind === undefined || row.sourceKind === context.sourceKind))
  const allRules: ContextManagementRule[] = deriveContextStewardProfile(ruleRows, context).rules.map((rule) => {
    const matching = ruleRows.filter(row => row.action === rule.action && !row.undone)
      .sort((a, b) => b.at - a.at).slice(0, 40)
      .filter(row => (rule.activity === undefined || row.activity === rule.activity)
          && (rule.sourceKind === undefined || row.sourceKind === rule.sourceKind))
    const accepted = matching.reduce((sum, row) => sum + (row.choice === 'accept' ? row.weight ?? 1 : 0), 0)
    const first = matching[0] as Evidence
    const activity = rule.activity ?? (matching.every(row => row.activity === first.activity) ? first.activity : undefined)
    const sourceKind = rule.sourceKind ?? (matching.every(row => row.sourceKind === first.sourceKind) ? first.sourceKind : undefined)
    return Object.freeze({ ...rule,
      ...(activity === undefined ? {} : { activity }), ...(sourceKind === undefined ? {} : { sourceKind }),
      id: `rule/${rule.action}/${activity ?? '*'}/${sourceKind ?? '*'}/${String(context.branchDepth)}`,
      branchDepth: context.branchDepth,
      accepted, rejected: rule.support - accepted, references: references(matching) })
  }).sort((a, b) => b.support - a.support || a.id.localeCompare(b.id))
  const episodes = new Map<string, Evidence[][]>()
  let chain: Evidence[] = []
  for (const row of rows) {
    if (row.undone) { chain = []; continue }
    const previous = chain.at(-1)
    if (previous !== undefined && !connected(previous, row)) chain = []
    chain.push(row)
    chain = chain.slice(-3)
    for (const length of [2, 3]) {
      if (chain.length < length) continue
      const sequence = chain.slice(-length), first = sequence[0] as Evidence
      if (first.activity !== undefined && context.activity !== undefined && first.activity !== context.activity
        || first.branchDepth !== context.branchDepth) continue
      const id = `workflow/${first.activity ?? '*'}/${String(first.branchDepth)}/${sequence.map(item => item.action).join('.')}`
      const matches = episodes.get(id) ?? []
      matches.push(sequence); episodes.set(id, matches)
    }
    if (row.choice === 'reject') chain = []
  }
  const allWorkflows: ContextManagementWorkflow[] = []
  for (const [id, sequences] of episodes) {
    const support = sequences.reduce((sum, sequence) => sum + Math.min(...sequence.map(row => row.weight ?? 1)), 0)
    const accepted = sequences.reduce((sum, sequence) => sum + ((sequence.at(-1) as Evidence).choice === 'accept'
      ? Math.min(...sequence.map(row => row.weight ?? 1)) : 0), 0)
    const acceptRate = (2 + accepted) / (4 + support)
    if (support < 2 || acceptRate > .35 && acceptRate < .65) continue
    const firstSequence = sequences[0] as Evidence[]
    const first = firstSequence[0] as Evidence
    allWorkflows.push(Object.freeze({ id, actions: Object.freeze(firstSequence.map(row => row.action)),
      ...(first.activity === undefined ? {} : { activity: first.activity }), branchDepth: first.branchDepth,
      tendency: acceptRate >= .65 ? 'favor' : 'avoid', support, acceptRate, accepted, rejected: support - accepted,
      references: references(sequences.flat()), examples: Object.freeze(sequences.slice(-2).map(sequence => Object.freeze(
        sequence.map(row => Array.from(row.objective ?? '').slice(0, 200).join(''))))) }))
  }
  allWorkflows.sort((a, b) => b.support - a.support || a.id.localeCompare(b.id))
  const rules = allRules.slice(0, 8), workflows = allWorkflows.slice(0, 4)
  const result = (): ContextManagementMemory => ({ rules, workflows,
    ...(allRules.length > rules.length ? { omittedRules: allRules.length - rules.length } : {}),
    ...(allWorkflows.length > workflows.length ? { omittedWorkflows: allWorkflows.length - workflows.length } : {}) })
  while (new TextEncoder().encode(JSON.stringify(result())).byteLength > 16 * 1024) {
    if (workflows.length > 0) workflows.pop()
    else rules.pop()
  }
  return Object.freeze({ ...result(), rules: Object.freeze(rules), workflows: Object.freeze(workflows) })
}

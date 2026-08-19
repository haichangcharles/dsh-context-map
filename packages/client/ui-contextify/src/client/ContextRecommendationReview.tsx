/** Human review sheet for ephemeral Context Map recommendations. */
import { useEffect, useMemo, useState } from 'react'
import type {
  ContextCleanupCandidate, ContextFamilyGraph, ContextRecommendationProposal,
} from '@deepseek-ai/dsh-contextify/types'
import type { ContextRecommendationState } from './controller.ts'
import css from './ContextRecommendationReview.module.css'

export interface ContextRecommendationReviewProps {
  readonly state: ContextRecommendationState
  readonly graph: ContextFamilyGraph
  readonly pending: boolean
  readonly apply: (nodeIds: readonly string[]) => Promise<void>
  readonly confirmCleanup: (candidate: ContextCleanupCandidate) => Promise<void>
  readonly dismiss: () => void
  readonly reportError: (cause: unknown) => void
}

function ProposalReview({
  proposal, stale, graph, pending, apply, confirmCleanup, dismiss, reportError,
}: Omit<ContextRecommendationReviewProps, 'state'> & {
  readonly proposal: ContextRecommendationProposal
  readonly stale: boolean
}) {
  const [selected, setSelected] = useState<readonly string[]>(() => proposal.selection.map(item => item.nodeId))
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [kept, setKept] = useState<readonly string[]>([])
  useEffect(() => {
    setSelected(proposal.selection.map(item => item.nodeId))
    setReviewing(null)
    setKept([])
  }, [proposal])
  const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
  const run = (operation: () => Promise<void>): void => {
    void operation().catch(reportError)
  }
  return <div className={css.sheet} role="dialog" aria-label="Context recommendation review">
    <div className={css.header}>
      <div>
        <h3>Review Context recommendations</h3>
        <p>Nothing changes until you apply a selection or confirm one cleanup.</p>
      </div>
      <button type="button" aria-label="Close recommendation review" onClick={dismiss}>×</button>
    </div>
    {stale && <div className={css.stale} role="alert">The conversation or Context Plan changed. Dismiss and run Recommend again.</div>}
    <section className={css.section} aria-label="Include and exclude recommendations">
      <h4>Context selection</h4>
      {proposal.selection.length === 0 && <div className={css.empty}>No selection changes suggested.</div>}
      <div className={css.list}>
        {proposal.selection.map(item => <article className={css.item} key={`${item.action}:${item.nodeId}`}>
          <div className={css.itemTop}>
            <label>
              <input
                type="checkbox"
                aria-label={`Select ${item.action} recommendation for ${item.nodeId}`}
                checked={selected.includes(item.nodeId)}
                disabled={stale || pending}
                onChange={(event) => {
                  setSelected(current => event.target.checked
                    ? [...current, item.nodeId]
                    : current.filter(id => id !== item.nodeId))
                }}
              />
              <span>
                <span className={css.badge}>Recommend {item.action}</span>
                <strong>{nodes.get(item.nodeId)?.preview ?? item.nodeId}</strong>
                <p>{item.reason} · {item.confidence} confidence</p>
              </span>
            </label>
            <button type="button" disabled={stale || pending} onClick={() => { run(() => apply([item.nodeId])) }}>Apply</button>
          </div>
        </article>)}
      </div>
      {proposal.selection.length > 0 && <div className={css.actions}>
        <button type="button" disabled={stale || pending || selected.length === 0} onClick={() => { run(() => apply(selected)) }}>Apply selected to next context</button>
      </div>}
    </section>
    <section className={css.section} aria-label="Cleanup recommendations">
      <h4>Cleanup candidates</h4>
      {proposal.cleanup.length === 0 && <div className={css.empty}>No cleanup candidates suggested.</div>}
      <div className={css.list}>
        {proposal.cleanup.filter(item => !kept.includes(item.nodeId)).map((item) => {
          const node = nodes.get(item.nodeId)
          const inbound = graph.edges.filter(edge => edge.target === item.nodeId).length
          const outbound = graph.edges.filter(edge => edge.source === item.nodeId).length
          return <article className={css.item} key={`cleanup:${item.nodeId}`}>
            <span className={`${css.badge} ${css.warning}`}>{item.category}</span><strong>{node?.preview ?? item.nodeId}</strong>
            <p>{item.reason}</p>
            {item.evidenceNodeIds.length > 0 && <p>Evidence: {item.evidenceNodeIds.map(id => nodes.get(id)?.preview ?? id).join(' · ')}</p>}
            <p>{inbound} incoming · {outbound} outgoing · {node?.sessionIds.length ?? 0} Sessions{outbound > 1 ? ' · branch pivot' : ''}</p>
            <div className={css.actions}>
              <button type="button" disabled={pending} onClick={() => { setKept(current => [...current, item.nodeId]) }}>Keep original</button>
              <button type="button" disabled={stale || pending} onClick={() => { setReviewing(item.nodeId) }}>Review replacement</button>
            </div>
            {reviewing === item.nodeId && <div className={css.editor}>
              <div className={css.preview}>
                <div><span>Before</span><p>{node?.preview ?? '(unavailable)'}</p></div>
                <div><span>After</span><p>Empty placeholder</p></div>
              </div>
              <div className={css.actions}>
                <button type="button" onClick={() => { setReviewing(null) }}>Cancel</button>
                <button type="button" disabled={stale || pending} onClick={() => { run(() => confirmCleanup(item)) }}>Confirm empty placeholder</button>
              </div>
            </div>}
          </article>
        })}
      </div>
    </section>
  </div>
}

/** Render only states that require user-visible review or recovery. */
export function ContextRecommendationReview(props: ContextRecommendationReviewProps) {
  if (props.state.phase === 'idle' || props.state.phase === 'running') return null
  if (props.state.phase === 'error') return <div className={css.sheet} role="alert">
    <div className={css.header}><div><h3>Recommendation failed</h3><p>{props.state.error}</p></div><button type="button" onClick={props.dismiss}>Close</button></div>
  </div>
  return <ProposalReview {...props} proposal={props.state.proposal} stale={props.state.phase === 'stale'} />
}

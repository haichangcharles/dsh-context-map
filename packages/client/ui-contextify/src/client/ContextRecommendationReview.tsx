/** Human review sheet for ephemeral Context Map recommendations. */
import { useEffect, useMemo, useState } from 'react'
import type {
  ContextArchiveCandidate, ContextFamilyGraph, ContextRecommendationProposal,
} from '@deepseek-ai/dsh-contextify/types'
import type { ContextRecommendationState } from './controller.ts'
import css from './ContextRecommendationReview.module.css'

export interface ContextRecommendationReviewProps {
  readonly state: ContextRecommendationState
  readonly graph: ContextFamilyGraph
  readonly pending: boolean
  readonly apply: () => Promise<void>
  readonly confirmArchive: (candidate: ContextArchiveCandidate) => Promise<void>
  readonly dismiss: () => void
  readonly reportError: (cause: unknown) => void
}

function ProposalReview({
  proposal, stale, graph, pending, apply, confirmArchive, dismiss, reportError,
}: Omit<ContextRecommendationReviewProps, 'state'> & {
  readonly proposal: ContextRecommendationProposal
  readonly stale: boolean
}) {
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [kept, setKept] = useState<readonly string[]>([])
  useEffect(() => {
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
        <span className={css.mode}>{proposal.mode === 'deep' ? 'Deep tree review' : 'Fast review'}</span>
        <p>Nothing changes until you apply the proposed context or confirm one archive.</p>
      </div>
      <button type="button" aria-label="Close recommendation review" onClick={dismiss}>×</button>
    </div>
    {stale && <div className={css.stale} role="alert">The conversation or Context Plan changed. Dismiss and run Recommend again.</div>}
    <section className={css.section} aria-label="Current and proposed context versions">
      <h4>Context replacement</h4>
      <div className={css.versionSummary}>
        <div><span>Current context</span><strong>{proposal.currentNodeIds.length} nodes</strong></div>
        <div><span>Proposed context</span><strong>{proposal.proposedNodeIds.length} nodes</strong></div>
      </div>
      <div className={css.diffSummary}>
        <span>{proposal.addedNodeIds.length} added</span>
        <span>{proposal.removedNodeIds.length} removed</span>
      </div>
      {proposal.selection.length === 0 && <div className={css.empty}>The proposed context matches the current version.</div>}
      <div className={css.list}>
        {proposal.selection.map(item => <article className={css.item} key={`${item.action}:${item.nodeId}`}>
          <span className={css.badge}>{item.action === 'include' ? 'Added' : 'Removed'}</span>
          <strong>{nodes.get(item.nodeId)?.preview ?? item.nodeId}</strong>
          <p>{item.reason}</p>
        </article>)}
      </div>
      {proposal.selection.length > 0 && <div className={css.actions}>
        <button type="button" disabled={stale || pending} onClick={() => { run(apply) }}>Apply proposed context</button>
      </div>}
    </section>
    <section className={css.section} aria-label="Archive recommendations">
      <h4>Archive candidates</h4>
      {proposal.archive.length === 0 && <div className={css.empty}>No archive candidates suggested.</div>}
      <div className={css.list}>
        {proposal.archive.filter(item => !kept.includes(item.nodeId)).map((item) => {
          const node = nodes.get(item.nodeId)
          const inbound = graph.edges.filter(edge => edge.target === item.nodeId).length
          const outbound = graph.edges.filter(edge => edge.source === item.nodeId).length
          return <article className={css.item} key={`archive:${item.nodeId}`}>
            <span className={`${css.badge} ${css.warning}`}>Archive</span><strong>{node?.preview ?? item.nodeId}</strong>
            <p>{item.reason}</p>
            {item.evidenceNodeIds.length > 0 && <p>Evidence: {item.evidenceNodeIds.map(id => nodes.get(id)?.preview ?? id).join(' · ')}</p>}
            <p>{inbound} incoming · {outbound} outgoing · {node?.sessionIds.length ?? 0} Sessions{outbound > 1 ? ' · branch pivot' : ''}</p>
            <div className={css.actions}>
              <button type="button" disabled={pending} onClick={() => { setKept(current => [...current, item.nodeId]) }}>Keep original</button>
              <button type="button" disabled={stale || pending} onClick={() => { setReviewing(item.nodeId) }}>Review archive</button>
            </div>
            {reviewing === item.nodeId && <div className={css.editor}>
              <div className={css.preview}>
                <div><span>Before</span><p>{node?.preview ?? '(unavailable)'}</p></div>
                <div><span>After</span><p>Empty placeholder</p></div>
              </div>
              <div className={css.actions}>
                <button type="button" onClick={() => { setReviewing(null) }}>Cancel</button>
                <button type="button" disabled={stale || pending} onClick={() => { run(() => confirmArchive(item)) }}>Archive node</button>
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
  if (props.state.phase === 'idle' || props.state.phase === 'running' || props.state.phase === 'error') return null
  return <ProposalReview {...props} proposal={props.state.proposal} stale={props.state.phase === 'stale'} />
}

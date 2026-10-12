/** Human review sheet for ephemeral Context Map recommendations. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContextArchiveCandidate, ContextFamilyGraph, ContextRecommendationProposal, ContextRouteAdvice,
} from '@deepseek-ai/dsh-contextify/types'
import type { ContextRecommendationState } from './controller.ts'
import css from './ContextRecommendationReview.module.css'

export interface ContextRecommendationReviewProps {
  readonly state: ContextRecommendationState
  readonly graph: ContextFamilyGraph
  readonly pending: boolean
  readonly acceptRoute: (route: ContextRouteAdvice) => Promise<void>
  readonly rejectRoute: (route: ContextRouteAdvice) => Promise<void>
  readonly present: (proposal: ContextRecommendationProposal) => Promise<void>
  readonly apply: (declinedNodeIds: readonly string[]) => Promise<void>
  readonly confirmArchive: (candidate: ContextArchiveCandidate) => Promise<void>
  readonly dismiss: (declinedNodeIds: readonly string[]) => Promise<void>
  readonly reportError: (cause: unknown) => void
}

function ProposalReview({
  proposal, stale, graph, pending, acceptRoute, rejectRoute, present, apply, confirmArchive, dismiss, reportError,
}: Omit<ContextRecommendationReviewProps, 'state'> & {
  readonly proposal: ContextRecommendationProposal
  readonly stale: boolean
}) {
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [kept, setKept] = useState<readonly string[]>([])
  const [keptCurrent, setKeptCurrent] = useState<readonly string[]>([])
  const [routeDismissed, setRouteDismissed] = useState(false)
  const presented = useRef<ContextRecommendationProposal | null>(null)
  useEffect(() => {
    if (stale) return
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || presented.current === proposal) return
      presented.current = proposal
      void present(proposal).catch((cause) => {
        if (presented.current === proposal) presented.current = null
        reportError(cause)
      })
    }
    onVisible()
    document.addEventListener('visibilitychange', onVisible)
    return () => { document.removeEventListener('visibilitychange', onVisible) }
  }, [proposal, stale, present, reportError])
  useEffect(() => {
    setReviewing(null)
    setKept([])
    setKeptCurrent([])
    setRouteDismissed(false)
  }, [proposal])
  const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes])
  const proposedNodeIds = useMemo(() => {
    const selected = new Set(proposal.proposedNodeIds)
    for (const item of proposal.selection) {
      if (!keptCurrent.includes(item.nodeId)) continue
      if (item.action === 'include') selected.delete(item.nodeId)
      else selected.add(item.nodeId)
    }
    return selected
  }, [proposal, keptCurrent])
  const currentNodeIds = new Set(proposal.currentNodeIds)
  const route = proposal.route
  const run = (operation: () => Promise<void>): void => {
    void operation().catch(reportError)
  }
  return <div className={css.sheet} role="dialog" aria-label="Context recommendation review">
    <div className={css.header}>
      <div>
        <h3>Review Context recommendations</h3>
        <span className={css.mode}>{proposal.mode === 'deep' ? 'Deep tree review' : 'Fast review'}</span>
        <p>Choose which context changes to apply. Nothing changes until you confirm.</p>
      </div>
      <button type="button" aria-label="Close recommendation review" onClick={() => { run(() => dismiss(keptCurrent)) }}>×</button>
    </div>
    {stale && <div className={css.stale} role="alert">The conversation or Context Plan changed. Dismiss and run Recommend again.</div>}
    {route !== undefined && !routeDismissed && <section className={css.section} aria-label="Draft route recommendation">
      <h4>Where this draft belongs</h4>
      <p>{route.reason}</p>
      <div className={css.actions}>
        <button type="button" disabled={stale || pending} onClick={() => {
          run(async () => { await rejectRoute(route); setRouteDismissed(true) })
        }}>Stay in this branch</button>
        <button type="button" disabled={stale || pending} onClick={() => { run(() => acceptRoute(route)) }}>
          {route.action === 'branch' ? 'Start a new branch'
            : route.action === 'return' ? 'Return with draft' : 'Move draft to branch'}
        </button>
      </div>
    </section>}
    <section className={css.section} aria-label="Current and proposed context versions">
      <h4>Context replacement</h4>
      <div className={css.versionSummary}>
        <div><span>Current context</span><strong>{proposal.currentNodeIds.length} nodes</strong></div>
        <div><span>Proposed context</span><strong>{proposedNodeIds.size} nodes</strong></div>
      </div>
      <div className={css.diffSummary}>
        <span>{[...proposedNodeIds].filter(id => !currentNodeIds.has(id)).length} added</span>
        <span>{proposal.currentNodeIds.filter(id => !proposedNodeIds.has(id)).length} removed</span>
      </div>
      {proposal.selection.length === 0 && <div className={css.empty}>The proposed context matches the current version.</div>}
      <div className={css.list}>
        {proposal.selection.map(item => <article className={css.item} key={`${item.action}:${item.nodeId}`}>
          <span className={css.badge}>{keptCurrent.includes(item.nodeId) ? 'Keep current' : item.action === 'include' ? 'Added' : 'Removed'}</span>
          <strong>{nodes.get(item.nodeId)?.preview ?? item.nodeId}</strong>
          <p>{item.reason}</p>
          <div className={css.actions}>
            <button type="button" aria-pressed={keptCurrent.includes(item.nodeId)}
              aria-label={(keptCurrent.includes(item.nodeId) ? 'Use proposed change for ' : 'Keep current context for ')
                + (nodes.get(item.nodeId)?.preview ?? item.nodeId)}
              disabled={stale || pending}
              onClick={() => { setKeptCurrent(current => current.includes(item.nodeId)
                ? current.filter(id => id !== item.nodeId) : [...current, item.nodeId]) }}
            >{keptCurrent.includes(item.nodeId) ? 'Use proposed change' : 'Keep current'}</button>
          </div>
        </article>)}
      </div>
      {proposal.selection.length > 0 && <div className={css.actions}>
        <button type="button" disabled={stale || pending} onClick={() => { run(() => apply(keptCurrent)) }}>
          {keptCurrent.length === 0 ? 'Apply proposed context'
            : keptCurrent.length === proposal.selection.length ? 'Keep current context' : 'Apply selected changes'}
        </button>
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

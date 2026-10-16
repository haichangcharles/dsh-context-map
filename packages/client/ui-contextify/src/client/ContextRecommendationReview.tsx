/** Human review sheet for ephemeral Context Map recommendations. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ContextArchiveCandidate, ContextFamilyGraph, ContextRecommendationProposal, ContextRouteAdvice,
} from '@deepseek-ai/dsh-contextify/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import './locales.ts'
import type { ContextRecommendationState } from './controller.ts'
import css from './ContextRecommendationReview.module.css'

export interface ContextRecommendationReviewProps extends PropsLocale<'contextifySteward'> {
  readonly reviewWorkState: (proposal: ContextRecommendationProposal, sessionId: ContextFamilyGraph['activeSessionId'], choice: 'accept' | 'reject') => Promise<void>
  readonly state: ContextRecommendationState
  readonly graph: ContextFamilyGraph
  readonly pending: boolean
  readonly acceptRoute: (route: ContextRouteAdvice, carryContext?: boolean) => Promise<void>
  readonly rejectRoute: (route: ContextRouteAdvice) => Promise<void>
  readonly present: (proposal: ContextRecommendationProposal) => Promise<void>
  readonly apply: (declinedNodeIds: readonly string[]) => Promise<void>
  readonly confirmArchive: (candidate: ContextArchiveCandidate) => Promise<void>
  readonly dismiss: (declinedNodeIds: readonly string[]) => Promise<void>
  readonly reportError: (cause: unknown) => void
}

function ProposalReview({
  proposal, stale, graph, pending, acceptRoute, rejectRoute, present, apply, confirmArchive, dismiss, reportError, reviewWorkState, t,
}: Omit<ContextRecommendationReviewProps, 'state'> & {
  readonly proposal: ContextRecommendationProposal
  readonly stale: boolean
}) {
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [kept, setKept] = useState<readonly string[]>([])
  const [keptCurrent, setKeptCurrent] = useState<readonly string[]>([])
  const [reviewedStates, setReviewedStates] = useState<readonly string[]>([])
  const [routeDismissed, setRouteDismissed] = useState(false)
  const presented = useRef<ContextRecommendationProposal | null>(null)
  useEffect(() => {
    if (stale) return
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || presented.current === proposal) return
      presented.current = proposal
      void present(proposal).catch((cause: unknown) => {
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
    setReviewedStates([])
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
  return <div className={css.sheet} role="dialog" aria-label={t('copy.contextRecommendationReview')}>
    <div className={css.header}>
      <div>
        <h3>{t('copy.reviewContextRecommendations')}</h3>
        <span className={css.mode}>{t(proposal.mode === 'deep' ? 'mode.deep' : proposal.mode === 'fast' ? 'mode.fast' : 'mode.local')}</span>
        <p>{t('copy.chooseWhichContextChangesToApplyNothingChanges')}</p>
      </div>
      <button type="button" aria-label={t('copy.closeRecommendationReview')} onClick={() => { run(() => dismiss(keptCurrent)) }}>×</button>
    </div>
    {stale && <div className={css.stale} role="alert">{t('copy.theConversationOrContextPlanChangedDismissAnd')}</div>}
    {proposal.personalization !== undefined && <details className={css.section}>
      <summary>{t('memory.title')} · {proposal.personalization.examples.length}</summary>
      <p>{t('memory.hint')}</p>
      {!proposal.personalization.enabled ? <p>{t('memory.disabled')}</p>
        : proposal.personalization.examples.length === 0 ? <p>{t('memory.empty')}</p>
          : <ul>{proposal.personalization.examples.map((example, index) => <li key={index}>
            <strong>{example.objective}</strong>
            <p>{t(example.action === 'exclude' ? 'policy.action.release' : `policy.action.${example.action}`)}</p>
            {example.choice !== undefined && <small>{t(`policy.${example.choice}`)}</small>}
            {example.content !== undefined && <p>{example.content}</p>}
            {example.sourceSessionId !== undefined && <small>{example.sourceSessionId}:{example.sourceEventSeq}</small>}
          </li>)}</ul>}
      {(proposal.personalization.calibrationSources?.length ?? 0) > 0 && <details>
        <summary>{t('memory.calibration')} · {proposal.personalization.calibrationSources?.length}</summary>
        <ul>{proposal.personalization.calibrationSources?.map(source => <li key={source}>{source}</li>)}</ul>
      </details>}
      {(proposal.personalization.thresholdSources?.length ?? 0) > 0 && <details>
        <summary>{t('memory.thresholds')} · {proposal.personalization.thresholdSources?.length}</summary>
        <ul>{proposal.personalization.thresholdSources?.map(source => <li key={source}>{source}</li>)}</ul>
      </details>}
    </details>}
    {route !== undefined && !routeDismissed && <section className={css.section} aria-label={t('copy.draftRouteRecommendation')}>
      <h4>{t('copy.whereThisDraftBelongs')}</h4>
      <p>{route.reason}</p>
      <div className={css.actions}>
        <button type="button" disabled={stale || pending} onClick={() => {
          run(async () => { await rejectRoute(route); setRouteDismissed(true) })
        }}>{t('copy.stayInThisBranch')}</button>
        <button type="button" disabled={stale || pending} onClick={() => { run(() => acceptRoute(route)) }}>
          {route.action === 'branch' ? t('copy.startANewBranch')
            : route.action === 'return' ? t('copy.returnWithDraft') : t('copy.moveDraftToBranch')}
        </button>
        {route.action !== 'branch' && <button type="button" disabled={stale || pending || keptCurrent.length > 0}
          title={t('copy.carryContextHint')} onClick={() => { run(() => acceptRoute(route, true)) }}>
          {t('copy.moveDraftWithContext')}
        </button>}
      </div>
    </section>}
    {(proposal.workStates?.length ?? 0) > 0 && <section className={css.section} aria-label={t('lifecycle.title')}>
      <h4>{t('lifecycle.title')}</h4>
      <p>{t('lifecycle.hint')}</p>
      {proposal.workStates?.filter(item => !reviewedStates.includes(item.sessionId)).map(item => <article
        className={css.item} key={item.sessionId}>
        <strong>{graph.sessions.find(session => session.id === item.sessionId)?.depth === 0
          ? t('branch.mainline') : graph.nodes.find(node => node.owner.sessionId === item.sessionId && node.role === 'user')?.preview ?? item.sessionId}</strong>
        <p>{item.reason}</p>
        <div className={css.actions}>
          <button type="button" disabled={stale || pending} onClick={() => { run(async () => {
            await reviewWorkState(proposal, item.sessionId, 'reject')
            setReviewedStates(current => [...current, item.sessionId])
          }) }}>{t('lifecycle.keep')}</button>
          <button type="button" disabled={stale || pending} onClick={() => { run(async () => {
            await reviewWorkState(proposal, item.sessionId, 'accept')
            setReviewedStates(current => [...current, item.sessionId])
          }) }}>{t(item.state === 'completed' ? 'lifecycle.completed' : item.state === 'parked' ? 'lifecycle.parked' : 'lifecycle.open')}</button>
        </div>
      </article>)}
    </section>}
    <section className={css.section} aria-label={t('copy.currentAndProposedContextVersions')}>
      <h4>{t('copy.contextReplacement')}</h4>
      <div className={css.versionSummary}>
        <div><span>{t('copy.currentContext')}</span><strong>{t('format.nodes', { count: proposal.currentNodeIds.length })}</strong></div>
        <div><span>{t('copy.proposedContext')}</span><strong>{t('format.nodes', { count: proposedNodeIds.size })}</strong></div>
      </div>
      <div className={css.diffSummary}>
        <span>{t('format.added', { count: [...proposedNodeIds].filter(id => !currentNodeIds.has(id)).length })}</span>
        <span>{t('format.removed', { count: proposal.currentNodeIds.filter(id => !proposedNodeIds.has(id)).length })}</span>
      </div>
      {proposal.selection.length === 0 && <div className={css.empty}>{t('copy.theProposedContextMatchesTheCurrentVersion')}</div>}
      <div className={css.list}>
        {proposal.selection.map(item => <article className={css.item} key={`${item.action}:${item.nodeId}`}>
          <span className={css.badge}>{keptCurrent.includes(item.nodeId) ? t('copy.keepCurrent') : item.action === 'include' ? t('copy.added2') : t('copy.removed2')}</span>
          <strong>{nodes.get(item.nodeId)?.preview ?? item.nodeId}</strong>
          <p>{item.reason}</p>
          <div className={css.actions}>
            <button type="button" aria-pressed={keptCurrent.includes(item.nodeId)}
              aria-label={t(keptCurrent.includes(item.nodeId) ? 'format.useProposed' : 'format.keepCurrent',
                { preview: nodes.get(item.nodeId)?.preview ?? item.nodeId })}
              disabled={stale || pending}
              onClick={() => { setKeptCurrent(current => current.includes(item.nodeId)
                ? current.filter(id => id !== item.nodeId) : [...current, item.nodeId]) }}
            >{keptCurrent.includes(item.nodeId) ? t('copy.useProposedChange') : t('copy.keepCurrent')}</button>
          </div>
        </article>)}
      </div>
      {proposal.selection.length > 0 && <div className={css.actions}>
        <button type="button" disabled={stale || pending} onClick={() => { run(() => apply(keptCurrent)) }}>
          {keptCurrent.length === 0 ? t('copy.applyProposedContext')
            : keptCurrent.length === proposal.selection.length ? t('copy.keepCurrentContext') : t('copy.applySelectedChanges')}
        </button>
      </div>}
    </section>
    <section className={css.section} aria-label={t('copy.archiveRecommendations')}>
      <h4>{t('copy.archiveCandidates')}</h4>
      {proposal.archive.length === 0 && <div className={css.empty}>{t('copy.noArchiveCandidatesSuggested')}</div>}
      <div className={css.list}>
        {proposal.archive.filter(item => !kept.includes(item.nodeId)).map((item) => {
          const node = nodes.get(item.nodeId)
          const inbound = graph.edges.filter(edge => edge.target === item.nodeId).length
          const outbound = graph.edges.filter(edge => edge.source === item.nodeId).length
          return <article className={css.item} key={`archive:${item.nodeId}`}>
            <span className={`${css.badge} ${css.warning}`}>{t('copy.archive')}</span><strong>{node?.preview ?? item.nodeId}</strong>
            <p>{item.reason}</p>
            {item.evidenceNodeIds.length > 0 && <p>{t('format.evidence', { evidence: item.evidenceNodeIds.map(id => nodes.get(id)?.preview ?? id).join(' · ') })}</p>}
            <p>{t('format.archiveRelations', { incoming: inbound, outgoing: outbound,
              sessions: node?.sessionIds.length ?? 0, pivot: outbound > 1 ? t('copy.branchPivot') : '' })}</p>
            <div className={css.actions}>
              <button type="button" disabled={pending} onClick={() => { setKept(current => [...current, item.nodeId]) }}>{t('copy.keepOriginal')}</button>
              <button type="button" disabled={stale || pending} onClick={() => { setReviewing(item.nodeId) }}>{t('copy.reviewArchive')}</button>
            </div>
            {reviewing === item.nodeId && <div className={css.editor}>
              <div className={css.preview}>
                <div><span>{t('copy.before')}</span><p>{node?.preview ?? t('copy.unavailable')}</p></div>
                <div><span>{t('copy.after')}</span><p>{t('copy.emptyPlaceholder2')}</p></div>
              </div>
              <div className={css.actions}>
                <button type="button" onClick={() => { setReviewing(null) }}>{t('copy.cancel')}</button>
                <button type="button" disabled={stale || pending} onClick={() => { run(() => confirmArchive(item)) }}>{t('copy.archiveNode')}</button>
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

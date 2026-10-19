/** Shared observable bridge between Chat actions, Context Map, and Contextify Remote. */
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ContextBranchRelocationResult,
  ContextBranchRelocationPreparation,
  ContextFamilyGraph,
  ContextFamilyGraphPage,
  ContextMessageRef,
  ContextNodeMutation,
  ContextPlanRef,
  ContextRecommendationBase,
  ContextArchiveCandidate,
  ContextRecommendationMode,
  ContextRecommendationProposal,
  ContextifyView,
} from '@deepseek-ai/dsh-contextify/types'

/** Plain transport boundary used by the browser adapter and deterministic tests. */
export interface ContextifyTransport {
  get: () => Promise<ContextifyView>
  familyPage: (after?: number, limit?: number) => Promise<ContextFamilyGraphPage>
  setNodeMode: (
    ref: ContextPlanRef,
    node: ContextMessageRef,
    mode: 'natural' | 'include' | 'exclude',
  ) => Promise<ContextifyView>
  setNodeModes: (
    ref: ContextPlanRef,
    mutations: readonly ContextNodeMutation[],
    expectedGraphRevision?: string,
    reviewedDeclinedNodeIds?: readonly string[],
  ) => Promise<ContextifyView>
  reset: (ref: ContextPlanRef) => Promise<ContextifyView>
  undo: (ref: ContextPlanRef) => Promise<ContextifyView>
  redo: (ref: ContextPlanRef) => Promise<ContextifyView>
  recommend: (
    base: ContextRecommendationBase,
    objective?: string,
    mode?: ContextRecommendationMode,
    draftBound?: boolean,
  ) => Promise<ContextRecommendationProposal>
  cancelRecommendation: () => Promise<void>
  presentRecommendation: (proposal: ContextRecommendationProposal) => Promise<void>
  dismissRecommendation: (
    proposal: ContextRecommendationProposal, declinedNodeIds?: readonly string[],
  ) => Promise<void>
  archiveNode: (
    ref: ContextPlanRef,
    node: ContextMessageRef,
    reason: string,
    expectedGraphRevision?: string,
  ) => Promise<ContextifyView>
  getNodeText: (node: ContextMessageRef) => Promise<string>
  focusNodeExcerpt: (
    ref: ContextPlanRef,
    node: ContextMessageRef,
    start: number,
    end: number,
    reason: string,
  ) => Promise<ContextifyView>
  restoreNode: (ref: ContextPlanRef, node: ContextMessageRef) => Promise<ContextifyView>
  prepareBranchSuggestion: (suggestionId: string) => Promise<ContextBranchRelocationPreparation>
  keepBranchSuggestion: (suggestionId: string) => Promise<void>
  forkNativeBranch: (preparation: ContextBranchRelocationPreparation) => Promise<SessionId>
  acceptBranchSuggestion: (
    suggestionId: string,
    childSessionId: SessionId,
  ) => Promise<ContextBranchRelocationResult>
}

/** Ephemeral review state. Recommendations never mutate the Context Plan by themselves. */
export type ContextRecommendationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly mode: ContextRecommendationMode }
  | { readonly phase: 'ready'; readonly proposal: ContextRecommendationProposal }
  | { readonly phase: 'stale'; readonly proposal: ContextRecommendationProposal }
  | { readonly phase: 'error'; readonly mode: ContextRecommendationMode; readonly error: string }

/** One immutable publication consumed by both right-panel and Chat controls. */
export interface ContextifyControllerSnapshot {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly pending: boolean
  readonly view?: ContextifyView
  readonly graph?: ContextFamilyGraph
  readonly graphRevision?: string
  readonly focusedNodeId?: string
  /** UI-only request counter, allowing repeated Map focus on the same node. */
  readonly focusRevision?: number
  readonly error?: string
  readonly recommendation: ContextRecommendationState
}

const REFRESH_MS = 1_500

/** Require a loaded controller value, preserving an actual transport failure. */
function requireLoaded<T>(value: T | undefined, message?: string): T {
  if (value === undefined) throw new Error(message)
  return value
}

/** Apply-owned Contextify state machine for one active native Session. */
export class ContextifyController {
  private snapshot: ContextifyControllerSnapshot = Object.freeze({
    phase: 'loading', pending: false, recommendation: Object.freeze({ phase: 'idle' }),
  })
  private readonly listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private recommendationRequest = 0

  constructor(private readonly transport: ContextifyTransport) {}

  /** Read the cache-stable publication shared by every mounted Contextify surface.
   * @returns The current immutable controller snapshot.
   */
  getSnapshot = (): ContextifyControllerSnapshot => this.snapshot

  /** Subscribe and keep bounded graph polling alive while at least one surface is mounted. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      void this.refresh()
      this.timer = setInterval(() => { void this.refresh() }, REFRESH_MS)
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size !== 0 || this.timer === undefined) return
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Load one view plus every bounded native-family page and publish once. */
  refresh(): Promise<void> {
    if (this.refreshPromise !== undefined) return this.refreshPromise
    if (this.snapshot.pending) return Promise.resolve()
    const task = this.load().finally(() => {
      // One deduplicated task is the sole publisher until this finally settles.
      this.refreshPromise = undefined
    })
    this.refreshPromise = task
    return task
  }

  /** Publish a graph focus target without changing durable context.
   * @param nodeId - Graph node to focus, or `undefined` to clear the focus target.
   */
  focus(nodeId: string | undefined): void {
    const { focusedNodeId: _focusedNodeId, ...snapshot } = this.snapshot
    this.publish({ ...snapshot, focusRevision: (this.snapshot.focusRevision ?? 0) + 1,
      ...(nodeId === undefined ? {} : { focusedNodeId: nodeId }) })
  }

  /** Change one message's durable Context Plan mode.
   * @param node - Native Session message to change.
   * @param mode - Natural, included, or excluded compilation behavior.
   * @returns A promise that settles after the shared view refreshes.
   */
  async setNodeMode(node: ContextMessageRef, mode: ContextNodeMutation['mode']): Promise<void> {
    await this.mutate(ref => this.transport.setNodeMode(ref, node, mode))
  }

  /** Change several message modes in one durable plan revision.
   * @param mutations - Message-mode changes committed atomically by the Remote.
   * @returns A promise that settles after the shared view refreshes.
   */
  async setNodeModes(mutations: readonly ContextNodeMutation[]): Promise<void> {
    await this.mutate(ref => this.transport.setNodeModes(ref, mutations))
  }

  /** Reset all explicit modes to Natural.
   * @returns A promise that settles after the shared view refreshes.
   */
  async reset(): Promise<void> { await this.mutate(ref => this.transport.reset(ref)) }
  /** Restore the previous durable Context Plan revision.
   * @returns A promise that settles after the shared view refreshes.
   */
  async undo(): Promise<void> { await this.mutate(ref => this.transport.undo(ref)) }
  /** Reapply the next durable Context Plan revision.
   * @returns A promise that settles after the shared view refreshes.
   */
  async redo(): Promise<void> { await this.mutate(ref => this.transport.redo(ref)) }

  /**
   * Run an isolated, review-only Context recommendation after a fresh graph read.
   * A newer preflight or clear discards an undispatched request; pending writes and failed reads refuse review.
   * @param mode - Manually selected Local, bounded Fast, or full-tree Deep review.
   * @param objective - Optional review objective forwarded to the isolated Agent.
   * @param draftBound - Whether the review must remain bound to the current unsent draft.
   */
  async recommend(mode: ContextRecommendationMode = 'local', objective?: string,
    draftBound = false): Promise<void> {
    if (this.snapshot.recommendation.phase === 'running') {
      throw new Error('Context recommendation is already running')
    }
    if (this.snapshot.pending) throw new Error('Context Map mutation is already pending')
    const request = ++this.recommendationRequest
    await this.refresh()
    if (request !== this.recommendationRequest) return
    const snapshot = this.getSnapshot()
    if (snapshot.pending) throw new Error('Context Map mutation is already pending')
    const { view, graph, graphRevision } = snapshot
    if (snapshot.phase !== 'ready' || view === undefined || graph === undefined || graphRevision === undefined) {
      throw new Error(snapshot.error)
    }
    const base: ContextRecommendationBase = Object.freeze({
      planRevision: view.plan.revision,
      graphRevision,
      activeSessionId: graph.activeSessionId,
    })
    this.publish({ ...this.snapshot, recommendation: Object.freeze({ phase: 'running', mode }) })
    try {
      const proposal = await this.transport.recommend(base, objective, mode, draftBound)
      if (request !== this.recommendationRequest) return
      const stale = this.isProposalStale(proposal)
      this.publish({
        ...this.snapshot,
        recommendation: Object.freeze({ phase: stale ? 'stale' : 'ready', proposal }),
      })
    } catch (cause) {
      if (request !== this.recommendationRequest) return
      const error = cause instanceof Error ? cause.message : String(cause)
      this.publish({ ...this.snapshot, recommendation: Object.freeze({ phase: 'error', mode, error }) })
      throw cause
    }
  }

  /** Cancel one running Deep review without affecting the conversation Agent. */
  async cancelRecommendation(): Promise<void> {
    const recommendation = this.snapshot.recommendation
    if (recommendation.phase !== 'running' || recommendation.mode !== 'deep') {
      throw new Error('Only a running Deep recommendation can be cancelled')
    }
    const request = ++this.recommendationRequest
    try {
      await this.transport.cancelRecommendation()
      if (request === this.recommendationRequest) {
        this.publish({ ...this.snapshot, recommendation: Object.freeze({ phase: 'idle' }) })
      }
    } catch (cause) {
      if (request === this.recommendationRequest) {
        this.publish({
          ...this.snapshot,
          recommendation: Object.freeze({
            phase: 'error', mode: 'deep', error: cause instanceof Error ? cause.message : String(cause),
          }),
        })
      }
      throw cause
    }
  }

  /** Dismiss the current transient recommendation without changing durable context. */
  clearRecommendation(): void {
    this.recommendationRequest += 1
    this.publish({ ...this.snapshot, recommendation: Object.freeze({ phase: 'idle' }) })
  }

  /** Record that this exact review was rendered in a visible Client document.
   * @param proposal - The proposal shown to the user.
   */
  async presentRecommendation(proposal: ContextRecommendationProposal): Promise<void> {
    const recommendation = this.snapshot.recommendation
    if (recommendation.phase !== 'ready' || recommendation.proposal !== proposal) return
    await this.transport.presentRecommendation(proposal)
  }

  /** Persist only an explicit review-sheet closure before clearing the Client proposal.
   * @param declinedNodeIds - Items explicitly marked Keep current; an empty list means Later.
   */
  async dismissRecommendation(declinedNodeIds: readonly string[] = []): Promise<void> {
    const recommendation = this.snapshot.recommendation
    if (recommendation.phase !== 'ready' && recommendation.phase !== 'stale') {
      throw new Error('No Context recommendation is open for review')
    }
    await this.transport.dismissRecommendation(recommendation.proposal, declinedNodeIds)
    if (this.snapshot.recommendation === recommendation) this.clearRecommendation()
  }

  /**
   * Replace the effective Context version in one atomic Context Plan revision.
   * @param declinedNodeIds - Proposed items the user explicitly declined.
   */
  async applyRecommendations(declinedNodeIds: readonly string[] = []): Promise<void> {
    const recommendation = this.snapshot.recommendation
    if (recommendation.phase === 'stale') throw new Error('Context recommendation is stale')
    if (recommendation.phase !== 'ready') throw new Error('No Context recommendation is ready')
    const graph = requireLoaded(this.snapshot.graph, 'Context Map is unavailable')
    const declined = new Set(declinedNodeIds)
    if (declined.size !== declinedNodeIds.length
      || declinedNodeIds.some(id => !recommendation.proposal.selection.some(item => item.nodeId === id))) {
      throw new Error('Keep-current choices must belong to the current recommendation')
    }
    const accepted = recommendation.proposal.selection.filter(item => !declined.has(item.nodeId))
    const byId = new Map(graph.nodes.map(node => [node.id, node]))
    const mutations = accepted.map((item): ContextNodeMutation => {
      const node = byId.get(item.nodeId)
      if (node === undefined) throw new Error(`Recommendation references missing node: ${item.nodeId}`)
      const active = node.sessionIds.includes(graph.activeSessionId)
      const desired = item.action === 'include'
      return {
        node: node.owner,
        mode: desired === active ? 'natural' : desired ? 'include' : 'exclude',
      }
    })
    try {
      await this.mutate(ref => this.transport.setNodeModes(
        ref, mutations, recommendation.proposal.base.graphRevision, declinedNodeIds,
      ))
    } catch (cause) {
      this.publish({
        ...this.snapshot,
        recommendation: Object.freeze({ phase: 'stale', proposal: recommendation.proposal }),
      })
      throw cause
    }
    this.clearRecommendation()
  }

  /**
   * Confirm exactly one archive candidate; there is deliberately no bulk archive API.
   * @param candidate - Proposal-owned archive item being explicitly confirmed.
   */
  async confirmArchive(candidate: ContextArchiveCandidate): Promise<void> {
    const recommendation = this.snapshot.recommendation
    if (recommendation.phase === 'stale') throw new Error('Context recommendation is stale')
    if (recommendation.phase !== 'ready'
      || !recommendation.proposal.archive.some(item => item.nodeId === candidate.nodeId)) {
      throw new Error('Archive candidate is unavailable')
    }
    const node = this.snapshot.graph?.nodes.find(item => item.id === candidate.nodeId)
    if (node === undefined) throw new Error(`Archive candidate references missing node: ${candidate.nodeId}`)
    try {
      await this.mutate(ref => this.transport.archiveNode(
        ref, node.owner, candidate.reason,
        recommendation.proposal.base.graphRevision,
      ))
      this.clearRecommendation()
    } catch (cause) {
      this.publish({
        ...this.snapshot,
        recommendation: Object.freeze({ phase: 'stale', proposal: recommendation.proposal }),
      })
      throw cause
    }
  }

  /**
   * Archive one input or final output using the fixed server-owned placeholder.
   * @param node - Native family message whose model-visible semantics are removed.
   */
  async archiveNode(node: ContextMessageRef): Promise<void> {
    await this.mutate(ref => this.transport.archiveNode(
      ref, node, 'Archived by user', this.snapshot.graphRevision,
    ))
  }

  /** Read the exact source text so the user can select a provenance-bound span.
   * @param node - Source message in the native Session family.
   * @returns The source text from the Host.
   */
  getNodeText(node: ContextMessageRef): Promise<string> {
    return this.transport.getNodeText(node)
  }

  /** Commit one user-selected source span as a reversible Context Plan overlay.
   * @param node - Source message in the native Session family.
   * @param start - Start offset of the selected span.
   * @param end - End offset of the selected span.
   */
  async focusNodeExcerpt(node: ContextMessageRef, start: number, end: number): Promise<void> {
    await this.mutate(ref => this.transport.focusNodeExcerpt(
      ref, node, start, end, 'Focused by user',
    ))
  }

  /**
   * Accept one durable post-Turn suggestion and refresh the native family.
   * @param suggestionId - Suggestion identity exposed by the Host view.
   * @returns The native Branch relocation result.
   */
  async acceptBranchSuggestion(suggestionId: string): Promise<ContextBranchRelocationResult> {
    const preparation = await this.transport.prepareBranchSuggestion(suggestionId)
    const childSessionId = await this.transport.forkNativeBranch(preparation)
    const result = await this.transport.acceptBranchSuggestion(suggestionId, childSessionId)
    await this.refresh()
    return result
  }

  /**
   * Persist one explicit Keep choice and refresh the visible suggestion.
   * @param suggestionId - Suggestion identity exposed by the Host view.
   */
  async keepBranchSuggestion(suggestionId: string): Promise<void> {
    await this.transport.keepBranchSuggestion(suggestionId)
    await this.refresh()
  }

  /**
   * Restore one placeholder or excerpt overlay without changing Include/Exclude.
   * @param node - Native family message whose original semantics are restored.
   */
  async restoreNode(node: ContextMessageRef): Promise<void> {
    await this.mutate(ref => this.transport.restoreNode(ref, node))
  }

  private async load(): Promise<void> {
    try {
      const receivedView = await this.transport.get()
      const previousPlan = this.snapshot.view?.plan
      const view = previousPlan !== undefined && deepEqualJson(previousPlan, receivedView.plan)
        ? Object.freeze({ ...receivedView, plan: previousPlan }) : receivedView
      const nodes = []
      let first: ContextFamilyGraphPage | undefined
      let after: number | undefined
      for (;;) {
        const page = await this.transport.familyPage(after, 500)
        first ??= page
        if (page.revision !== first.revision) throw new Error('Context Map changed while pages were loading')
        nodes.push(...page.records)
        if (page.nextAfter === undefined) break
        after = page.nextAfter
      }
      const receivedGraph: ContextFamilyGraph = Object.freeze({
        rootSessionId: first.rootSessionId,
        activeSessionId: first.activeSessionId,
        sessions: Object.freeze([...first.sessions]),
        edges: Object.freeze([...first.edges]),
        nodes: Object.freeze(nodes),
      })
      const graph = this.snapshot.graph !== undefined && deepEqualJson(this.snapshot.graph, receivedGraph)
        ? this.snapshot.graph : receivedGraph
      const graphRevision = first.revision
      const recommendation = this.reconcileRecommendation(view, graph, graphRevision)
      this.publish(Object.freeze({
        phase: 'ready',
        pending: this.snapshot.pending,
        view,
        graph,
        graphRevision,
        recommendation,
        ...(this.snapshot.focusedNodeId === undefined ? {} : { focusedNodeId: this.snapshot.focusedNodeId }),
        ...(this.snapshot.focusRevision === undefined ? {} : { focusRevision: this.snapshot.focusRevision }),
      }))
    } catch (cause) {
      this.publish(Object.freeze({
        ...this.snapshot,
        phase: 'error',
        error: cause instanceof Error ? cause.message : String(cause),
      }))
    }
  }

  private async mutate(operation: (ref: ContextPlanRef) => Promise<ContextifyView>): Promise<void> {
    if (this.snapshot.pending) throw new Error('Context Map mutation is already pending')
    if (this.refreshPromise !== undefined) await this.refreshPromise
    if (this.snapshot.view === undefined) await this.refresh()
    const view = requireLoaded(this.snapshot.view, this.snapshot.error)
    this.publish({ ...this.snapshot, pending: true })
    try {
      const next = await operation({ revision: view.plan.revision })
      const { error: _error, ...withoutError } = this.snapshot
      this.publish({ ...withoutError, view: next, pending: false })
      await this.refresh()
    } catch (cause) {
      this.publish({
        ...this.snapshot,
        pending: false,
        error: cause instanceof Error ? cause.message : String(cause),
      })
      throw cause
    }
  }

  private publish(snapshot: ContextifyControllerSnapshot): void {
    // Graph revision does not cover every view or recommendation field.
    if (deepEqualJson(this.snapshot, snapshot)) return
    this.snapshot = Object.freeze(snapshot)
    for (const listener of [...this.listeners]) listener()
  }

  private reconcileRecommendation(
    view: ContextifyView,
    graph: ContextFamilyGraph,
    graphRevision: string,
  ): ContextRecommendationState {
    const current = this.snapshot.recommendation
    if (current.phase !== 'ready' && current.phase !== 'stale') return current
    return Object.freeze({
      phase: this.isProposalStale(current.proposal, view, graph, graphRevision) ? 'stale' : current.phase,
      proposal: current.proposal,
    })
  }

  private isProposalStale(
    proposal: ContextRecommendationProposal,
    view = this.snapshot.view,
    graph = this.snapshot.graph,
    graphRevision = this.snapshot.graphRevision,
  ): boolean {
    return view === undefined || graph === undefined || graphRevision === undefined
      || proposal.base.planRevision !== view.plan.revision
      || proposal.base.graphRevision !== graphRevision
      || proposal.base.activeSessionId !== graph.activeSessionId
  }
}

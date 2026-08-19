/** Shared observable bridge between Chat actions, Context Map, and Contextify Remote. */
import type {
  ContextFamilyGraph,
  ContextFamilyGraphPage,
  ContextMessageRef,
  ContextNodeMutation,
  ContextPlanRef,
  ContextRecommendationBase,
  ContextCleanupCandidate,
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
  ) => Promise<ContextifyView>
  reset: (ref: ContextPlanRef) => Promise<ContextifyView>
  undo: (ref: ContextPlanRef) => Promise<ContextifyView>
  redo: (ref: ContextPlanRef) => Promise<ContextifyView>
  recommend: (
    base: ContextRecommendationBase,
    objective?: string,
  ) => Promise<ContextRecommendationProposal>
  replaceNode: (
    ref: ContextPlanRef,
    node: ContextMessageRef,
    reason: string,
    expectedGraphRevision?: string,
  ) => Promise<ContextifyView>
  restoreNode: (ref: ContextPlanRef, node: ContextMessageRef) => Promise<ContextifyView>
}

/** Ephemeral review state. Recommendations never mutate the Context Plan by themselves. */
export type ContextRecommendationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running' }
  | { readonly phase: 'ready'; readonly proposal: ContextRecommendationProposal }
  | { readonly phase: 'stale'; readonly proposal: ContextRecommendationProposal }
  | { readonly phase: 'error'; readonly error: string }

/** One immutable publication consumed by both right-panel and Chat controls. */
export interface ContextifyControllerSnapshot {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly pending: boolean
  readonly view?: ContextifyView
  readonly graph?: ContextFamilyGraph
  readonly graphRevision?: string
  readonly focusedNodeId?: string
  readonly error?: string
  readonly recommendation: ContextRecommendationState
}

const REFRESH_MS = 1_500

/** Apply-owned Contextify state machine for one active native Session. */
export class ContextifyController {
  private snapshot: ContextifyControllerSnapshot = Object.freeze({
    phase: 'loading', pending: false, recommendation: Object.freeze({ phase: 'idle' }),
  })
  private readonly listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined

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
      if (this.refreshPromise === task) this.refreshPromise = undefined
    })
    this.refreshPromise = task
    return task
  }

  /** Publish a graph focus target without changing durable context.
   * @param nodeId - Graph node to focus, or `undefined` to clear the focus target.
   */
  focus(nodeId: string | undefined): void {
    const { focusedNodeId: _focusedNodeId, ...snapshot } = this.snapshot
    this.publish({ ...snapshot, ...(nodeId === undefined ? {} : { focusedNodeId: nodeId }) })
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
   * Run an isolated, review-only Context recommendation against the current revision.
   * @param objective - Optional review objective forwarded to the isolated Agent.
   */
  async recommend(objective?: string): Promise<void> {
    if (this.snapshot.recommendation.phase === 'running') {
      throw new Error('Context recommendation is already running')
    }
    if (this.refreshPromise !== undefined) await this.refreshPromise
    if (this.snapshot.view === undefined || this.snapshot.graph === undefined) await this.refresh()
    const { view, graph, graphRevision } = this.snapshot
    if (view === undefined || graph === undefined || graphRevision === undefined) {
      throw new Error(this.snapshot.error ?? 'Context Map is unavailable')
    }
    const base: ContextRecommendationBase = Object.freeze({
      planRevision: view.plan.revision,
      graphRevision,
      activeSessionId: graph.activeSessionId,
    })
    this.publish({ ...this.snapshot, recommendation: Object.freeze({ phase: 'running' }) })
    try {
      const proposal = await this.transport.recommend(base, objective)
      const stale = this.isProposalStale(proposal)
      this.publish({
        ...this.snapshot,
        recommendation: Object.freeze({ phase: stale ? 'stale' : 'ready', proposal }),
      })
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      this.publish({ ...this.snapshot, recommendation: Object.freeze({ phase: 'error', error }) })
      throw cause
    }
  }

  /** Dismiss the current transient recommendation without changing durable context. */
  clearRecommendation(): void {
    this.publish({ ...this.snapshot, recommendation: Object.freeze({ phase: 'idle' }) })
  }

  /**
   * Accept selected Include/Exclude recommendations in one atomic Context Plan revision.
   * @param nodeIds - Selected recommendation node IDs; omitted accepts all selection items.
   */
  async applyRecommendations(nodeIds?: readonly string[]): Promise<void> {
    const recommendation = this.snapshot.recommendation
    if (recommendation.phase === 'stale') throw new Error('Context recommendation is stale')
    if (recommendation.phase !== 'ready') throw new Error('No Context recommendation is ready')
    const graph = this.snapshot.graph
    if (graph === undefined) throw new Error('Context Map is unavailable')
    const accepted = nodeIds === undefined
      ? recommendation.proposal.selection
      : recommendation.proposal.selection.filter(item => nodeIds.includes(item.nodeId))
    if (accepted.length === 0) return
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
        ref, mutations, recommendation.proposal.base.graphRevision,
      ))
    } catch (cause) {
      this.publish({
        ...this.snapshot,
        recommendation: Object.freeze({ phase: 'stale', proposal: recommendation.proposal }),
      })
      throw cause
    }
    const acceptedIds = new Set(accepted.map(item => item.nodeId))
    const selection = recommendation.proposal.selection.filter(item => !acceptedIds.has(item.nodeId))
    this.publish({
      ...this.snapshot,
      recommendation: selection.length === 0 && recommendation.proposal.cleanup.length === 0
        ? Object.freeze({ phase: 'idle' })
        : Object.freeze({
          phase: 'stale',
          proposal: Object.freeze({ ...recommendation.proposal, selection: Object.freeze(selection) }),
        }),
    })
  }

  /**
   * Confirm exactly one cleanup candidate; there is deliberately no bulk cleanup API.
   * @param candidate - Proposal-owned cleanup item being explicitly confirmed.
   */
  async confirmCleanup(candidate: ContextCleanupCandidate): Promise<void> {
    const recommendation = this.snapshot.recommendation
    if (recommendation.phase === 'stale') throw new Error('Context recommendation is stale')
    if (recommendation.phase !== 'ready'
      || !recommendation.proposal.cleanup.some(item => item.nodeId === candidate.nodeId)) {
      throw new Error('Cleanup candidate is unavailable')
    }
    const node = this.snapshot.graph?.nodes.find(item => item.id === candidate.nodeId)
    if (node === undefined) throw new Error(`Cleanup candidate references missing node: ${candidate.nodeId}`)
    try {
      await this.mutate(ref => this.transport.replaceNode(
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
   * Restore one placeholder overlay without changing its Include/Exclude mode.
   * @param node - Native family message whose original semantics are restored.
   */
  async restoreNode(node: ContextMessageRef): Promise<void> {
    await this.mutate(ref => this.transport.restoreNode(ref, node))
  }

  private async load(): Promise<void> {
    try {
      const view = await this.transport.get()
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
      const graph: ContextFamilyGraph = Object.freeze({
        rootSessionId: first.rootSessionId,
        activeSessionId: first.activeSessionId,
        sessions: Object.freeze([...first.sessions]),
        edges: Object.freeze([...first.edges]),
        nodes: Object.freeze(nodes),
      })
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
    const view = this.snapshot.view
    if (view === undefined) throw new Error(this.snapshot.error ?? 'Context Plan is unavailable')
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

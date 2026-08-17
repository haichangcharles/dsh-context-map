/** Shared observable bridge between Chat actions, Context Map, and Contextify Remote. */
import type {
  ContextFamilyGraph,
  ContextFamilyGraphPage,
  ContextMessageRef,
  ContextNodeMutation,
  ContextPlanRef,
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
  setNodeModes: (ref: ContextPlanRef, mutations: readonly ContextNodeMutation[]) => Promise<ContextifyView>
  reset: (ref: ContextPlanRef) => Promise<ContextifyView>
  undo: (ref: ContextPlanRef) => Promise<ContextifyView>
  redo: (ref: ContextPlanRef) => Promise<ContextifyView>
}

/** One immutable publication consumed by both right-panel and Chat controls. */
export interface ContextifyControllerSnapshot {
  readonly phase: 'loading' | 'ready' | 'error'
  readonly pending: boolean
  readonly view?: ContextifyView
  readonly graph?: ContextFamilyGraph
  readonly focusedNodeId?: string
  readonly error?: string
}

const REFRESH_MS = 1_500

/** Apply-owned Contextify state machine for one active native Session. */
export class ContextifyController {
  private snapshot: ContextifyControllerSnapshot = Object.freeze({ phase: 'loading', pending: false })
  private readonly listeners = new Set<() => void>()
  private refreshPromise: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly transport: ContextifyTransport) {}

  /** @returns The current cache-stable immutable publication. */
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

  /** Publish a graph focus target without changing durable context. */
  focus(nodeId: string | undefined): void {
    const { focusedNodeId: _focusedNodeId, ...snapshot } = this.snapshot
    this.publish({ ...snapshot, ...(nodeId === undefined ? {} : { focusedNodeId: nodeId }) })
  }

  async setNodeMode(node: ContextMessageRef, mode: ContextNodeMutation['mode']): Promise<void> {
    await this.mutate(ref => this.transport.setNodeMode(ref, node, mode))
  }

  async setNodeModes(mutations: readonly ContextNodeMutation[]): Promise<void> {
    await this.mutate(ref => this.transport.setNodeModes(ref, mutations))
  }

  async reset(): Promise<void> { await this.mutate(ref => this.transport.reset(ref)) }
  async undo(): Promise<void> { await this.mutate(ref => this.transport.undo(ref)) }
  async redo(): Promise<void> { await this.mutate(ref => this.transport.redo(ref)) }

  private async load(): Promise<void> {
    try {
      const view = await this.transport.get()
      const nodes = []
      let first: ContextFamilyGraphPage | undefined
      let after: number | undefined
      for (;;) {
        const page = await this.transport.familyPage(after, 500)
        first ??= page
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
      this.publish(Object.freeze({
        phase: 'ready',
        pending: this.snapshot.pending,
        view,
        graph,
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
}

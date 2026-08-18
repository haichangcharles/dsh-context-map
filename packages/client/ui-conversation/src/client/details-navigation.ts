/** Session-scoped, in-memory navigation for the native right details column. */
import type { ObservableSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Mutually exclusive content pages inside Harness's native details column. */
export type DetailsPage = 'pinned' | 'tool'

/** One immutable page-selection frame for a native Session. */
export interface DetailsPageSnapshot {
  readonly page: DetailsPage
  readonly revision: number
}

const INITIAL: DetailsPageSnapshot = Object.freeze({ page: 'pinned', revision: 0 })

/**
 * Routes independently-owned details surfaces without moving their business
 * state into layout. The registry is intentionally not persisted.
 */
export class DetailsNavigation {
  private readonly snapshots = new Map<SessionId, DetailsPageSnapshot>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()
  private readonly observables = new Map<SessionId, ObservableSnapshot<DetailsPageSnapshot>>()

  /**
   * Read one Session's current page request.
   * @param sessionId - Native Session that owns the details surface.
   * @returns Stable immutable page snapshot.
   */
  snapshot(sessionId: SessionId): DetailsPageSnapshot {
    return this.snapshots.get(sessionId) ?? INITIAL
  }

  /**
   * Obtain the stable observable consumed by the Session-scoped details slot.
   * @param sessionId - Native Session that owns the details surface.
   * @returns Observable page-selection frames for that Session.
   */
  observable(sessionId: SessionId): ObservableSnapshot<DetailsPageSnapshot> {
    const existing = this.observables.get(sessionId)
    if (existing !== undefined) return existing
    const observable: ObservableSnapshot<DetailsPageSnapshot> = {
      getSnapshot: () => this.snapshot(sessionId),
      subscribe: (listener) => {
        const listeners = this.listeners.get(sessionId) ?? new Set<() => void>()
        listeners.add(listener)
        this.listeners.set(sessionId, listeners)
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) this.listeners.delete(sessionId)
        }
      },
    }
    this.observables.set(sessionId, observable)
    return observable
  }

  /**
   * Select one native details subpage without mutating either page's state.
   * @param sessionId - Native Session that owns the details surface.
   * @param page - Pinned plugin content or the selected Tool details.
   */
  request(sessionId: SessionId, page: DetailsPage): void {
    const current = this.snapshot(sessionId)
    if (current.page === page) return
    this.snapshots.set(sessionId, Object.freeze({ page, revision: current.revision + 1 }))
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener()
  }
}

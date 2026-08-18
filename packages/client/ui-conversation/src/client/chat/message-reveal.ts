import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** One pending request to expose a durable Chat message. */
export interface MessageRevealRequest {
  readonly id: number
  readonly seq: number
}

/** Per-Session observable and compare-and-clear face consumed by Chat UI. */
export interface MessageRevealBinding {
  readonly getSnapshot: () => MessageRevealRequest | null
  readonly subscribe: (listener: () => void) => () => void
  readonly consume: (requestId: number) => void
}

/** Browser-memory one-shot requests that survive Session and view mounting. */
export class MessageRevealRegistry {
  private nextId = 1
  private readonly requests = new Map<SessionId, MessageRevealRequest>()
  private readonly listeners = new Map<SessionId, Set<() => void>>()
  private readonly bindings = new Map<SessionId, MessageRevealBinding>()

  /**
   * Publish or replace the pending target for one Session.
   *
   * @param sessionId - Session whose Chat view should reveal a message.
   * @param seq - Durable local event sequence to reveal.
   * @returns The newly published one-shot request.
   */
  request(sessionId: SessionId, seq: number): MessageRevealRequest {
    const request = { id: this.nextId++, seq }
    this.requests.set(sessionId, request)
    this.notify(sessionId)
    return request
  }

  /**
   * Read one Session's current request.
   *
   * @param sessionId - Session whose pending request should be read.
   * @returns The pending request, or `null` when none exists.
   */
  read(sessionId: SessionId): MessageRevealRequest | null {
    return this.requests.get(sessionId) ?? null
  }

  /**
   * Create or reuse the stable observable binding for an injected Session view.
   *
   * @param sessionId - Session whose request lifecycle the binding exposes.
   * @returns A stable observable and compare-and-clear binding.
   */
  binding(sessionId: SessionId): MessageRevealBinding {
    const existing = this.bindings.get(sessionId)
    if (existing !== undefined) return existing
    const binding: MessageRevealBinding = {
      getSnapshot: () => this.read(sessionId),
      subscribe: listener => this.subscribe(sessionId, listener),
      consume: (requestId) => { this.consume(sessionId, requestId) },
    }
    this.bindings.set(sessionId, binding)
    return binding
  }

  private subscribe(sessionId: SessionId, listener: () => void): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(sessionId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(sessionId)
    }
  }

  private consume(sessionId: SessionId, requestId: number): void {
    if (this.requests.get(sessionId)?.id !== requestId) return
    this.requests.delete(sessionId)
    this.notify(sessionId)
  }

  private notify(sessionId: SessionId): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener()
  }
}

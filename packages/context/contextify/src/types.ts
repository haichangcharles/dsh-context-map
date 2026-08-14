/** Client-safe Contextify domain and Remote-boundary vocabulary. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { Message } from '@deepseek-ai/dsh-llm'

/** Opaque identity of one lightweight path inside a Session. */
export type ContextPathId = Branded<'ContextPathId'>

/**
 * Brand a validated path id.
 * @param value - Non-empty, already-trimmed durable path identity.
 * @returns The validated opaque path identity.
 */
export function ContextPathId(value: string): ContextPathId {
  if (value.length === 0 || value.trim() !== value) throw new TypeError('context path id must be non-empty and trimmed')
  return value as ContextPathId
}

/** Durable ancestry and lifecycle of one conversation path. */
export interface ContextPath {
  readonly id: ContextPathId
  readonly parentPathId: ContextPathId | null
  readonly anchorSeq: number | null
  readonly label: string
  readonly status: 'active' | 'archived'
}

/** Explicit inclusion decision for one durable message event. */
export interface ContextNodeOverride {
  readonly seq: number
  readonly mode: 'include' | 'exclude'
}

/** Complete last-wins context selection plan. */
export interface ContextPlanSnapshot {
  readonly kind: 'contextify/plan'
  readonly version: 1
  readonly revision: number
  readonly mainlinePathId: ContextPathId
  readonly activePathId: ContextPathId
  readonly paths: readonly ContextPath[]
  readonly overrides: readonly ContextNodeOverride[]
}

/** Immutable assignment of one turn to a path and causal parent. */
export interface ContextRoute {
  readonly kind: 'contextify/route'
  readonly version: 1
  readonly turn: number
  readonly pathId: ContextPathId
  readonly parentSeq: number | null
  readonly planRevision: number
}

/** Replay-derived causal metadata for one durable message event. */
export interface ContextGraphNode {
  readonly seq: number
  readonly parentSeq: number | null
  readonly pathId: ContextPathId
  readonly turn: number | null
  readonly role: 'user' | 'assistant'
  readonly sourceKind: string
  readonly locked: boolean
}

/** Detached graph and the latest validated plan. */
export interface ContextGraph {
  readonly plan: ContextPlanSnapshot
  readonly nodes: readonly ContextGraphNode[]
}

/** Existing durable events and messages selected for one request. */
export interface ContextifyCompilation {
  readonly eventSeqs: readonly number[]
  readonly messages: readonly Message[]
}

/** Compare-and-set reference to one complete plan revision. */
export interface ContextPlanRef { readonly revision: number }

/** Small state returned to mutation clients. */
export interface ContextifyView {
  readonly plan: ContextPlanSnapshot
  readonly graphAsOfSeq: number
  readonly activeTipSeq: number | null
  readonly selectedCount: number
  readonly totalNodeCount: number
}

/** One bounded page of graph nodes. */
export interface ContextGraphPage {
  readonly asOfSeq: number
  readonly records: readonly ContextGraphRecord[]
  readonly nextAfterSeq?: number
}

/** Browser-safe graph node plus a bounded text preview. */
export interface ContextGraphRecord extends ContextGraphNode { readonly preview: string }

/** Stable Contextify mutation failures. */
export type ContextifyErrorCode =
  | 'CONTEXTIFY_AGENT_NOT_LIVE' | 'CONTEXTIFY_AGENT_BUSY' | 'CONTEXTIFY_STALE_REVISION'
  | 'CONTEXTIFY_PATH_NOT_FOUND' | 'CONTEXTIFY_INVALID_ANCHOR' | 'CONTEXTIFY_INVALID_NODE'
  | 'CONTEXTIFY_LOCKED_NODE' | 'CONTEXTIFY_INVALID_TRANSITION' | 'CONTEXTIFY_INVALID_LABEL'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete post-mutation Contextify plan. */
    'contextify/plan': ContextPlanSnapshot
    /** Immutable assignment of one turn to a path and causal parent. */
    'contextify/route': ContextRoute
  }
}

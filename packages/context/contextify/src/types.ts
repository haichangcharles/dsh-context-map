/** Client-safe Contextify domain and Remote-boundary vocabulary. */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'

/** Immutable Session data consumed by the native family projection. */
export interface ContextFamilyInspection {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** Durable location of one message inside its owning native Session. */
export interface ContextMessageRef {
  readonly sessionId: SessionId
  readonly seq: number
}

/** One native Session rendered in a connected Context Map family. */
export interface ContextFamilySession {
  readonly id: SessionId
  readonly parentSessionId?: SessionId
  readonly seedLength: number
  readonly depth: number
  readonly tipNodeId: string | null
}

/** One canonical visible message shared by every Session that inherited it. */
export interface ContextFamilyGraphNode {
  readonly id: string
  readonly owner: ContextMessageRef
  readonly role: 'user' | 'assistant'
  readonly preview: string
  readonly time: number
  /** Completed native Turn boundary accepted by Session fork, or null while unavailable. */
  readonly branchAtSeq: number | null
  readonly sessionIds: readonly SessionId[]
  readonly activeEventSeq: number | null
}

/** One causal visible-message edge shared by every Session that traverses it. */
export interface ContextFamilyGraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sessionIds: readonly SessionId[]
}

/** Complete graph projection for one native root Session and its descendants. */
export interface ContextFamilyGraph {
  readonly rootSessionId: SessionId
  readonly activeSessionId: SessionId
  readonly sessions: readonly ContextFamilySession[]
  readonly nodes: readonly ContextFamilyGraphNode[]
  readonly edges: readonly ContextFamilyGraphEdge[]
}

/** One Natural active-Session message explicitly omitted from compilation. */
export interface ContextExcludedNode {
  readonly nodeId: string
  readonly eventSeq: number
}

/** One same-family message copied into a local compiler snapshot event. */
export interface ContextIncludedNode {
  readonly nodeId: string
  readonly snapshotSeq: number
  readonly position: number
}

/** Selection fields copied between revisioned Context Plan states. */
export interface ContextPlanState {
  readonly excluded: readonly ContextExcludedNode[]
  readonly included: readonly ContextIncludedNode[]
}

/** Complete last-wins context selection and undo history. */
export interface ContextPlanSnapshot {
  readonly kind: 'contextify/plan'
  readonly version: 2
  readonly revision: number
  readonly stateRevision: number
  readonly history: {
    readonly past: readonly number[]
    readonly future: readonly number[]
  }
  readonly excluded: readonly ContextExcludedNode[]
  readonly included: readonly ContextIncludedNode[]
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
  readonly selectedCount: number
  readonly totalNodeCount: number
  readonly canUndo: boolean
  readonly canRedo: boolean
}

/** One bounded page of a native Session family's canonical message nodes. */
export interface ContextFamilyGraphPage {
  readonly asOfSeq: number
  readonly rootSessionId: SessionId
  readonly activeSessionId: SessionId
  readonly sessions: readonly ContextFamilySession[]
  readonly edges: readonly ContextFamilyGraphEdge[]
  readonly records: readonly ContextFamilyGraphNode[]
  readonly totalNodeCount: number
  readonly nextAfter?: number
}

/** One message-mode mutation from Chat or the Context Map. */
export interface ContextNodeMutation {
  readonly node: ContextMessageRef
  readonly mode: 'natural' | 'include' | 'exclude'
}

/** Revision and graph watermark one recommendation analyzed. */
export interface ContextRecommendationBase {
  readonly planRevision: number
  readonly graphAsOfSeq: number
  readonly activeSessionId: SessionId
}

/** One review-only change to effective context selection. */
export interface ContextSelectionRecommendation {
  readonly nodeId: string
  readonly action: 'include' | 'exclude'
  readonly reason: string
  readonly confidence: 'high' | 'medium' | 'low'
}

/** One review-only candidate for semantic placeholder replacement. */
export interface ContextCleanupCandidate {
  readonly nodeId: string
  readonly category: 'obsolete' | 'conflict' | 'redundant'
  readonly reason: string
  readonly evidenceNodeIds: readonly string[]
  readonly placeholderText: string
}

/** Ephemeral, revision-scoped Agent output. Nothing here is a mutation. */
export interface ContextRecommendationProposal {
  readonly base: ContextRecommendationBase
  readonly selection: readonly ContextSelectionRecommendation[]
  readonly cleanup: readonly ContextCleanupCandidate[]
}

/** Stable Contextify mutation failures. */
export type ContextifyErrorCode =
  | 'CONTEXTIFY_AGENT_NOT_LIVE' | 'CONTEXTIFY_AGENT_BUSY' | 'CONTEXTIFY_STALE_REVISION'
  | 'CONTEXTIFY_INVALID_NODE' | 'CONTEXTIFY_CROSS_FAMILY' | 'CONTEXTIFY_UNSUPPORTED_MESSAGE'
  | 'CONTEXTIFY_INVALID_TRANSITION' | 'CONTEXTIFY_HISTORY_EMPTY'
  | 'CONTEXTIFY_STALE_GRAPH' | 'CONTEXTIFY_RECOMMENDATION_BUSY'
  | 'CONTEXTIFY_RECOMMENDATION_UNAVAILABLE' | 'CONTEXTIFY_RECOMMENDATION_TOO_LARGE'
  | 'CONTEXTIFY_INVALID_RECOMMENDATION'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Complete post-mutation Contextify plan. */
    'contextify/plan': ContextPlanSnapshot
  }
}

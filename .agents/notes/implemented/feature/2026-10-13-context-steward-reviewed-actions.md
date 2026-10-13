# Agent Note: Context Steward reviewed actions

Status: implemented

English | [中文](2026-10-13-context-steward-reviewed-actions.zh.md)

## Problem

A long conversation can need evidence from one branch while continuing work in another. A source-only reviewer cannot express this distinction, passive branch inspection does not identify a user's intended destination, and preference summaries without event provenance cannot be inspected or reset reliably. Requiring a model call for every review also makes deterministic Context actions unnecessarily expensive.

## Decision

The [Context Steward guide](../../../../docs/user/guide/context-steward.md) describes one review workflow over the native Session graph. Local is the default and makes no model request. Explicit Fast review uses one bounded, tool-free request with optional independent destination and evidence scores. Explicit textual cues and native graph legality constrain that advice. A low-confidence new task or ambiguous destination cannot silently create or select a branch. Fast records its exact frozen system and user packet, objective, provider/model and 640-token output limit in the native Session log without credentials; the record is audit data and does not train preference memory or change the graph revision. Deep remains an isolated DSH review with `deepMaxRequests` defaulting to three and configurable from one to ten, counting retries, a 45-second timeout, and a 1,200-token output limit per request. Automatic post-turn Branch classification is opt-in.

The Client distinguishes Move draft here from Locate. Move draft here requires nonempty unsent text and is an explicit destination action; a transferred draft is version-checked and the destination's existing draft is protected. The Host records manual route evidence only after successful native transfer. Locate remains inspection and contributes no label. Branch lifecycle advice is separate from Context selection and requires its own confirmation. Local admits explicit lifecycle cues; Fast and Deep can propose at most one valid, non-no-op native Session state change, with explicit cues taking precedence. Complete retains evidence; a later human turn reopens the task.

Policy memory remains a rebuildable projection of confirmed native events. Evidence identifies its owning Session and event sequence. Reset records per-Session owned-event watermarks and retains raw conversations and the current Context Plan. Events appended after a reset, including events with the same timestamp, can train the new projection. The [policy memory decision](2026-10-12-context-steward-policy-memory.md) owns the estimation and feedback rules.

## Alternatives considered

**Treat evidence relevance as destination relevance.** Rejected because borrowing research evidence should not move an ongoing writing task to the research branch.

**Learn from passive Locate or card exposure.** Rejected because inspection and presentation do not express an intended Context action.

**Use timestamp-only reset or delete choice records.** Rejected because timestamps can coincide across events and deleting records removes the audit trail.

**Call an additional router model or require reranker training.** Rejected because Fast already owns a semantic review request and the bounded graph packet supports a replaceable scorer without a second agent loop or a trained baseline claim.

## Consequences

Users can manage current context, destinations and work states through separate reviewed actions while preserving native lineage. Deterministic Local advice avoids review API costs; uncertain lexical inputs remain limited. Semantic scores are ranking signals, not calibrated probabilities. Preference rules expose support and event evidence but do not establish human personalization gains.

The [keyless replay](../../../../scripts/context-steward-replay.ts) exports six prefix-only action packets from a constructed 30-turn, four-Session trace. Fixture expectations remain separate; controlled scores test routing constraints rather than scorer accuracy. Native projection must preserve sixty unique chat nodes, completed evidence and re-entry. The paired spec checks that packet histories never contain future decisions and that independent runs produce identical packets. The assembled Web acceptance test separately owns UI-to-compiled-request evidence. Saved simulated-user experiments require comparison with simple conditional baselines; an engineering replay is not SOTA evidence.

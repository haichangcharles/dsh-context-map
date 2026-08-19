# Agent Note: Context Map release semantics

Status: implemented

English | [中文](2026-08-19-context-map-release-semantics.zh.md)

## Problem

Context Map already projected native Session forks and let users control model context, but four release-critical boundaries were ambiguous. Agent recommendations could fail on harmless actions and encouraged incremental mutation instead of reviewing a complete version. Removing message meaning risked breaking graph structure. Re-forked Sessions could appear artificially nested. Branch routing suggestions and their prompts had no durable, user-controlled product contract.

## Decision

Context selection recommendations are now a Current → Proposed replacement. The isolated Agent may reason in two stages—remove irrelevant included nodes, then add relevant off-path nodes—but the validator compares its result with the current effective set and returns one normalized diff. Duplicate no-ops disappear; unknown nodes and contradictory actions fail. Apply writes one plan revision, and one Undo restores the previous version.

Archive is a separate, reversible message operation. It accepts one genuine user input or completed Turn's final assistant output, preserves the node, role, edges, native fork boundary, and original append-only event, and replaces only model-visible content with the server-owned marker `[Placeholder: intentionally empty]`. Recommendation Agents may propose Archive conservatively, but only individual user confirmation executes it.

The family projection canonicalizes Session ancestry by the actual fork boundary. A Session forked again from an inherited boundary is displayed beside the earlier branch; a fork from a branch-local boundary remains its child. This changes navigation hierarchy only and does not introduce another branch store.

Automatic Branch review is opt-in because it adds one model call per completed Turn. When enabled, a bounded, tool-free auxiliary call runs after the parent Agent becomes idle without creating a visible subagent or an Agent loop. Only high-confidence off-topic or parallel Q&A creates a durable suggestion beside the final output. On acceptance, the service rejects stale sources, archives the two source messages, forks a deterministic native child at the preceding completed boundary, replays the exact Q&A, and records an idempotency marker. Retry returns the same child rather than duplicating work.

Profile Settings owns three independent prompt sections: Context, Archive, and Branch. The package prompt is visible but read-only by default. Additional instructions are the ordinary extension point; full replacement requires explicit UI confirmation, and restoring the package base preserves appended rules. All review work uses the existing Harness spawn provider and parent route, never a second Agent runtime.

The Web surface treats Archive and context selection as independent controls, renders one opaque right-click menu, applies recommendation versions atomically, and keeps Branch suggestions non-modal. The source graph pivot remains visible after relocation because archived messages are structural placeholders.

## Verification

Host tests cover normalization, conflict rejection, no-op filtering, atomic Apply/Undo, Archive/Restore, canonical sibling and child ancestry, one-shot Branch decisions, stale rejection, exact Q&A replay, and idempotent retry. Client tests cover the Current/Proposed sheet, Archive confirmation and menu actions, Prompt Dashboard locking and persistence, and Branch suggestion acceptance. Repository type checking, focused Contextify/Workspace tests, GUI replay, Web replay, and browser acceptance form the release gate.

## Alternatives considered

**Apply recommendation actions one by one.** Rejected because the user is choosing between two context versions. Partial acceptance makes the proposal harder to reason about and breaks one-step rollback.

**Delete archived nodes or let the Agent write replacement prose.** Rejected because deletion can sever branch pivots, while generated replacement text introduces new meaning. A fixed role-preserving placeholder is deterministic and reversible.

**Run a full or visible subagent loop for Branch routing.** Rejected because the decision is bounded classification after a successful Turn. An opt-in, tool-free auxiliary call avoids delaying the primary conversation, polluting the subagent roster, or changing ordinary Harness model-call behavior by default.

**Store a second Context Map branch hierarchy.** Rejected because native Sessions already own ancestry and persistence. Canonical projection resolves the visual ambiguity without duplicating branch state.

## Consequences

Users can compare whole context versions without paying a reliability penalty for already-selected nodes, while destructive semantic cleanup remains explicit and reversible. Branch navigation follows native Session truth, automated routing stays lightweight, and every Agent policy can be adapted per Profile. Cross-map imports, autonomous Archive execution, and multi-step Branch loops remain intentionally out of scope.

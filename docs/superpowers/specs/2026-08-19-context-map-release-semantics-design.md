# Context Map Release Semantics Design

English | [中文](2026-08-19-context-map-release-semantics-design.zh.md)

## Goal

Complete the Context Map release behavior without introducing a second conversation or agent-loop model beside Harness. Users can archive one message, replace the effective context as one reviewed version, receive a lightweight post-Turn branch suggestion, and customize each review prompt in the active Harness profile.

## Product model

The native Session fork family remains the only conversation topology. Contextify adds reversible semantic overlays and review proposals, but does not rewrite native Session history or let a recommendation Agent mutate state directly.

A canonical message inherited from an ancestor keeps that ancestor as its owner. Forks from the same canonical message and completed Turn boundary are siblings even when one action starts while viewing another sibling. A fork from a message first produced inside a child Session is that Session's child.

## Context replacement

A context recommendation compares two complete effective-selection versions:

- **Current** is the effective included-node set at the analyzed Context Plan and family revision.
- **Proposed** is Current after applying the Agent's bounded include and exclude delta.

The Agent may reason about removal and addition together, but the product exposes one replacement proposal rather than two execution stages. The service derives `added = Proposed - Current` and `removed = Current - Proposed`; the review UI presents that diff and applies every accepted selection change in one Context Plan revision. Undo restores the complete prior version.

The service normalizes harmless model output. Including an already included node, excluding an already excluded node, or repeating the same action does not invalidate the proposal and does not appear in the diff. Unknown nodes, conflicting actions for one node, invalid fields, and stale plan or graph revisions fail closed.

## Node archive

Archive is a user-confirmed semantic operation on one visible user input or final assistant output. It reuses the deterministic empty-placeholder overlay: the native message, node ID, role, branch boundary, and edges remain intact, while compilation receives the package-owned placeholder marker instead of the original semantics. The card renders an archived state with an empty body.

The node context menu exposes Archive node and Restore node. Archive and restore participate in Context Plan undo, redo, and reset. A recommendation Agent may identify an archive candidate with evidence, but it cannot execute the operation or author placeholder content.

## Context review result

One Context review contains:

- the complete Current and Proposed effective-selection versions;
- the derived added and removed node lists;
- optional, individually reviewed archive candidates.

Apply commits only the selection replacement. Archive candidates require separate confirmation because they alter message semantics. Dismiss leaves the Context Plan unchanged. Any family or plan change marks the complete review stale.

## Lightweight branch suggestion

After a successful Turn completes, Contextify may launch one isolated, tool-free Harness subagent request. The main answer and input controls remain available immediately; branch review never blocks the conversation.

The request contains the current local objective, up to three recent completed Turns, the newly completed input and final output, branch depth and count, and the active profile's branch prompt addition or override. It returns only `continue` or `suggest_branch`, confidence, and a short reason. One Turn runs at most one review. Timeout, provider failure, malformed output, low confidence, or a newer Turn ends the review silently.

The default policy is conservative: a suggestion appears only when the completed Q+A is a clear detour, parallel exploration, or separable subtask whose relocation protects the current line of work. The review card offers Move to new branch and Keep here; no branch is created without confirmation.

## Confirmed branch relocation

Harness Session logs are append-only, so confirmation uses native fork plus deterministic replay instead of deleting history:

1. Revalidate the active Session, completed Turn, Context Plan revision, and family revision.
2. Derive a stable relocation key from the source Session ID and candidate Turn boundary; an existing child carrying that key is reused on retry.
3. Fork a native child Session at the completed boundary immediately before the candidate user input.
4. Replay only that original user input and final assistant output into one completed Turn in the child, preserving their roles and content, and record the relocation key on the child.
5. Archive the two original nodes in the source Session with deterministic empty placeholders.
6. Open the child Session after both the replay and source-plan mutation succeed.

The graph therefore retains empty structural pivots on the source path and shows the complete Q+A on the new native branch. A failure before source-plan commit leaves the source nodes unchanged; retry reuses any already-created relocation child instead of creating another. A created Session is not removed by Context Plan undo; the confirmation UI states this consequence. The implementation must prevent a replayed Turn from triggering another branch review.

## Profile prompt settings

Contextify registers one settings namespace in the active Harness profile with independent prompt configuration for context replacement, archive review, and branch suggestion. Each function has:

- a package-owned default prompt displayed as gray read-only text;
- an Additional instructions field used by default;
- an explicit Override default prompt action that unlocks a full custom base prompt after confirmation;
- Restore default, which removes the override without deleting the additional instructions;
- an effective-prompt preview.

Double-click may be a shortcut to the explicit override action, but the visible action remains the accessible discovery path. A new review snapshots the effective prompt at start; editing settings does not alter an in-flight review. Empty additions retain the package default. Invalid or unreadable settings fail at the settings provider and do not silently replace the last valid configuration.

## Presentation

The Context review shows Current → Proposed and summarizes added, removed, and archive-candidate counts before the node details. A branch suggestion is a lightweight post-answer card, not a modal. The node context menu uses an opaque elevated background, border, shadow, and sufficient stacking order over cards and edges.

## Failure and concurrency behavior

- Recommendation output is advisory until an explicit user action commits a mutation.
- Every proposal carries the exact plan and family revisions it analyzed.
- Repeated Apply, stale Apply, and stale branch confirmation fail without a partial Context Plan mutation.
- Context replacement is one revision and one undo unit.
- Archive confirmation is one revision and one undo unit per user action.
- Branch review never runs tools, performs a second model step, or delays the originating Turn.
- Replayed branch content cannot recursively schedule another suggestion.
- Branch relocation is idempotent for one source Turn and cannot create duplicate children after a retry.
- Existing manual Branch from Here continues to call native Session fork directly.

## Verification

- Recommendation protocol tests prove no-op normalization, conflicting-action rejection, complete Current/Proposed derivation, atomic apply, stale rejection, and one-step undo.
- Service tests prove archive and restore preserve topology and compile the fixed marker, while Agent output cannot author placeholder text.
- Family and client tests prove same-canonical-point forks are siblings and branch-local forks are children in both the map and sidebar inputs.
- Branch tests prove one review per completed Turn, tool-free one-shot execution, low-confidence silence, stale expiry, accepted replay, source placeholders, and recursion suppression.
- Settings tests prove append, override, restore-default, per-profile persistence, effective-prompt snapshotting, and read-only default presentation.
- Client tests prove the complete version diff, separate archive confirmation, branch review actions, and opaque context menu.
- The assembled Web replay verifies a completed conversation, context replacement plus undo, single-node archive plus restore, and accepted branch relocation through the real plugin composition.

## Out of scope

This design does not auto-apply context selection, auto-archive messages, auto-create branches, physically delete Session events, move reasoning or tool events into the Context Map, or introduce cross-family context selection.

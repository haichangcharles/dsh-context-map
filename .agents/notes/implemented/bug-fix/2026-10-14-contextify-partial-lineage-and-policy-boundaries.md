# Agent Note: Partial Context lineage and policy boundaries

Status: implemented

English | [中文](2026-10-14-contextify-partial-lineage-and-policy-boundaries.zh.md)

## Problem

A native child can be inspected while its parent inspection is unavailable. Ownership verification then leaves inherited messages local to the child. Using that fallback owner as the canonical parent creates an incorrect self-parent relationship. Preference projections also contain empty-array fallbacks for arrays that their own construction guarantees are nonempty; artificial inputs or coverage exceptions would conceal the actual invariants.

## Decision

The family projector retains the declared native parent when the inherited fork event resolves to the child itself. It collapses a fork to a different canonical owner only after copied-event verification establishes that owner. Missing parent data therefore cannot manufacture a self edge, and verified forks at inherited boundaries retain their existing sibling placement.

Restoring a missing parent can change the family root while an older review is waiting for a model. A newer review can then own the same Session under the recovered root. Cleanup releases each Session-to-root alias only if it still belongs to the older captured root. Same-root operation ownership remains exclusive; that guarantee does not extend across a recovered root.

The personal Context policy reads the first recent mode with a nonempty reduction. Its matching filter produces a dense array, the length guard requires at least ten entries, and the recent slice therefore contains five entries. The axis scorer reduces a literal array containing at least source, topology and cell. It replaces the winner only for a strictly higher score, preserving the stable sort's first-winner behavior on ties. Unknown graph features, sparse review evidence and conflicting choices retain their existing guards and thresholds.

## Alternatives considered

**Treat unverified local ownership as ancestry.** Ownership of a message in the available projection cannot prove the child's parent; the native header remains the parent authority when copied-event verification cannot establish another owner.

**Force impossible empty internal arrays or exempt them from coverage.** Sparse-array fixtures, private mocks and ignore comments do not test the actual public input handling. The implementation expresses the proven construction invariants, while native-event tests exercise reachable rejection and fallback behavior.

## Consequences

Partial inspections retain an honest local graph and native parent identity. No source event, Context Plan, confirmed preference, model request or approval requirement changes. The policy simplifications preserve the ordering and sensitivity of personalization advice. A missing ancestor remains unavailable; the projector does not invent its content or verify an unobserved copied prefix.

## Testing

The native tests reproduce missing-parent self ownership before the fix and verify the corrected parent afterward. Existing inherited-boundary fork collapse remains covered. Public inspection tests cover image and worker messages, failed Web-result provenance, empty and cyclic parent metadata, legacy lifecycle timestamps and simultaneous choices. Policy tests cover complete-sheet validation, undone evidence, empty objectives, orphaned sources, no-ops, stable and reversing preferences, explicit route choices and lexical fallback. Scoped coverage meets the unchanged per-file 100% requirement for the eight affected policy and family modules without model calls or coverage exceptions.

Two native model-stream barriers reproduce the restored-parent cleanup failure before the fix. After the fix, the old review reports its stale graph while the newer review can finish or receive its own targeted cancellation. Neither completion nor cancellation loses the recovered root's ownership.

## Related

[Reviewed Context semantics](../feature/2026-08-19-context-map-reviewed-semantics.md) retains ownership of family freshness and approval behavior. [Personal Context calibration](../feature/2026-10-09-personal-context-calibration.md) retains ownership of the preference algorithm. This note adds failure handling and construction proofs; it does not supersede either decision.

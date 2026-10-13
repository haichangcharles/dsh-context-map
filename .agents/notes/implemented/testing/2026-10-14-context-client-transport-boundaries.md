# Agent Note: Context Client transport and callback boundaries

Status: implemented

English | [中文](2026-10-14-context-client-transport-boundaries.zh.md)

## Problem

Passing browser interaction tests did not cover many Context Client transport failures and registration callbacks. The strict Linux coverage report exposed missing checks for cancellation, late review results, editor transfer guards and preference actions. A failed or obsolete request must not mutate context or erase a newer review.

## Decision

Public controller tests exercise paged graph reads, polling ownership, overlapping writes, failed mutations, stale proposals, explicit declines, archives and late cancellation/dismissal results. The browser-plugin tests mount the real Cordis SlotRegistry and invoke its registered action faces over a deterministic Remote fixture. They verify exact Session ownership, Profile settings registration, draft identity, native branch boundaries and the absence of mutation after rejected actions. Remote errors use the protocol's actual failure class.

The controller retains every public failure guard. A loaded-value guard serves both initial-view admission and the graph required by a ready review. A failed initial load always publishes its error, so unreachable fallback error strings are removed. Refresh deduplicates its only task and has no second publisher; that task clears its own in-flight reference unconditionally. No dependency, polling interval, proposal validation rule or model request is added.

## Alternatives considered

- **Treat browser acceptance as complete coverage.** It omits transport failures and ephemeral ownership races.
- **Mock private controller state.** Such states bypass the admission paths whose behavior needs verification.
- **Lower the coverage threshold or ignore branches.** The strict gate remains unchanged.

## Consequences

The tests expose the controller through its public methods and the plugin through registered service callbacks. They verify local Client contracts, not provider quality or real-user personalization. The [reviewed-action decision](../feature/2026-10-13-context-steward-reviewed-actions.md) retains ownership of the product workflow and performance evidence; this note does not supersede it.

## Testing

Three owning files pass 79 keyless tests. Controller and Client assembly each reach 100% statements, branches, functions and lines in the scoped report. The whole UI package and the full Linux suite have their own remaining gates; this evidence does not claim those gates passed.

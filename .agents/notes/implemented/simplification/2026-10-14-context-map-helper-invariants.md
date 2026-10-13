# Agent Note: Keep Context Map helper checks at reachable input cases

Status: implemented

English | [中文](2026-10-14-context-map-helper-invariants.zh.md)

## Problem

Layout and archive projection receive malformed public graph inputs, but several optional lookups also defend against states their own construction excludes. Conflating these cases encourages tests that mutate private algorithms or invent sparse typed arrays, while leaving real cycles, missing endpoints and measurement failures unverified.

## Decision

Keep public graph checks and derive internally guaranteed values directly. [Dagre placement](../../../../packages/client/ui-contextify/src/client/layout.ts) reads coordinates only after inserting every record and completing layout. For an eligible chain, N−1 distinct known targets leave one root; at most one predecessor prevents a cycle reachable from that root. Successors retain their resolved record and input index. A disconnected cycle fails the final visited-count check and retains Dagre fallback.

Mind-map traversal returns its cached or newly assigned point. Assignment precedes recursion, so cycles and shared descendants terminate in the same order, and later traversal cannot change an earlier point. Record output order and coordinates remain unchanged. Archive alias filtering produces a dense list; only after the nonempty check, reduction selects the active alias or the first visible alias. The [linear placement decision](../bug-fix/2026-10-14-linear-context-map-layout.md) remains responsible for performance and geometric equivalence.

## Alternatives considered

**Force impossible lookup failures in tests.** Mocking private Dagre state or constructing holes in a typed filtered array proves neither public validation nor normal algorithm behavior.

**Ignore uncovered checks.** This conceals the distinction between a useful malformed-input rejection and an internal construction invariant.

## Consequences

Unknown endpoints, duplicate identities and edges, invalid measurements, disconnected cycles, archived paths and cyclic parent metadata retain their existing handling. No geometry, performance budget, dependency or coverage threshold changes. Internal derivation replaces redundant fallback state without adding a second graph authority.

## Testing

The [layout suite](../../../../packages/client/ui-contextify/tests/layout.client.spec.ts) retains exact Dagre comparisons and independent mind-map reference coordinates. [Archive cases](../../../../packages/client/ui-contextify/tests/archived-family.client.spec.ts) cover active-path removal, visible aliases, unavailable edges and cyclic or missing parents. [Canvas operations](../../../../packages/client/ui-contextify/tests/canvas-interactions.client.spec.ts) cover context overrides, touching/separated rectangles and independent drag commits. Together with measurement tests, 36 cases reach 100% statements, branches, functions and lines across all four helpers.

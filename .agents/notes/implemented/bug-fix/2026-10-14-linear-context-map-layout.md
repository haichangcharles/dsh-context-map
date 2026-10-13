# Agent Note: Exact linear placement for unbranched Context Maps

Status: implemented

English | [中文](2026-10-14-linear-context-map-layout.zh.md)

## Problem

A long native conversation is often a single chain, but general graph ranking runs for both estimated and renderer-measured card dimensions. In the 240-turn browser workload, opening the default 480-node Map performs two synchronous Dagre layouts. Profiling attributes approximately 318–326ms of local browser CPU to those calls. The hosted open median of 1653.62ms exceeds its unchanged 1125ms budget, while paging, Trajectory, first response, streaming and input remain within their budgets.

## Decision

[Context Map layout](../../../../packages/client/ui-contextify/src/client/layout.ts) directly places a single connected chain in linear time. It retains every node, input record order, rank gap, measured dimensions, cross-axis centering and handle direction. Both tree and timeline coordinates equal Dagre's coordinates. The graph must have unique node identities, exactly one fewer edge than nodes, known endpoints, at most one predecessor and successor per node, one root, and a traversal covering every node. Invalid dimensions, branches, joins, duplicate edges and disconnected cycles retain general Dagre placement. Mind-map placement is unchanged.

This complements the graph-identity and layout-cache decisions in [Context Steward reviewed actions](../feature/2026-10-13-context-steward-reviewed-actions.md). Caching removes repeated work for unchanged snapshots; direct chain placement reduces the two necessary initial layouts.

## Alternatives considered

**Hide or delay the initial Map.** This changes the chosen default interaction and measures a different product path. The Map remains open and populated during the benchmark.

**Raise the open budget.** This retains avoidable synchronous computation and weakens the existing hosted acceptance gate.

**Replace Dagre for every graph.** Branches and joins require more general placement. The optimization has a structural eligibility test and retains the existing algorithm for other graphs.

## Consequences

The common unbranched conversation requires linear traversal rather than general ranking. Arbitrary record order and renderer measurements remain supported. No node, preview, edge, refresh, or browser assertion is removed. The hosted budget remains authoritative; local profiling identifies computation costs but cannot establish hosted acceptance.

[Helper invariants](../simplification/2026-10-14-context-map-helper-invariants.md) retain public malformed-input checks while deriving guaranteed internal coordinates and chain successors directly.

## Testing

The [layout tests](../../../../packages/client/ui-contextify/tests/layout.client.spec.ts) compare exact coordinates with an independent Dagre oracle for shuffled input, unequal card dimensions and fractional renderer measurements in both directions. A 480-message chain retains all nodes without invoking general optimization. Branch, join, cycle, missing-endpoint and duplicate-edge cases retain Dagre. The combined layout, measurement and Map-panel suites pass 68 tests. The [original browser benchmark](../../../../benchmarks/long-session-browser/long-session.bench.ts) retains all three samples, the 240-turn workload and every existing endpoint budget.

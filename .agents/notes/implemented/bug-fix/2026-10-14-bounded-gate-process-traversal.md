# Agent Note: Bounded gate process-table traversal

Status: implemented

English | [中文](2026-10-14-bounded-gate-process-traversal.zh.md)

## Problem

Windows Node 24 CI stopped in the gate coordinator's `collectDescendants` with `RangeError: Maximum call stack size exceeded`, rather than returning a test or coverage result. The walk used the root's adjacency array as its queue and repeatedly spread child lists into `Array.push`. A root back-edge can therefore append the growing queue to itself; an ordinary sufficiently wide child list independently exceeds the engine's argument limit. Duplicate or cyclic process-table relationships also had no visit bound. The failing CIM table was not retained, so PID reuse as the particular trigger remains unverified.

## Decision

[The coordinator](../../../../scripts/run-gates.ts) owns a separate breadth-first queue. It marks the root visited and marks each PID before enqueueing, appending children individually. Every reachable observed PID appears once in first-discovery table order; the root and disconnected entries are excluded. The adjacency table is never mutated during traversal. Queue size is bounded by the number of unique observed PIDs, and traversal work is linear in the table size.

Both synchronous termination capture and asynchronous sampling use the same helper. Observed PID values, cached descendant retention and union, signal escalation, taskkill order, quiescence checks and deadlines remain unchanged. The fix adds no OS query, model call, retry or coverage exception.

## Alternatives considered

- **Catch RangeError and return no descendants.** This conceals failed containment and can leave owned work alive.
- **Truncate the queue or widen the gate timeout.** Neither resolves the graph or argument-limit defect; truncation can omit descendants.
- **Fix only self-parent rows.** Longer cycles, duplicate paths and wide acyclic trees still need a bounded traversal.

## Consequences

A non-atomic process table is treated as an observed graph instead of assuming it is a clean tree. The coordinator still cannot recover relationships absent from that snapshot; existing retention handles previously observed descendants. The [parallel-gate decision](../process/2026-07-06-parallel-pre-push-gates.md) remains responsible for orchestration policy and is not superseded.

## Testing

Two public-input negative controls reproduce the exact old spread-call RangeError: a root self-edge and 200,000 ordinary grandchildren. Five regression cases pass after the fix, covering root/back/descendant cycles, duplicate rows, disconnected entries, empty input, unchanged input and breadth-first taskkill targets. The complete owning script suite passes all 96 tests, including real abort, reparented descendant and cleanup scenarios. The five new cases also pass under Node 24. Focused TypeScript, lint and diff checks pass. These local results do not claim the failed Windows CI run subsequently passed.

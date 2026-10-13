# Agent Note: Context component public interaction boundaries

Status: implemented

English | [中文](2026-10-14-context-component-public-boundaries.zh.md)

## Problem

Browser acceptance did not exercise every error, visibility and asynchronous ownership path in Context controls. The strict coverage gate exposed missing decisions in menus, node controls, recommendation review, draft review, branch suggestions and prompt settings.

## Decision

Add an independent [public component suite](../../../../packages/client/ui-contextify/tests/component-boundaries.client.spec.tsx) using rendered DOM events and actual typed locale strings. Menu tests cover pointer propagation, synchronous failures, rejected native actions and exact record ownership. Node and Chat controls preserve the same durable modes and isolate canvas gestures. Branch decisions disappear only after the explicit Keep operation succeeds.

Draft tests cover menu modes, pending controls, changed text, failure and unmount. Two queued native click events within one React batch verify that the pending guard coalesces duplicate review requests before disabled controls render. Recommendation tests cover partial and reversed inclusion choices, independent routing and task lifecycle decisions, archive review, stale plans and visibility retries. Settings tests connect the public scope, exercise loading and unavailable states, restore failed budget edits and save custom prompts.

The [main panel suite](../../../../packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx) contains 79 public boundary cases. Its private graph-dependent callbacks now capture a known ready graph when created or receive the already narrowed graph or canvas instance from their rendered control. Ready policy state publishes profile and evidence atomically. These construction invariants remove only redundant internal fallbacks; asynchronous marquee cancellation, nullable gesture anchors, unknown node owners, canvas unmount cleanup and pending mutation guards remain validated.

## Alternatives considered

**Invoke private component callbacks.** This would bypass the event boundary and could construct states a user cannot reach.

**Remove defensive guards or ignore coverage paths.** The existing runtime and strict coverage thresholds remain unchanged.

## Consequences

No product behavior, graph geometry, provider request, dependency or performance budget changes. The React Flow Handle is replaced at the external library seam for isolated card tests; its positioning remains covered by the existing graph and browser suites. These tests establish local UI contracts rather than model quality or real-user personalization. The [transport boundary note](2026-10-14-context-client-transport-boundaries.md) covers controller and Client assembly separately.

## Testing

The new suite passes 27 tests. Together with four existing owning suites, 118 tests pass. All eight component sources and the browser Loader seat reach 100% statements, branches, functions and lines: 273 statements, 246 branch paths, 132 functions and 216 lines. A separate two-case view-store suite verifies selection deduplication, deselection, position replacement and clearing without resetting layout; all store measures reach 100%. The component fixture also passes focused Client TypeScript validation and lint. The final whole-Contextify UI run passes all 235 tests in 13 files. Coverage over every UI package source reaches 100%: 1,260 statements, 932 branch paths, 473 functions and 1,020 lines. This aggregate verifies local UI acceptance; it does not claim that Linux, Windows, snapshots, end-to-end checks or the complete CI workflow have all passed.

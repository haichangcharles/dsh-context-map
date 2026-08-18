# Context Map Layout Recovery and Viewport Stability

English | [中文](2026-08-18-context-map-layout-stability-design.zh.md)

**Status:** Approved by the user's direct implementation request.

## Goal

Give users an explicit way to recover a disordered Context Map while ensuring background graph refreshes never override the zoom and pan position they are currently inspecting.

## Root cause

The Contextify controller polls every 1.5 seconds and publishes a new graph projection. React Flow can emit fresh dimension changes after those publications. `ContextMapPanel` currently increments `measurementVersion` for every dimension change, and one effect calls `fitView()` every time that version changes. Therefore a data refresh can indirectly reset a user-owned viewport even when the graph topology has not changed.

## Interaction design

- The first measured graph automatically fits once when the Context Map mounts.
- Search-result changes and an explicit Map focus request may focus their target node.
- Polling, plan mutations, checkbox updates, selection changes, and node remeasurement do not change the current viewport.
- A visible `Re-layout` action clears every persisted manual node position, restores the deterministic tree layout, then fits the complete graph after the new positions render.
- Re-layout does not change context inclusion, selection, plan history, branches, or messages.
- Existing React Flow zoom and pan controls remain available.

## State ownership

React Flow continues to own the live viewport as uncontrolled canvas state. The Context Map view store continues to own only node selection and manual position overrides. Persisting the viewport is intentionally excluded: a saved viewport can become misleading after graph topology changes, and a controlled viewport would introduce avoidable render feedback loops.

The initial-fit gate is component-local and resets when a different Session panel mounts. Explicit focus is keyed by the requested node identity rather than by node measurement. The re-layout action uses the existing `clearPositions` store action and clears transient drag positions before scheduling `fitView()` for the committed layout.

## Deferred Agent work

The three requested Agent ideas remain out of runtime scope and are recorded together in `packages/client/ui-contextify/FUTURE_WORK.md`: context-selection recommendations, pruning recommendations, and branch/main-line promotion recommendations.

## Verification

Automated tests must prove that repeated dimension changes cause only one initial fit, that an ordinary graph refresh preserves the viewport, and that Re-layout clears stored positions and explicitly fits the graph. Browser verification must zoom into a node, wait through multiple polling intervals, confirm the viewport stays unchanged, then drag nodes and confirm Re-layout restores a readable tree and full-graph framing.

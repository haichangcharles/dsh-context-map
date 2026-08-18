# Context Map Layout Stability Implementation Plan

English | [中文](2026-08-18-context-map-layout-stability.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit deterministic graph recovery and prevent ordinary Contextify refreshes from resetting the user's React Flow viewport.

**Architecture:** Split automatic framing into a one-shot initial-fit path and identity-keyed explicit focus path. Re-layout reuses the persisted view store's position reset, clears transient drag state, and frames the graph after React commits the deterministic tree positions.

**Tech Stack:** React 18, TypeScript, React Flow, Vitest, Testing Library, CSS modules.

---

### Task 1: Pin viewport ownership with failing tests

**Files:**
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Add a React Flow test seam**

Mock the React Flow component with an imperative `fitView` spy and controls for emitting dimension changes. Preserve rendered node cards so the test continues to exercise `ContextMapPanel` rather than a separate helper.

- [ ] **Step 2: Add the viewport regression test**

Emit two dimension batches and publish an equivalent refreshed snapshot. Assert that the first measured graph calls `fitView` once and later measurements or refreshes do not call it again.

- [ ] **Step 3: Add the Re-layout behavior test**

Persist a manual node position, click `Re-layout`, and assert that `positionOverrides` becomes empty and `fitView` receives the full-graph request after the scheduled layout commit.

- [ ] **Step 4: Run tests and verify RED**

Run `pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`. Expected: the viewport regression reports repeated fit calls and the Re-layout control is absent.

### Task 2: Separate initial fit, focus, and user re-layout

**Files:**
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`

- [ ] **Step 1: Gate the initial fit**

Replace the measurement-version-driven framing effect with a local one-shot gate. Dimension changes may announce that the first graph is measurable, but later dimension changes cannot schedule another automatic full-graph fit.

- [ ] **Step 2: Keep explicit node focus identity-driven**

Move focused-node and active-search framing into an effect keyed by the target ID and React Flow instance. A stable target must not refocus when polling republishes the graph.

- [ ] **Step 3: Implement Re-layout**

Add a `Re-layout` toolbar button. On activation, clear transient positions, call `actions.clearPositions()`, close the context menu, and schedule a full-graph `fitView({ duration: 220 })` after deterministic positions render.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run `pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`. Expected: all Context Map panel tests pass.

### Task 3: Record deferred Agent opportunities and verify the product

**Files:**
- Create: `packages/client/ui-contextify/FUTURE_WORK.md`
- Create: `packages/client/ui-contextify/FUTURE_WORK.zh.md`
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`

- [ ] **Step 1: Write one future-work list**

Record the three deferred ideas with their intended user decision, output, and safety boundary: recommend context selection, recommend pruning, and recommend branch or main-line promotion. State that recommendations require explicit user review before durable mutation.

- [ ] **Step 2: Update package behavior documentation**

Document the one-shot initial framing, stable user viewport, and explicit Re-layout behavior in both package README languages.

- [ ] **Step 3: Run complete verification**

Run focused Contextify tests, client typecheck, client lint, documentation synchronization gates, and `git diff --check`.

- [ ] **Step 4: Verify in the browser**

Zoom into a node, wait at least four seconds, compare the React Flow transform, then exercise Re-layout after a manual node move and confirm the full deterministic tree returns.

- [ ] **Step 5: Commit the verified change**

Stage only the Context Map layout-stability implementation, tests, design, plan, and future-work documents. Commit with `fix(context-map): preserve viewport across refreshes`.

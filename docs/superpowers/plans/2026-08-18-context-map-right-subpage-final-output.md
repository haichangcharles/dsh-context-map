# Context Map Right Subpage and Final Output Implementation Plan

English | [中文](2026-08-18-context-map-right-subpage-final-output.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Context Map a tree-only native details subpage and reduce every Session turn to its genuine input plus completed final assistant output.

**Architecture:** `contextify/family.ts` performs the canonical turn projection before Session-family de-duplication. `ui-conversation` owns generic in-memory right-page routing, while Contextify only requests the pinned page and remains an additive slot occupant. `ui-layout` remains unchanged and continues owning the native column and resize handle.

**Tech Stack:** TypeScript, React, Cordis scoped services, Engine stores, React Flow/Dagre, Vitest, Testing Library.

---

### Task 1: Project only turn input and completed final output

**Files:**
- Modify: `packages/context/contextify/tests/family.spec.ts`
- Modify: `packages/context/contextify/src/family.ts`

- [ ] **Step 1: Write a failing multi-step projection test**

Append one human input, an intermediate text assistant step, a Tool result, a final assistant text step, and `turn/end { kind: 'completed' }`. Assert the graph previews equal only the input and final text. Project the same events before `turn/end` and assert only the input appears. Add an error-ended turn and assert its partial assistant text is absent.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/context/contextify/tests/family.spec.ts
```

Expected: FAIL because `projectSessionFamily` currently emits every visible assistant event.

- [ ] **Step 3: Implement turn-level selection**

Replace the independent `visibleMessage` scan with a helper that returns selected surface events. It should emit genuine human inputs immediately, retain only the last visible assistant candidate for the active turn, and commit that candidate only when the matching `turn/end` reason is `completed`. Feed the selected events through the existing canonical-owner, edge, branch-boundary, and de-duplication logic.

- [ ] **Step 4: Run Contextify tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/context/contextify/tests/family.spec.ts packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/compiler.spec.ts
```

Expected: all tests pass.

### Task 2: Remove layout choice from the Context Map surface

**Files:**
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`

- [ ] **Step 1: Write a failing tree-only surface test**

Assert that no `Context Map layout` toolbar exists and that buttons named `tree layout`, `mindmap layout`, and `timeline layout` are absent. Seed the store with `mindmap` before rendering and assert the graph still uses the tree projection.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
```

Expected: FAIL because the three layout buttons are currently rendered.

- [ ] **Step 3: Force the tree projection and remove mode controls**

Stop subscribing to the persisted layout value, call `layoutContextMap(..., 'tree')`, remove the layout-mode button group and mode attributes/keys, and retain Select, Clear manual changes, Undo, and Redo as ordinary graph actions.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Vitest command and expect all tests to pass.

### Task 3: Route Context Map and Tool details as native subpages

**Files:**
- Create: `packages/client/ui-conversation/src/client/details-navigation.ts`
- Modify: `packages/client/ui-conversation/src/client/service.ts`
- Modify: `packages/client/ui-conversation/src/client/apply.ts`
- Modify: `packages/client/ui-conversation/src/client/contract/slots.ts`
- Modify: `packages/client/ui-conversation/src/client/skeleton/DetailsPanel.tsx`
- Modify: `packages/client/ui-conversation/src/client/skeleton/DetailsPanel.module.css`
- Modify: `packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`
- Modify: `packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **Step 1: Write failing navigation and rendering tests**

Test that opening Tool details selects the Tool page; `conversation.openPinnedDetails()` selects the pinned page without clearing the Tool selection; DetailsPanel renders only the requested page; and Contextify Locate requests the pinned page before opening the native details column.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest run packages/client/ui-conversation/tests/apply-inject.client.spec.tsx packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

Expected: FAIL because no details-page registry or subpage tabs exist.

- [ ] **Step 3: Implement session-scoped page requests**

Add an in-memory registry exposing stable snapshots `{ page: 'pinned' | 'tool', revision }`, session-scoped subscriptions, and idempotent requests. Add `openPinnedDetails()` to `IConversation`. Tool inspection requests `tool`; Contextify message and graph locate actions request `pinned` and call the existing `ctx.layout.openDetails()`.

- [ ] **Step 4: Render mutually exclusive native subpages**

When pinned entries exist, render a two-tab header for Context Map and Details. Disable Details without a Tool selection. Render `conversation.details.pinned` only on the pinned page and the existing Tool drawer only on the Tool page. Preserve the native column close callback and do not change `AppFrame` or its handle CSS.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 3 Vitest command and expect all tests to pass.

### Task 4: Full verification and documentation

**Files:**
- Modify: relevant package `README.md`, `README.zh.md`, and `Agent Note.md` files required by repository policy.

- [ ] **Step 1: Run package regression tests**

```bash
pnpm vitest run packages/context/contextify/tests packages/client/ui-contextify/tests packages/client/ui-conversation/tests packages/client/ui-layout/tests
```

- [ ] **Step 2: Run type and lint checks**

```bash
pnpm run typecheck:contracts-ready
pnpm run lint:contracts-ready
```

- [ ] **Step 3: Run real-browser verification**

Open `http://127.0.0.1:3080/`, verify layout labels are absent, the Context Map/Details subpages switch without losing selection, only final assistant outputs appear, and the native details resize handle remains present on a wide viewport.

- [ ] **Step 4: Commit the verified implementation**

Stage only the scoped files and commit with an intentional feature message after `git status --short` and the verification outputs are clean.

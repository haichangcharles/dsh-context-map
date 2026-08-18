# Trajectory Inspector Right Sidebar Implementation Plan

English | [中文](2026-08-18-trajectory-inspector-right-sidebar.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the unchanged native Trajectory Inspector in Harness's far-right Details page while keeping Context Map/Details switching manual.

**Architecture:** `ui-conversation` adds a generic session-scoped Inspector slot and keeps its host mounted while Context Map is visible. `ui-trajectory` registers a stable host element for that slot and portals the existing Inspector into it, preserving the current `TrajectoryTable` selection and tab state without a second renderer or an automatic page request.

**Tech Stack:** React 18, TypeScript, Cordis scoped slots, Vitest, Testing Library, CSS modules.

---

### Task 1: Add a native Inspector seat to the right-column shell

**Files:**
- Modify: `packages/client/ui-conversation/src/client/contract/slots.ts`
- Modify: `packages/client/ui-conversation/src/client/apply.ts`
- Modify: `packages/client/ui-conversation/src/client/skeleton/DetailsPanel.tsx`
- Modify: `packages/client/ui-conversation/src/client/skeleton/DetailsPanel.module.css`
- Test: `packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`
- Test: `packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`

- [x] **Step 1: Write failing DetailsPanel tests**

Extend the DetailsPanel switching test with a `conversation.details.inspector` render result. Assert that the Inspector host stays mounted but hidden while Context Map is selected, becomes visible only after the user clicks Details, and the click does not mutate the Tool selection. Add an apply registration assertion for the new session-scoped single child slot.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm vitest run packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx packages/client/ui-conversation/tests/apply-inject.client.spec.tsx
```

Expected: FAIL because `conversation.details.inspector` is not declared or rendered.

- [x] **Step 3: Add the generic Inspector slot and stable page host**

Declare:

```text
const inspectorSlot = {
  kind: 'single',
  scope: 'session',
  owner: {} as Record<string, never>,
}
```

Include it in `DetailsSlotProps` and in the `details` registration's child declarations. In `DetailsPanel`, keep the Inspector drawer mounted and hide it when `activePage !== 'tool'`; render the new slot with the existing Tool drawer as fallback. Keep Context Map conditional so the canvas has one visible page. Add `.drawer[hidden] { display: none; }`.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run the Task 1 command. Expected: all focused conversation tests pass.

### Task 2: Portal the existing Trajectory Inspector into the seat

**Files:**
- Create: `packages/client/ui-trajectory/src/client/TrajectoryInspectorSeat.tsx`
- Create: `packages/client/ui-trajectory/src/client/TrajectoryInspectorSeat.module.css`
- Modify: `packages/client/ui-trajectory/src/client/index.ts`
- Modify: `packages/client/ui-trajectory/src/client/TrajectoryView.tsx`
- Modify: `packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`
- Modify: `packages/client/ui-trajectory/src/client/TrajectoryTable.module.css`
- Test: `packages/client/ui-trajectory/tests/table.client.spec.tsx`
- Test: `packages/client/ui-trajectory/tests/views.client.spec.tsx`

- [x] **Step 1: Write failing portal and registration tests**

Register a DOM host using the Session-derived host ID, render a TrajectoryTable with one selectable record, click the row, and assert:

```text
expect(view.queryByLabelText('Event details')).toBeNull()
expect(within(host).getByLabelText('Event details')).toBeTruthy()
```

Also assert the empty Inspector guidance appears in the host before selection and that `ui-trajectory` registers `conversation.details.inspector` once per Session.

- [x] **Step 2: Run focused Trajectory tests and verify RED**

Run:

```bash
pnpm vitest run packages/client/ui-trajectory/tests/table.client.spec.tsx packages/client/ui-trajectory/tests/views.client.spec.tsx
```

Expected: FAIL because no Inspector seat or portal target exists.

- [x] **Step 3: Implement the stable Session host**

Create a pure host-ID helper and seat component:

```text
export function trajectoryInspectorHostId(sessionId: SessionId): string {
  return `dsh-trajectory-inspector-${sessionId}`
}

export function TrajectoryInspectorSeat({ hostId }: { hostId: string }) {
  return <div id={hostId} className={css.root} data-trajectory-inspector-host="" />
}
```

Register the component into `conversation.details.inspector`. Inject the same host ID into `TrajectoryView`, then pass it to `TrajectoryTable`.

- [x] **Step 4: Portal the existing Inspector without changing selection semantics**

Resolve the host after commit with `useLayoutEffect`, import `createPortal` from `react-dom`, and replace the internal Inspector sibling with:

```text
{inspectorHost !== null && createPortal(inspectorContent, inspectorHost)}
```

Render a neutral empty state in that host when nothing is selected. Remove only the obsolete internal Inspector width state, resize pointer handlers, and internal resize handle. Keep record/request selection, tab history, hierarchy navigation, close-selection behavior, timeline selection, and inspect handoff unchanged. Give the external Inspector `width: 100%`, `max-width: none`, `height: 100%`, and no duplicate left border.

- [x] **Step 5: Run focused Trajectory tests and verify GREEN**

Run the Task 2 command. Expected: all focused Trajectory tests pass.

### Task 3: Lock the manual-switching experiment invariant

**Files:**
- Test: `packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`
- Test: `packages/client/ui-trajectory/tests/table.client.spec.tsx`

- [x] **Step 1: Add cross-behavior assertions**

Assert that selecting a record changes only the Trajectory selection and portal content; it must not invoke `showToolDetails`. Assert that switching Context Map → Details → Context Map → Details preserves the same Inspector DOM, selected record, and active inner tab.

- [x] **Step 2: Verify RED if any hidden remount remains**

Run the two focused suites. Expected: any conditional unmount or automatic navigation fails the preservation assertions.

- [x] **Step 3: Make the minimum lifecycle correction**

Keep the Inspector slot host mounted under the hidden Details drawer and use stable Session host IDs. Do not add a selection-side page-navigation call.

- [x] **Step 4: Verify GREEN**

Run the two focused suites. Expected: all tests pass.

### Task 4: Documentation, regression, browser verification, and commit

**Files:**
- Modify: `packages/client/ui-conversation/README.md`
- Modify: `packages/client/ui-conversation/README.zh.md`
- Modify: `packages/client/ui-conversation/README.i18n.yaml`
- Modify: `packages/client/ui-trajectory/README.md`
- Modify: `packages/client/ui-trajectory/README.zh.md`
- Modify: `packages/client/ui-trajectory/README.i18n.yaml`
- Modify: `docs/superpowers/specs/2026-08-18-trajectory-inspector-right-sidebar-design.md`
- Modify: `docs/superpowers/specs/2026-08-18-trajectory-inspector-right-sidebar-design.zh.md`
- Modify: `docs/superpowers/specs/2026-08-18-trajectory-inspector-right-sidebar-design.i18n.yaml`

- [x] **Step 1: Document the final ownership and portal bridge**

Record that the native right column owns placement, Trajectory owns Inspector behavior, selection does not navigate pages, and the stable slot host keeps one Inspector instance mounted. Update the design architecture from state promotion to the slot-host portal chosen to minimize experimental variables.

- [x] **Step 2: Run scoped regression**

Run:

```bash
pnpm vitest run packages/client/ui-conversation/tests packages/client/ui-trajectory/tests packages/client/ui-layout/tests packages/client/ui-contextify/tests
pnpm run typecheck:contracts-ready
pnpm run lint:contracts-ready
git diff --check
```

Expected: zero failures.

- [x] **Step 3: Run documentation gates**

Record translation pairs and run `pnpm run doc-sync`. Expected: all gates pass.

- [x] **Step 4: Verify the real browser flow**

At `http://127.0.0.1:3080/`, select an assistant and a Tool in Trajectory. Confirm no internal Inspector opens. Confirm Context Map stays visible until the user manually clicks Details. Confirm Details shows the selected native Inspector, its inner tabs work, and switching pages preserves selection.

- [x] **Step 5: Commit the verified implementation**

```bash
git add packages/client/ui-conversation packages/client/ui-trajectory docs/superpowers
git commit -m "feat(trajectory): move inspector to right sidebar"
```

# Details Reveal Control Implementation Plan

English | [中文](2026-08-18-details-reveal-control.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a floating left-arrow on the frame's right edge that reopens the native details column after Context Map or Tool details is closed.

**Architecture:** `ui-layout/AppFrame` renders the control from resolved column state, so it never duplicates Contextify or conversation state. The button calls the existing layout action; the last selected Context Map/Tool subpage and all feature state remain mounted and unchanged.

**Tech Stack:** React 19, TypeScript, CSS Modules, Engine store, Vitest, Testing Library.

---

### Task 1: Add the native details reveal button

**Files:**
- Modify: `packages/client/ui-layout/tests/app-frame.client.spec.tsx`
- Modify: `packages/client/ui-layout/tests/columns.client.spec.ts`
- Modify: `packages/client/ui-layout/src/client/AppFrame.tsx`
- Modify: `packages/client/ui-layout/src/client/AppFrame.module.css`
- Modify: `packages/client/ui-layout/src/client/columns.ts`

- [x] **Step 1: Write the failing AppFrame interaction test**

Add a test that finds `Open details panel` while a non-blank Session has zero resolved details width, clicks it, and expects the details track to become 360px. Assert the button then disappears and the details resize handle appears. Add a no-Session assertion that the button is absent, plus a 900px-frame case proving explicit reveal still grants details its 300px floor.

```tsx
const { frame, getByRole, queryByRole } = mountFrame()
fireEvent.click(getByRole('button', { name: 'Open details panel' }))
expect(tracks(frame)).toEqual([280, 360])
expect(queryByRole('button', { name: 'Open details panel' })).toBeNull()
expect(frame.querySelector('[data-side="details"]')).toBeTruthy()
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/client/ui-layout/tests/app-frame.client.spec.tsx
```

Expected: FAIL because AppFrame renders no button named `Open details panel`.

- [x] **Step 3: Implement the minimal reveal control**

In AppFrame, render a real button only when `detailsSession !== undefined && cols.details === 0`. Give it `aria-label="Open details panel"`, call `actions.openDetails`, and render `‹` inside an `aria-hidden` span. Style it as a vertically centered floating pill at the right edge with hover and focus-visible states. Keep `DragHandle` and Contextify state unchanged. In `columns.ts`, keep explicitly open details at its floor after ordinary concession and let center absorb the remaining deficit; only an exceptionally tiny frame may squeeze details below that floor.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: all AppFrame tests pass.

### Task 2: Verify Details subpage switching and document the control

**Files:**
- Modify: `packages/client/ui-layout/README.md`
- Modify: `packages/client/ui-layout/README.zh.md`
- Verify: `packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`

- [x] **Step 1: Extend and run the Details switching test**

Run:

```bash
pnpm vitest run packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx -t "switches pinned content and Tool details"
```

Expected: PASS, proving Details is clickable without a Tool selection and shows the native empty state; after selection, switching pages retains Tool selection.

- [x] **Step 2: Update the layout README pair**

Document that a closed native details column exposes the floating left-arrow for an active non-blank Session, while an open column replaces it with the resize handle. Update both languages and re-record their translation pairing.

- [x] **Step 3: Run assembled verification**

Run:

```bash
pnpm vitest run packages/client/ui-layout/tests packages/client/ui-conversation/tests packages/client/ui-contextify/tests
pnpm run typecheck:contracts-ready
pnpm run lint:contracts-ready
git diff --check
```

Expected: all tests and gates pass.

- [x] **Step 4: Verify the real browser flow**

At `http://127.0.0.1:3080/`, close Context Map, assert the floating left arrow appears, click it, and assert Context Map reopens. Click the Details subpage without a Tool selection and assert the native empty-state guidance replaces Context Map.

- [x] **Step 5: Commit the verified implementation**

```bash
git add packages/client/ui-layout docs/superpowers/plans/2026-08-18-details-reveal-control*
git commit -m "feat(layout): add details reveal control"
```

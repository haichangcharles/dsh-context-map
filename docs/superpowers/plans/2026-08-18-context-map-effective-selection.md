# Context Map Effective Selection Implementation Plan

English | [中文](2026-08-18-context-map-effective-selection.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Context Map's peer-level Natural, Include, and Exclude UI with an effective-context checkbox that preserves native Context Plan semantics.

**Architecture:** Pure helpers derive automatic and effective inclusion from native Session membership plus the stored override. Context Map owns only optimistic presentation state; every committed change still calls the existing Contextify controller, and returning to the automatic value sends Natural. Checkbox events are isolated from React Flow dragging and canvas selection.

**Tech Stack:** TypeScript, React 18, React Flow, Vitest, Testing Library, Contextify Remote.

---

### Task 1: Define effective-context semantics

**Files:**
- Modify: `packages/client/ui-contextify/src/client/canvas-interactions.ts`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Write failing helper tests**

Add assertions that active-path Natural is checked, off-path Natural is unchecked, manual overrides reverse those results, and returning to the automatic result resolves to Natural:

```ts
expect(effectiveContextIncluded(true, 'natural')).toBe(true)
expect(effectiveContextIncluded(false, 'natural')).toBe(false)
expect(effectiveContextIncluded(true, 'exclude')).toBe(false)
expect(effectiveContextIncluded(false, 'include')).toBe(true)
expect(modeForEffectiveContext(true, true)).toBe('natural')
expect(modeForEffectiveContext(true, false)).toBe('exclude')
expect(modeForEffectiveContext(false, false)).toBe('natural')
expect(modeForEffectiveContext(false, true)).toBe('include')
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

Expected: FAIL because `effectiveContextIncluded` and `modeForEffectiveContext` do not exist.

- [ ] **Step 3: Implement the pure helpers**

Replace `nextNodeMode` with explicit effective-state helpers:

```ts
export function effectiveContextIncluded(active: boolean, mode: ContextNodeMode): boolean {
  if (mode === 'include') return true
  if (mode === 'exclude') return false
  return active
}

export function modeForEffectiveContext(active: boolean, included: boolean): ContextNodeMode {
  if (included === active) return 'natural'
  return included ? 'include' : 'exclude'
}
```

Document both exports with complete `@param` and `@returns` JSDoc while repairing the existing helper JSDoc violations in this touched file.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command and expect PASS.

- [ ] **Step 5: Commit the semantic helper**

```bash
git add packages/client/ui-contextify/src/client/canvas-interactions.ts packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git commit -m "refactor: derive effective Context Map selection"
```

### Task 2: Replace node mutation clicks with an isolated checkbox

**Files:**
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Write failing checkbox interaction tests**

Assert that Natural active and off-path nodes render checked and unchecked checkboxes, clicking the checkbox sends Exclude or Include, clicking it again after the matching snapshot sends Natural, and pointer/click events do not invoke node selection or drag behavior. Add a deferred `setNodeMode` promise and assert optimistic checked state, disabled pending state, rollback, and visible error.

```ts
const checkbox = screen.getByRole('checkbox', { name: 'Include root requirement in model context' })
expect(checkbox).toBeChecked()
fireEvent.click(checkbox)
expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 1 }, 'exclude')
expect(checkbox).not.toBeChecked()
expect(checkbox).toBeDisabled()
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

Expected: FAIL because no effective-context checkbox exists and card click still mutates the plan.

- [ ] **Step 3: Implement checkbox data and rendering**

Give `ContextMapNodeData` the effective `included`, `pending`, and `onToggle` fields. Render a controlled checkbox with `nodrag nopan`, stop pointer and click propagation, and call `onToggle(record, event.currentTarget.checked)` from `onChange`. Replace `data-mode` opacity with `data-in-context`; keep node-body clicks only for canvas Selection mode.

```tsx
<input
  type="checkbox"
  className={`${css.contextCheckbox} nodrag nopan`}
  aria-label={`${value.included ? 'Remove' : 'Include'} ${preview} ${value.included ? 'from' : 'in'} model context`}
  checked={value.included}
  disabled={value.pending}
  onPointerDown={(event) => { event.stopPropagation() }}
  onClick={(event) => { event.stopPropagation() }}
  onChange={(event) => { value.onToggle(record, event.currentTarget.checked) }}
/>
```

- [ ] **Step 4: Implement optimistic mutation ownership**

In `ContextMapPanel`, store one optimistic mode map and an immediate local mutation lock. Derive each node's displayed mode from the optimistic value before the controller snapshot. On success, clear optimistic state after the controller promise publishes; on failure, clear it and set `actionError`. Disable all context mutations while either local or controller pending is true.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Step 2 command and expect PASS with no unhandled promise rejection.

- [ ] **Step 6: Commit the checkbox interaction**

```bash
git add packages/client/ui-contextify/src/client/ContextMapNode.tsx packages/client/ui-contextify/src/client/ContextMapPanel.tsx packages/client/ui-contextify/src/client/ContextMapPanel.module.css packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git commit -m "feat: add effective context checkboxes"
```

### Task 3: Align menu, batch, header, and Reset semantics

**Files:**
- Modify: `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- Test: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **Step 1: Write failing product-language tests**

Assert `3 / 3 in context`, `Clear manual changes`, menu omission of Natural/Include/Exclude, conditional Restore Automatic, and effective batch mutations that normalize to Natural when the requested checkbox result matches path membership.

```ts
expect(screen.getByText('3 / 3 in context')).toBeTruthy()
expect(screen.getByRole('button', { name: 'Clear manual changes' })).toBeTruthy()
expect(within(menu).queryByRole('menuitem', { name: 'Include' })).toBeNull()
expect(within(menu).getByRole('menuitem', { name: 'Restore automatic' })).toBeTruthy()
```

- [ ] **Step 2: Run both component suites and verify RED**

Run: `pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

Expected: FAIL on the old selected label, Reset label, and three-state menu.

- [ ] **Step 3: Implement the simplified menu and toolbar**

Keep Locate in Chat and Branch from Here. Render Restore Automatic only when `mode !== 'natural'`, and route it through the panel's guarded mutation runner. Rename the header count and Reset button. Preserve Undo and Redo.

- [ ] **Step 4: Implement effective batch actions**

Rename actions to Set in context, Set out of context, and Restore automatic. For each selected record, derive active-path membership and call `modeForEffectiveContext(active, desired)`; Restore automatic sends Natural for every selected node. Disable the bar while a mutation is pending and surface failures.

- [ ] **Step 5: Run both component suites and verify GREEN**

Run the Step 2 command and expect PASS.

- [ ] **Step 6: Commit the aligned controls**

```bash
git add packages/client/ui-contextify/src/client/ContextMapMenu.tsx packages/client/ui-contextify/src/client/ContextMapPanel.tsx packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
git commit -m "feat: simplify Context Map context controls"
```

### Task 4: Document and verify the assembled behavior

**Files:**
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`
- Modify: `packages/client/ui-contextify/README.i18n.yaml`
- Modify: `.agents/notes/implemented/feature/2026-08-17-native-session-context-map.md`
- Modify: `.agents/notes/implemented/feature/2026-08-17-native-session-context-map.zh.md`
- Modify: `.agents/notes/implemented/feature/2026-08-17-native-session-context-map.i18n.yaml`
- Modify: `apps/web/tests/contextify-map.e2e.ts`

- [ ] **Step 1: Update the replay E2E before implementation snapshots**

Change the scenario to assert checkbox state, one checkbox mutation, Clear Manual Changes, conditional Restore Automatic, right-click Locate in Chat, multi-selection, and live drag. Run the single E2E and confirm it fails on the old controls.

Run: `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts`

- [ ] **Step 2: Update current-state documentation**

Document effective checkbox semantics, persistent manual overrides, automatic removal when returning to the path-derived value, and Clear Manual Changes. Remove statements that describe whole-card mutation or peer-level Natural/Include/Exclude menu items. Re-record both bilingual pairs.

- [ ] **Step 3: Run focused and assembled verification**

Run:

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
pnpm --filter @deepseek-ai/dsh-client-ui-contextify bundle
pnpm run verify-translation-pairing packages/client/ui-contextify/README.md
git diff --check
```

Expected: all behavior tests, replay E2E, bundle, paired documentation, and whitespace checks pass. Report unrelated pre-existing corpus-wide documentation or lint failures separately instead of modifying them in this feature.

- [ ] **Step 4: Perform browser acceptance**

At `http://127.0.0.1:3080/`, verify checked active-path nodes, unchecked off-path nodes, immediate checkbox feedback without drag activation, Restore Automatic, Clear Manual Changes, Selection-mode outlines independent from checkbox state, right-click Locate across Sessions, and no new console error.

- [ ] **Step 5: Commit documentation and verification**

```bash
git add packages/client/ui-contextify/README.md packages/client/ui-contextify/README.zh.md packages/client/ui-contextify/README.i18n.yaml .agents/notes/implemented/feature/2026-08-17-native-session-context-map.md .agents/notes/implemented/feature/2026-08-17-native-session-context-map.zh.md .agents/notes/implemented/feature/2026-08-17-native-session-context-map.i18n.yaml apps/web/tests/contextify-map.e2e.ts
git commit -m "test: verify effective Context Map selection"
```

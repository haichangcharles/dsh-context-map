# Context Map 确定性空占位节点实施计划

[English](2026-08-19-context-map-empty-placeholder.md) | 中文

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Agent-authored cleanup text with one service-owned marker while rendering the retained graph node as visually empty.

**Architecture:** Keep the existing version 3 replacement overlay and compiler snapshot so node identity, topology, history, and restore behavior remain unchanged. Narrow the recommendation and Remote contracts so only the backend can construct the fixed marker, then make the React node renderer treat replacement metadata—not message text—as the authority for an empty visual body.

**Tech Stack:** TypeScript, Cordis/Typert Remote services, React, React Flow, Vitest, Playwright.

---

## File map

- `packages/context/contextify/src/types.ts`: fixed marker and narrowed cleanup candidate contract.
- `packages/context/contextify/src/recommendation.ts`: validation that strips Agent-authored placeholder fields.
- `packages/context/contextify/src/index.ts`: recommendation schema/prompt and deterministic `replaceNode` mutation.
- `packages/context/contextify/tests/recommendation.spec.ts`: fail-closed structured-output contract tests.
- `packages/context/contextify/tests/service.spec.ts`: compiled fixed marker, role preservation, restore, and legacy compatibility.
- `packages/client/ui-contextify/src/client/controller.ts`: narrowed transport and confirmation APIs.
- `packages/client/ui-contextify/src/client/index.ts`: generated Remote adapter arguments.
- `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`: non-editable cleanup confirmation.
- `packages/client/ui-contextify/src/client/ContextMapNode.tsx`: visually empty replacement cards.
- `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`: narrowed confirmation wiring and placeholder search behavior.
- `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`: UI contract regression coverage.
- `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`: Remote argument regression coverage.
- `apps/web/tests/contextify-map.e2e.ts`: assembled proposal, confirmation, compilation, empty-card, and restore proof.
- Contextify/client READMEs and Agent Note: deterministic marker behavior and legacy compatibility.

### Task 1: Make the backend marker deterministic

**Files:**
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/src/recommendation.ts`
- Modify: `packages/context/contextify/src/index.ts`
- Test: `packages/context/contextify/tests/recommendation.spec.ts`
- Test: `packages/context/contextify/tests/service.spec.ts`

- [ ] **Step 1: Write failing recommendation and service tests**

Add assertions equivalent to:

```text
expect(validateRecommendation({
  selection: [],
  cleanup: [{
    nodeId, category: 'obsolete', reason: 'old', evidenceNodeIds: [],
    placeholderText: 'Agent-authored text must be ignored',
  }],
}, context).cleanup).toEqual([{
  nodeId, category: 'obsolete', reason: 'old', evidenceNodeIds: [],
}])

await ctx.contextify.replaceNode(agent, ref, owner, 'confirmed cleanup', graphRevision)
expect(compiledText).toContain('[Placeholder: intentionally empty]')
expect(compiledText).not.toContain('Agent-authored text')
```

- [ ] **Step 2: Run RED tests**

Run:

```bash
pnpm exec vitest run packages/context/contextify/tests/recommendation.spec.ts packages/context/contextify/tests/service.spec.ts
```

Expected: FAIL because cleanup still exposes `placeholderText` and `replaceNode` still requires caller-authored text.

- [ ] **Step 3: Implement the minimal fixed contract**

Export the package-owned constant and remove the model field:

```text
export const CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT = '[Placeholder: intentionally empty]'

export interface ContextCleanupCandidate {
  readonly nodeId: string
  readonly category: 'obsolete' | 'conflict' | 'redundant'
  readonly reason: string
  readonly evidenceNodeIds: readonly string[]
}
```

Change `validateRecommendation` to return only those four cleanup fields. Remove `placeholderText` from `CONTEXT_RECOMMENDATION_SCHEMA` and instruct the review Agent to identify candidates without proposing replacement content.

Narrow the service mutation and construct the marker internally:

```text
async replaceNode(
  agent: Agent,
  ref: ContextPlanRef,
  nodeRef: ContextMessageRef,
  reason: string,
  expectedGraphRevision?: string,
): Promise<ContextifyView> {
  const explanation = reason.trim()
  const placeholder: Message = structuredClone({
    ...message,
    content: [{ type: 'text', text: CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT }],
  })
  // Existing snapshot append and replacement-overlay commit remain unchanged.
}
```

- [ ] **Step 4: Run GREEN tests**

Run the Task 1 command again. Expected: both files pass and the fixed marker retains the source role.

- [ ] **Step 5: Add legacy replacement regression**

Construct a version 3 plan pointing at an older custom-text compiler snapshot, assert `currentContextPlan` and `compileContextify` still read it, then call `restoreNode` and assert the original message returns. This proves no plan-version migration is needed.

### Task 2: Render a physical empty node and remove the editor

**Files:**
- Modify: `packages/client/ui-contextify/src/client/controller.ts`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- Test: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **Step 1: Write failing client tests**

Render a graph record with `replacement` metadata and assert:

```text
expect(screen.getByRole('article', { name: 'User empty placeholder' }))
  .toHaveAttribute('data-context-node-id', originalNodeId)
expect(within(card).queryByText('[Placeholder: intentionally empty]')).toBeNull()
expect(card.querySelector('[data-preview]')).toHaveAttribute('data-preview', '')
expect(screen.queryByRole('textbox', { name: /Placeholder for/ })).toBeNull()
expect(screen.getByRole('button', { name: 'Confirm empty placeholder' })).toBeEnabled()
```

Update the browser adapter expectation so `remote.replaceNode` receives `(sessionId, ref, node, reason, graphRevision)` with no placeholder argument.

- [ ] **Step 2: Run RED tests**

Run:

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

Expected: FAIL because the marker is visible, the editor exists, and the transport still forwards placeholder text.

- [ ] **Step 3: Narrow controller and adapter APIs**

Use these signatures:

```text
replaceNode: (
  ref: ContextPlanRef,
  node: ContextMessageRef,
  reason: string,
  expectedGraphRevision?: string,
) => Promise<ContextifyView>

async confirmCleanup(candidate: ContextCleanupCandidate): Promise<void> {
  // Existing freshness checks remain.
  await this.mutate(ref => this.transport.replaceNode(
    ref, node.owner, candidate.reason, recommendation.proposal.base.graphRevision,
  ))
}
```

- [ ] **Step 4: Replace editable review UI with deterministic confirmation**

Delete `drafts`, the textarea, and After-text preview. Keep the original preview and graph pivot metadata, and render:

```text
<button type="button" onClick={() => { run(() => confirmCleanup(item)) }}>
  Confirm empty placeholder
</button>
```

- [ ] **Step 5: Render replacement cards with an empty visual body**

Use replacement metadata as the switch rather than the replacement text:

```text
const emptyPlaceholder = record.replacement !== undefined
const preview = emptyPlaceholder ? '' : record.preview || '(empty message)'
const accessibleName = emptyPlaceholder
  ? `${record.role === 'user' ? 'User' : 'Assistant'} empty placeholder`
  : `${record.role === 'user' ? 'User' : 'Assistant'} message: ${preview}`
```

Keep the existing role header, checkbox, replacement badge, handles, node ID, and context menu. Exclude replacement bodies from search matching so hidden marker text cannot produce a search result.

- [ ] **Step 6: Run GREEN tests**

Run the Task 2 command again. Expected: both files pass with no React warnings.

### Task 3: Prove the assembled behavior and update documentation

**Files:**
- Modify: `apps/web/tests/contextify-map.e2e.ts`
- Modify: `apps/web/tests/snapshots/contextify-map/compiled-placeholder.expected.md`
- Modify: `packages/context/contextify/README.md`
- Modify: `packages/context/contextify/README.zh.md`
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`
- Modify: `.agents/notes/implemented/feature/2026-08-19-context-map-reviewed-semantics.md`
- Modify: `.agents/notes/implemented/feature/2026-08-19-context-map-reviewed-semantics.zh.md`

- [ ] **Step 1: Update E2E fixture output and write the failing assertion**

Remove `placeholderText` from the deterministic recommendation result. After confirmation assert:

```text
const emptyCard = map.getByRole('article', { name: 'User empty placeholder' })
await emptyCard.waitFor()
expect(await emptyCard.locator('[data-preview]').getAttribute('data-preview')).toBe('')
expect(compiledText).toBe('[Placeholder: intentionally empty]')
```

Keep existing Show original, Restore original, archive, branch, reload, and measured-spacing assertions.

- [ ] **Step 2: Run RED E2E**

Run:

```bash
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts
```

Expected: FAIL until the browser bundle contains the new deterministic UI and Remote contract.

- [ ] **Step 3: Build and run GREEN E2E**

Run:

```bash
pnpm run build:lib:client
pnpm run build:web
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts
```

Expected: one E2E test passes; the fixed-marker golden matches.

- [ ] **Step 4: Update bilingual documentation**

Document that AI chooses only candidate node IDs and reasons; the backend owns the fixed marker; the client hides it; old custom snapshots remain restorable. Refresh translation pairing records with:

```bash
pnpm run verify-translation-pairing --write packages/context/contextify/README.md
pnpm run verify-translation-pairing --write packages/client/ui-contextify/README.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-19-context-map-reviewed-semantics.md
```

### Task 4: Release gates, deployment, and implementation commit

**Files:**
- Regenerate: `packages/extensions/tool-cordis/src/api-catalog.ts`
- Regenerate affected documentation catalogs and pairing records.

- [ ] **Step 1: Regenerate contracts and catalogs**

```bash
pnpm run gen-cordis-catalog
pnpm run gen-doc-graphs
pnpm run gen-config-catalog
pnpm run gen-persistence-catalog
```

- [ ] **Step 2: Run full relevant verification**

```bash
pnpm exec vitest run packages/context/contextify/tests packages/client/ui-contextify/tests
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

Expected: all commands exit zero, with no test failures or documentation drift.

- [ ] **Step 3: Restart and smoke-test the local product**

Restart `pnpm dsh web`, open `http://127.0.0.1:3080/`, confirm Context Map and native Details both render, a replacement card has an empty body, Show original restores visibility, and browser console errors are empty.

- [ ] **Step 4: Commit the implementation**

```bash
git add packages/context/contextify packages/client/ui-contextify \
  apps/web/tests/contextify-map.e2e.ts apps/web/tests/snapshots/contextify-map \
  packages/extensions/tool-cordis/src/api-catalog.ts docs \
  .agents/notes/implemented/feature/2026-08-19-context-map-reviewed-semantics.md \
  .agents/notes/implemented/feature/2026-08-19-context-map-reviewed-semantics.zh.md \
  .agents/notes/implemented/feature/2026-08-19-context-map-reviewed-semantics.i18n.yaml
git commit -m "feat(context-map): use deterministic empty placeholders"
git status --short
```

Expected: the commit succeeds and the worktree is clean.

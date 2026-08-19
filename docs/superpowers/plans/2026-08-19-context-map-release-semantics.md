# Context Map Release Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship atomic Context version replacement, single-node archive, canonical native Branch hierarchy, prompt configuration, lightweight post-Turn Branch suggestions, and an opaque Context Map menu.

**Architecture:** `@deepseek-ai/dsh-contextify` remains the Host authority for the native Session-family graph, Context Plan, isolated reviews, and relocation. The browser plugin projects Host proposals into one Current → Proposed review, uses the existing placeholder overlay for node archive, and contributes Profile prompt settings through the native settings UI. Branch detection is one tool-free subagent request scheduled after a completed Turn; confirmation performs an idempotent native fork and deterministic Q+A replay.

**Tech Stack:** TypeScript, Cordis plugins, Typert Remotes, Harness Session/Agent/Subagent/Settings services, React 18, React Flow, Vitest, Testing Library, Playwright replay tests.

---

## File map

- `packages/context/contextify/src/recommendation.ts`: untrusted Context review normalization and Current/Proposed derivation.
- `packages/context/contextify/src/branch-review.ts`: completed-Turn extraction, bounded one-shot Branch input, output validation, and relocation keys.
- `packages/context/contextify/src/settings.ts`: prompt defaults, settings schema, and effective-prompt resolution.
- `packages/context/contextify/src/types.ts`: Remote-safe review, archive, Branch suggestion, relocation, and settings types.
- `packages/context/contextify/src/index.ts`: service lifecycle, Remotes, atomic Context mutations, review scheduling, and relocation orchestration.
- `packages/context/contextify/src/family.ts`: unchanged canonical-owner algorithm; regression tests pin its sibling/child rule.
- `packages/client/ui-contextify/src/client/controller.ts`: review state, atomic Proposed apply, Archive confirmation, and Branch suggestion state.
- `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`: Current → Proposed diff and separate Archive review.
- `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`: Archive/Restore actions.
- `packages/client/ui-contextify/src/client/BranchSuggestionCard.tsx`: non-modal post-answer suggestion.
- `packages/client/ui-contextify/src/client/ContextifyPromptSettings.tsx`: gray default prompt, append field, explicit override, and reset.
- `packages/client/ui-contextify/src/client/prompt-settings-store.ts`: native settings RPC state and optimistic-concurrency writes.
- `packages/client/ui-contextify/src/client/index.ts`: Remote adapters and slot registrations.
- `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`: opaque menu and archived presentation.
- `packages/context/contextify/tests/*.spec.ts`, `packages/client/ui-contextify/tests/*.client.spec.tsx`, and `apps/web/tests/contextify-map.e2e.ts`: focused and assembled acceptance coverage.

### Task 1: Normalize Context recommendations into complete versions

**Files:**
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/src/recommendation.ts`
- Test: `packages/context/contextify/tests/recommendation.spec.ts`

- [ ] **Step 1: Write the failing protocol tests**

Add cases proving a no-op and a duplicate identical action are removed, conflicting actions reject, and the proposal contains complete versions plus a derived diff:

```ts
it('normalizes a delta into Current and Proposed versions', () => {
  const proposal = validateRecommendation({
    selection: [
      { nodeId: 'root:1', action: 'include', reason: 'no change', confidence: 'low' },
      { nodeId: 'root:2', action: 'exclude', reason: 'not relevant', confidence: 'high' },
      { nodeId: 'root:2', action: 'exclude', reason: 'same action', confidence: 'high' },
    ],
    archive: [],
  }, { base, graph, effectiveIncludedNodeIds: ['root:1', 'root:2'] })

  expect(proposal.currentNodeIds).toEqual(['root:1', 'root:2'])
  expect(proposal.proposedNodeIds).toEqual(['root:1'])
  expect(proposal.addedNodeIds).toEqual([])
  expect(proposal.removedNodeIds).toEqual(['root:2'])
  expect(proposal.selection.map(item => item.nodeId)).toEqual(['root:2'])
})

it('rejects conflicting actions for one node', () => {
  expect(() => validateRecommendation({
    selection: [
      { nodeId: 'root:1', action: 'include', reason: 'keep', confidence: 'high' },
      { nodeId: 'root:1', action: 'exclude', reason: 'drop', confidence: 'high' },
    ],
    archive: [],
  }, { base, graph, effectiveIncludedNodeIds: ['root:1'] })).toThrow(/conflicting/)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts
```

Expected: FAIL because `archive`, `currentNodeIds`, `proposedNodeIds`, `addedNodeIds`, and `removedNodeIds` are not implemented and no-op selection still throws.

- [ ] **Step 3: Add the complete-version fields and normalization**

Define the proposal fields in `types.ts`:

```ts
export interface ContextRecommendationProposal {
  readonly base: ContextRecommendationBase
  readonly currentNodeIds: readonly string[]
  readonly proposedNodeIds: readonly string[]
  readonly addedNodeIds: readonly string[]
  readonly removedNodeIds: readonly string[]
  readonly selection: readonly ContextSelectionRecommendation[]
  readonly archive: readonly ContextArchiveCandidate[]
}
```

Define `ContextArchiveCandidate` in the same step with `nodeId`, `category: 'obsolete' | 'conflict' | 'redundant'`, `reason`, and `evidenceNodeIds`. Replace the structured-output field `cleanup` with `archive` in the schema and validator so every later task uses one name.

In `validateRecommendation`, collect the first valid action per node, ignore an identical duplicate, reject a different duplicate action, remove actions that do not change `effective`, derive `proposed`, and order every ID by `graph.nodes` rather than model output order. Preserve strict validation for node IDs, action values, reasons, confidence, Archive evidence, and bounded text.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: PASS with no warnings.

- [ ] **Step 5: Commit the protocol change**

```bash
git add packages/context/contextify/src/types.ts packages/context/contextify/src/recommendation.ts packages/context/contextify/tests/recommendation.spec.ts
git commit -m "fix(contextify): normalize context replacement proposals"
```

### Task 2: Apply Proposed as one Context Plan revision

**Files:**
- Modify: `packages/client/ui-contextify/src/client/controller.ts`
- Modify: `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextRecommendationReview.module.css`
- Test: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Write the failing controller and component tests**

Pin one Apply call, one `setNodeModes` Remote, and Current → Proposed summary copy:

```ts
await b.panel.mapActions.recommend()
await b.panel.mapActions.applyRecommendations()
expect(b.calls.filter(call => call.method === 'setNodeModes')).toHaveLength(1)
expect(controller.getSnapshot().recommendation).toEqual({ phase: 'idle' })
```

```ts
expect(screen.getByText('Current context')).toBeTruthy()
expect(screen.getByText('Proposed context')).toBeTruthy()
expect(screen.getByText('1 added')).toBeTruthy()
expect(screen.getByText('1 removed')).toBeTruthy()
expect(screen.getByRole('button', { name: 'Apply proposed context' })).toBeTruthy()
expect(screen.queryByRole('button', { name: /^Apply .* recommendation/ })).toBeNull()
```

- [ ] **Step 2: Run both tests and verify RED**

```bash
pnpm vitest run packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
```

Expected: FAIL because the sheet still exposes per-item Apply and does not render complete versions.

- [ ] **Step 3: Implement one replacement action**

Change `applyRecommendations()` to apply every normalized `selection` item and remove its `nodeIds` argument. Keep one `setNodeModes` call with the proposal graph revision. Render summary counters, grouped Added and Removed lists, one `Apply proposed context` action, Dismiss, and a stale banner. Keep node reasons as expandable details, not separate mutations.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/ui-contextify/src/client/controller.ts packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx packages/client/ui-contextify/src/client/ContextRecommendationReview.module.css packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git commit -m "feat(context-map): review context as one replacement"
```

### Task 3: Expose single-node Archive and Restore

**Files:**
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`
- Modify: `packages/client/ui-contextify/src/client/controller.ts`
- Modify: `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Write failing Archive tests**

Add a service test that calls the existing role-preserving replacement through an Archive-named API and proves compilation uses the fixed marker, graph topology is unchanged, and Undo restores content. Add a menu test that expects `Archive node` for an ordinary node and `Restore node` for an archived node.

```ts
const archived = await ctx.contextify.archiveNode(active.agent, { revision: 1 }, node.owner)
expect(archived.plan.replacements).toHaveLength(1)
expect(compileContextify({ session: active.session, turn: -1, step: -1 }).messages.at(-1)?.content)
  .toEqual([{ type: 'text', text: CONTEXTIFY_EMPTY_PLACEHOLDER_TEXT }])
const restored = ctx.contextify.undo(active.agent, { revision: archived.plan.revision })
expect(restored.plan.replacements).toEqual([])
```

```ts
expect(within(menu).getByRole('menuitem', { name: 'Archive node' })).toBeTruthy()
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/service.spec.ts packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
```

Expected: FAIL because `archiveNode` and the menu actions do not exist.

- [ ] **Step 3: Implement Archive naming over deterministic replacement**

Add `@Remote('archiveNode') archiveNode(agent, ref, nodeRef, expectedGraphRevision?)` and move the fixed-placeholder body out of `replaceNode`. Keep `replaceNode` only if generated Remote compatibility still requires it during the same change; otherwise update every caller and regenerate Typert. Use the fixed reason `Archived by user` for direct actions. Rename `ContextCleanupCandidate` to `ContextArchiveCandidate`, schema field `cleanup` to `archive`, and visible copy from Cleanup/Replacement to Archive/Restore. An archived node remains a checkbox-capable graph pivot with an `Archived` badge and empty body.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/contextify packages/client/ui-contextify
git commit -m "feat(context-map): archive individual message nodes"
```

### Task 4: Pin canonical sibling and child Branch hierarchy

**Files:**
- Modify: `packages/context/contextify/tests/family.spec.ts`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`
- Test: `packages/client/ui-workspace/tests/tree.client.spec.ts`

- [ ] **Step 1: Write the nested inherited-node regression**

Create root `A-B-C`, fork `branch1` at C, add `D1`, then test both fork addresses:

```ts
expect(inheritedC.owner.sessionId).toBe(root.id)
expect(inheritedC.branchAtSeq).toBe(rootBoundary)
expect(branchLocalD1.owner.sessionId).toBe(branch1.id)
```

In the browser test, call Branch while branch1 is active and assert inherited C forks from root while D1 forks from branch1:

```ts
expect(fork).toHaveBeenNthCalledWith(1, {
  sessionId: root,
  atSeq: rootBoundary,
  increaseTitle: true,
})
expect(fork).toHaveBeenNthCalledWith(2, {
  sessionId: branch1,
  atSeq: branch1Boundary,
  increaseTitle: true,
})
```

- [ ] **Step 2: Run focused tests and verify the current contract**

```bash
pnpm vitest run packages/context/contextify/tests/family.spec.ts packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx packages/client/ui-workspace/tests/tree.client.spec.ts
```

Expected: the family assertion passes if canonical ownership is intact; the new browser fixture fails until it includes both inherited and local records. Any product-code failure must be corrected at canonical ownership or `node.owner`, not by adding a second UI hierarchy.

- [ ] **Step 3: Make the Branch source rule explicit**

Extract one client helper and use it for manual and suggested fork calls:

```ts
export function nativeBranchSource(node: ContextFamilyGraphNode): {
  sessionId: SessionId
  atSeq: number
  increaseTitle: true
} {
  if (node.branchAtSeq === null) throw new Error('Message has no completed Turn boundary')
  return { sessionId: node.owner.sessionId, atSeq: node.branchAtSeq, increaseTitle: true }
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command, then:

```bash
git add packages/context/contextify/tests/family.spec.ts packages/client/ui-contextify/src/client/index.ts packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx packages/client/ui-workspace/tests/tree.client.spec.ts
git commit -m "test(context-map): pin canonical branch hierarchy"
```

### Task 5: Add Profile prompt settings on the Host

**Files:**
- Create: `packages/context/contextify/src/settings.ts`
- Create: `packages/context/contextify/tests/settings.spec.ts`
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/package.json`
- Modify: `packages/context/contextify/tsconfig.json`
- Modify: `packages/bundle/web-app/cordis.patch.yml`

- [ ] **Step 1: Write failing settings tests**

Test default, append, override, reset inheritance, and snapshot behavior:

```ts
expect(effectivePrompt(defaults.context, { additional: 'Prefer recent facts.', override: '' }))
  .toBe(`${defaults.context}\n\nAdditional profile instructions:\nPrefer recent facts.`)
expect(effectivePrompt(defaults.context, { additional: 'Short.', override: 'Custom base.' }))
  .toBe('Custom base.\n\nAdditional profile instructions:\nShort.')
expect(effectivePrompt(defaults.context, { additional: '', override: '' })).toBe(defaults.context)
```

- [ ] **Step 2: Run the settings test and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/settings.spec.ts
```

Expected: FAIL because `settings.ts` does not exist.

- [ ] **Step 3: Implement the settings owner**

Use `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-settings` to register namespace `contextify` with three `{ additional, override }` sections: `context`, `archive`, and `branch`. Bound every prompt string to 16,000 characters. Export package-owned default prompts and a pure `effectivePrompt()` that trims fields, uses override only when non-empty, and appends a clearly delimited profile instruction block. Store the `SettingsScope` on `ContextifyService`; read once at the start of each review.

Add both packages as Contextify peer/dev dependencies and add their project references. Make `settings` a required Contextify injection because the shipped Web profile already composes the settings provider before Contextify; a missing provider must fail at plugin load rather than silently discard profile rules.

- [ ] **Step 4: Verify GREEN and composition**

```bash
pnpm vitest run packages/context/contextify/tests/settings.spec.ts packages/context/contextify/tests/service.spec.ts
pnpm run gen-cordis-catalog
```

Expected: tests PASS and generated configuration metadata includes the Contextify settings namespace dependencies without a Loader error.

- [ ] **Step 5: Commit**

```bash
git add packages/context/contextify packages/bundle/web-app/cordis.patch.yml docs/config-catalog.md docs/config-catalog.zh.md docs/config-catalog.i18n.yaml
git commit -m "feat(contextify): configure review prompts by profile"
```

### Task 6: Add the native Prompt Dashboard

**Files:**
- Create: `packages/client/ui-contextify/src/client/prompt-settings-store.ts`
- Create: `packages/client/ui-contextify/src/client/ContextifyPromptSettings.tsx`
- Create: `packages/client/ui-contextify/src/client/ContextifyPromptSettings.module.css`
- Create: `packages/client/ui-contextify/src/client/locales.ts`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/package.json`
- Test: `packages/client/ui-contextify/tests/prompt-settings.client.spec.tsx`
- Test: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **Step 1: Write failing dashboard tests**

For each of Context, Archive, and Branch, assert the default prompt is a disabled gray textarea, Additional instructions is editable, and Override requires explicit activation:

```ts
expect(screen.getByLabelText('Default Context prompt')).toHaveProperty('readOnly', true)
fireEvent.change(screen.getByLabelText('Additional Context instructions'), {
  target: { value: 'Do not branch parallel alternatives.' },
})
fireEvent.click(screen.getByRole('button', { name: 'Save Context instructions' }))
expect(api.settings.mutate).toHaveBeenCalledWith(expect.objectContaining({ ns: 'contextify' }))
fireEvent.click(screen.getByRole('button', { name: 'Override default Context prompt' }))
expect(screen.getByRole('dialog', { name: 'Confirm prompt override' })).toBeTruthy()
```

- [ ] **Step 2: Run the client tests and verify RED**

```bash
pnpm vitest run packages/client/ui-contextify/tests/prompt-settings.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

Expected: FAIL because the settings component and slot registration do not exist.

- [ ] **Step 3: Implement the settings controller and section**

Follow the existing settings RPC pattern: load `settings.describe`, retain namespace revision and raw user fields, and save only path-addressed changes through `settings.mutate` with `expectedRevision`. Register a `settings.section` entry named `contextify-prompts`. Render three cards. `Default prompt` stays read-only; `Additional instructions` is the primary editor; `Override default prompt` opens a confirmation and then enables the custom base editor; `Restore default` unsets only the override path. Show effective prompt preview and settings-conflict errors without discarding the draft.

Add `@deepseek-ai/dsh-client-ui-settings`, `@deepseek-ai/dsh-client-locale`, and `@deepseek-ai/dsh-api-remotes` to the client manifest injection/dependency faces used by the section. Extend `inject` with `locale` and `connection`, then register bilingual copy and refresh the settings controller on `settings/document-updated` for namespace `contextify`.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/ui-contextify
git commit -m "feat(context-map): add prompt settings dashboard"
```

### Task 7: Implement one-shot post-Turn Branch review

**Files:**
- Create: `packages/context/contextify/src/branch-review.ts`
- Create: `packages/context/contextify/tests/branch-review.spec.ts`
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`

- [ ] **Step 1: Write failing pure and service tests**

Pin candidate extraction to the completed Turn's first user-origin input and final assistant output, bounded history to three Turns, and output to one decision:

```ts
const candidate = completedTurnCandidate(session.events, turnEnd.seq)
expect(candidate).toMatchObject({
  turn: 4,
  input: { role: 'user' },
  output: { role: 'assistant' },
  boundaryBefore: priorTurnEnd.seq,
  boundaryAfter: turnEnd.seq,
})
expect(validateBranchDecision({ action: 'suggest_branch', confidence: 0.88, reason: 'Parallel topic' }))
  .toEqual({ action: 'suggest_branch', confidence: 0.88, reason: 'Parallel topic' })
```

In the service harness, emit a completed `turn/end`, resolve one mocked spawn subagent result, and assert `toolFilter: { allow: [] }`, one start call, low-confidence silence, and no second review for the same Turn.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/branch-review.spec.ts packages/context/contextify/tests/service.spec.ts
```

Expected: FAIL because completed-Turn review scheduling and branch decision types do not exist.

- [ ] **Step 3: Implement the one-shot review**

Listen to committed `session/event` `turn/end` events whose reason is completed, whose Session has a live non-subagent Agent, and whose Turn lacks a `contextify/branch-review` result. Queue the review after the listener returns so the main Turn closes first. Start one `spawn` provider run with no tools, a small output schema, and `maxTokens: 320`. Snapshot the Branch effective prompt at start. Append an ignorable durable review event containing the Turn boundary, decision, confidence, reason, and analyzed family revision; malformed, failed, timed-out, or low-confidence results append no visible suggestion and never throw into the originating loop.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/contextify
git commit -m "feat(contextify): review completed turns for branching"
```

### Task 8: Implement idempotent native Branch relocation

**Files:**
- Modify: `packages/context/contextify/src/branch-review.ts`
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`

- [ ] **Step 1: Write failing relocation tests**

Test a source with prefix C and completed Q+A. Confirm relocation and assert the child forks at C, replays exactly one completed Turn, source nodes compile as placeholders, and retry returns the same child ID:

```ts
const first = await ctx.contextify.acceptBranchSuggestion(agent, request)
const second = await ctx.contextify.acceptBranchSuggestion(agent, request)
expect(second.childSessionId).toBe(first.childSessionId)
expect(ctx.sessions.list().filter(session => session.header.parentSession === source.id)).toHaveLength(1)
expect(ctx.sessions.get(first.childSessionId)?.events.filter(event => event.type === 'turn/end')).toHaveLength(1)
expect(currentContextPlan(source).replacements.map(item => item.nodeId).sort())
  .toEqual([candidate.inputNodeId, candidate.outputNodeId].sort())
```

Add stale-plan, stale-family, newer-Turn, missing-output, and replay-recursion tests.

- [ ] **Step 2: Run the service test and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/service.spec.ts -t "branch relocation"
```

Expected: FAIL because `acceptBranchSuggestion` does not exist.

- [ ] **Step 3: Implement the Remote operation**

Derive relocation key as SHA-256 over `sourceSessionId:turnEndSeq`. Revalidate the proposal base and ensure the source has no event after the candidate `turn/end` except Contextify advisory events. Search the family for an existing `contextify/branch-relocation` child event with the key before forking. Otherwise fork at `boundaryBefore`, append one `turn/start`, the imported user message, the imported final assistant message, `turn/end`, and an ignorable relocation marker. Suppress review scheduling for the replay by marker/key. Commit both source replacements as one `nextPlan` revision, then return `{ childSessionId }`.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command, then the complete Contextify package tests. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/context/contextify
git commit -m "feat(contextify): relocate completed turns into native branches"
```

### Task 9: Render and accept Branch suggestions

**Files:**
- Create: `packages/client/ui-contextify/src/client/BranchSuggestionCard.tsx`
- Create: `packages/client/ui-contextify/src/client/BranchSuggestionCard.module.css`
- Modify: `packages/client/ui-contextify/src/client/controller.ts`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Test: `packages/client/ui-contextify/tests/branch-suggestion.client.spec.tsx`
- Test: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **Step 1: Write failing client tests**

Assert the card appears only for a current high-confidence suggestion, Keep dismisses it, Move calls one Remote and opens the returned child, and a newer graph revision marks it expired:

```ts
expect(screen.getByText('Move this Q&A to a new branch?')).toBeTruthy()
fireEvent.click(screen.getByRole('button', { name: 'Move to new branch' }))
await waitFor(() => { expect(remote.acceptBranchSuggestion).toHaveBeenCalledTimes(1) })
expect(open).toHaveBeenCalledWith(child)
```

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run packages/client/ui-contextify/tests/branch-suggestion.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

Expected: FAIL because no card, controller state, or adapter exists.

- [ ] **Step 3: Implement review projection and actions**

Expose the latest durable Branch suggestion through `ContextifyView` or a dedicated Remote read. The controller reconciles it against current Session, plan, family, and Turn revisions. Register the card in the conversation assistant-action/dock slot so it appears beside the completed answer without blocking input. `Keep here` records dismissal for that suggestion ID. `Move to new branch` calls the relocation Remote, refreshes Context Map state, and opens the returned native Session.

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command, then:

```bash
git add packages/client/ui-contextify
git commit -m "feat(context-map): review branch relocation suggestions"
```

### Task 10: Make the context menu opaque and finish product copy

**Files:**
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- Modify: `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Add the failing style and semantics assertions**

Assert the menu carries an opaque-surface marker and archived nodes use Archive wording:

```ts
expect(menu.getAttribute('data-opaque-surface')).toBe('true')
expect(screen.getByText('Archived')).toBeTruthy()
expect(screen.queryByText('Cleanup suggested')).toBeNull()
```

- [ ] **Step 2: Run the component test and verify RED**

```bash
pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
```

Expected: FAIL because the marker and final copy do not exist.

- [ ] **Step 3: Apply the final menu presentation**

Set `.contextMenu` to a fully opaque theme background with no transparent `color-mix`, `backdrop-filter`, or inherited canvas opacity; use `z-index: 30`, a visible border, and shadow. Add `data-opaque-surface="true"`. Ensure disabled item opacity affects only the button content, not the menu container.

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command, then:

```bash
git add packages/client/ui-contextify/src/client/ContextMapPanel.module.css packages/client/ui-contextify/src/client/ContextMapMenu.tsx packages/client/ui-contextify/src/client/ContextMapNode.tsx packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git commit -m "fix(context-map): make node actions legible"
```

### Task 11: Update contracts, Agent Note, generated Remotes, and assembled verification

**Files:**
- Modify: `packages/context/contextify/README.md`
- Modify: `packages/context/contextify/README.zh.md`
- Modify: `packages/context/contextify/README.i18n.yaml`
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`
- Modify: `packages/client/ui-contextify/README.i18n.yaml`
- Create: `.agents/notes/implemented/feature/2026-08-19-context-map-release-semantics.md`
- Create: `.agents/notes/implemented/feature/2026-08-19-context-map-release-semantics.zh.md`
- Create: `.agents/notes/implemented/feature/2026-08-19-context-map-release-semantics.i18n.yaml`
- Modify: `apps/web/tests/contextify-map.e2e.ts`

- [ ] **Step 1: Extend the assembled replay before final implementation verification**

Add one deterministic scenario covering: completed Q+A, no-op-safe Current → Proposed review, one Apply plus Undo, direct Archive plus Restore, one visible Branch suggestion, accepted relocation, sibling/child tree identity, prompt addition persistence, and the opaque menu marker.

- [ ] **Step 2: Regenerate owned artifacts and bilingual records**

```bash
pnpm --filter @deepseek-ai/dsh-contextify bundle
pnpm run verify-translation-pairing --write packages/context/contextify/README.md
pnpm run verify-translation-pairing --write packages/client/ui-contextify/README.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-19-context-map-release-semantics.md
```

Expected: the built Host and Remote faces include Archive, Branch review, and relocation methods; all three bilingual records are written.

- [ ] **Step 3: Run the focused package and GUI ladder**

```bash
pnpm vitest run packages/context/contextify/tests
pnpm vitest run packages/client/ui-contextify/tests packages/client/ui-workspace/tests/tree.client.spec.ts
pnpm run test:gui
pnpm run typecheck
pnpm run lint
```

Expected: every command exits 0 with no new warning.

- [ ] **Step 4: Run the assembled Web replay**

```bash
DSH_SNAPSHOT=replay pnpm run test:web
```

Expected: keyless replay scenarios pass and real-provider cases self-skip without credentials.

- [ ] **Step 5: Run documentation and diff gates**

```bash
pnpm run doc-sync
git diff --check
git status --short
```

Expected: documentation gates pass, diff check is empty, and status contains only the intended release-semantics files.

- [ ] **Step 6: Commit the integrated contracts**

```bash
git add .agents/notes/implemented/feature/2026-08-19-context-map-release-semantics* apps/web/tests/contextify-map.e2e.ts packages/context/contextify packages/client/ui-contextify
git commit -m "feat(context-map): complete release semantics"
```

### Task 12: Browser acceptance and release handoff

**Files:**
- Verify only: `http://127.0.0.1:3080/`

- [ ] **Step 1: Start or refresh the Web profile with Node 22**

```bash
export PATH="/Users/haichangli/.nvm/versions/node/v22.23.2/bin:$PATH"
hash -r
pnpm dsh web --port 3080
```

Expected: the existing server refreshes or a new server listens on `127.0.0.1:3080` without Loader errors.

- [ ] **Step 2: Perform fresh-page browser acceptance**

Verify on a new page rather than a cached tab:

1. Context Map opens and the right-click menu is opaque.
2. Archive one user node; its body becomes empty, its edges remain, and the next Context compilation omits its original semantics.
3. Restore and confirm the original content returns.
4. Run Recommend with a fixture that returns a no-op plus one real change; no error banner appears, one Current → Proposed diff appears, Apply makes one revision, and Undo restores it.
5. Complete an off-topic Q+A; input is usable immediately while the Branch card appears later.
6. Accept the card; the child opens with the complete Q+A and the source Map retains two empty pivots.
7. Branch again from the inherited fork point and confirm the Sidebar shows a sibling; branch from a child-local node and confirm a child row.
8. Open Settings → Context Map prompts; default prompts are gray/read-only, additions save, override requires confirmation, and Restore default leaves additions intact.
9. Inspect the browser console and Network panel; no uncaught error, rejected Remote, repeated Branch review, or duplicate child appears.

- [ ] **Step 3: Record final evidence**

Record the final commit, focused test counts, `test:gui`, `test:web`, typecheck, lint, doc-sync, and browser acceptance result in the handoff. Do not claim full release readiness if any command or browser step is skipped.

# Context Map Release Semantics Implementation Plan

> **For implementing Agents:** Execute tasks in order with executing-plans; write a failing test before implementation, then verify and commit each task. The step-level code examples in this file and its Chinese counterpart carry equal authority.

English | [中文](2026-08-19-context-map-release-semantics.zh.md)

**Goal:** Ship atomic Context version replacement, single-node Archive, canonical native Branch hierarchy, Profile prompt configuration, lightweight post-Turn Branch suggestions, and an opaque Context Map menu.

**Architecture:** `@deepseek-ai/dsh-contextify` remains the Host authority for the Session family graph, Context Plan, isolated reviews, and relocation. The browser only projects Host proposals, uses the existing placeholder overlay for Archive, and contributes Profile prompt UI through native settings. Branch detection is an opt-in, tool-free auxiliary model call after a completed Turn; confirmation performs an idempotent native fork and deterministic Q+A replay.

**Tech stack:** TypeScript, Cordis, Typert Remote, Harness Session/Agent/Subagent/Settings, React 18, React Flow, Vitest, Testing Library, and Playwright replay.

---

## File map

- `packages/context/contextify/src/recommendation.ts`: untrusted Agent output normalization and Current/Proposed derivation.
- `packages/context/contextify/src/branch-review.ts`: completed-Turn extraction, Branch decision validation, and relocation keys.
- `packages/context/contextify/src/settings.ts`: default prompts, Profile schema, and effective prompts.
- `packages/context/contextify/src/types.ts`: Remote-safe recommendation, Archive, Branch suggestion, and relocation types.
- `packages/context/contextify/src/index.ts`: service lifecycle, Remotes, atomic plan mutation, review scheduling, and relocation.
- `packages/context/contextify/src/family.ts`: canonical sibling/child ancestry.
- `packages/client/ui-contextify/src/client/controller.ts`: review state, atomic Apply, Archive, and Branch suggestions.
- `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`: Current/Proposed diff and separate Archive review.
- `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`: Archive/Restore and opaque menu.
- `packages/client/ui-contextify/src/client/BranchSuggestionCard.tsx`: non-modal post-answer suggestion.
- `packages/client/ui-contextify/src/client/ContextifyPromptSettings.tsx`: default prompt, append, explicit override, and reset.
- `packages/client/ui-contextify/src/client/index.ts`: Remote adapters and slot registrations.
- Host/Client specs and `apps/web/tests/contextify-map.e2e.ts`: focused and assembled acceptance.

## Task 1: Normalize Context recommendations into complete versions

**Modify:** `types.ts`, `recommendation.ts`; **test:** `recommendation.spec.ts`.

- [ ] Write failing tests proving Include on an already-included node and Exclude on an already-excluded node are no-ops; identical duplicates merge; Include+Exclude on one node rejects; unknown nodes reject.
- [ ] Proposal must contain `currentNodeIds`, `proposedNodeIds`, `addedNodeIds`, `removedNodeIds`, normalized `selection`, and separate `archive`.
- [ ] Ordering must come from the family graph rather than Agent output, ensuring stable diff and replay.
- [ ] Run `pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts`.

Core pseudocode:

```text
current = orderedSet(effectiveIncludedNodeIds)
actions = normalize(raw.selection)
for action of actions:
  assertKnownNode(action.nodeId)
  rejectContradiction(action)
  if actionWouldChange(current, action): apply(current, action)
proposed = graphOrder(current)
return {
  currentNodeIds: graphOrder(effectiveIncludedNodeIds),
  proposedNodeIds: proposed,
  addedNodeIds: proposed - current,
  removedNodeIds: current - proposed,
  selection: onlyEffectiveActions,
  archive: validateArchive(raw.archive),
}
```

## Task 2: Apply Current → Proposed atomically

**Modify:** Host `setNodeModes`, Client controller, and review sheet; **test:** service and client specs.

- [ ] UI shows only one version diff: current count, proposed count, additions, removals, and reasons.
- [ ] Remove per-item Apply; expose only `Apply proposed context`.
- [ ] Client sends proposal.selection once; Host validates plan revision, graph revision, active Session, and idle Agent.
- [ ] Append only one plan revision after every action is prepared; any failed check writes no snapshot or plan.
- [ ] One Undo restores the complete prior version; Dismiss makes no durable change.

Core pseudocode:

```text
async applyProposal(proposal) {
  assertFresh(proposal.base)
  mutations = proposal.selection.map(toNodeMutation)
  return setNodeModes(currentPlanRef, mutations, proposal.base.graphRevision)
}
```

## Task 3: Archive and Restore one input/output

**Modify:** `index.ts`, controller, node/menu/review; **test:** Host/Client specs.

- [ ] Right-click menu exposes `Archive node` for each user input or final assistant output.
- [ ] Archive never changes Include/Exclude; it only adds a replacement overlay.
- [ ] Always write `[Placeholder: intentionally empty]`; do not accept Agent- or UI-authored content.
- [ ] Preserve node ID, role, edges, fork boundary, and the original Session event.
- [ ] Archived cards show a badge; right-click exposes Show original and Restore node.
- [ ] Recommended Archive requires individual review and confirmation; never bulk auto-apply.
- [ ] Reset, Undo, and Redo include Archive overlays.

Core pseudocode:

```text
archiveNode(ref, node, reason, graphRevision) {
  current = prepareCAS(ref)
  graph = loadAndAssertRevision(graphRevision)
  target = resolveGenuineMessage(node)
  replacement = appendFixedRolePreservingSnapshot(target, PLACEHOLDER)
  commit(nextPlan(current, { replacements: current.replacements + replacement }))
}
```

## Task 4: Canonicalize Branch hierarchy

**Modify:** `family.ts`; **test:** `family.spec.ts` and Workspace tree spec.

- [ ] Pin two cases: re-forking an inherited boundary is a sibling; forking a branch-local boundary is a child.
- [ ] Canonicalize only projected `parentSessionId`; never rewrite native Session headers.
- [ ] Preserve graph message ownership, de-duplication, and edges.
- [ ] Workspace tree and Context Map consume the same canonical result.

Core pseudocode:

```text
canonicalParent(session) {
  rawParent = session.parentSession
  if (!rawParent) return undefined
  forkBoundary = session.seedLength - 1
  if (forkBoundary <= rawParent.inheritedBoundary)
    return canonicalParent(rawParent)
  return rawParent.id
}
```

## Task 5: Profile-owned Prompt Settings

**Modify:** Host `settings.ts`, Contextify service, API Proxy allowlist; **test:** settings/service specs.

- [ ] Create a `contextify` namespace with `context`, `archive`, and `branch` sections.
- [ ] Each section has only `additional` and `override`, each limited to 16k characters.
- [ ] Package owns default prompts; Profiles store only user differences.
- [ ] Non-empty `override.trim()` replaces the package base; additional instructions are still appended.
- [ ] Recommendation uses effective Context+Archive prompts; post-Turn review uses the effective Branch prompt.
- [ ] All three Agents reuse the parent Agent's Harness provider/model route and have no tools.

Core pseudocode:

```text
effectivePrompt(base, settings) =
  (settings.override.trim() || base) +
  (settings.additional.trim() ? "\n\nAdditional profile instructions:\n" + settings.additional : "")
```

## Task 6: Native Prompt Dashboard

**Modify:** `ContextifyPromptSettings.tsx/.module.css`, client registration; **test:** prompt/browser specs.

- [ ] Register a Contextify section in native Profile Settings.
- [ ] Context, Archive, and Branch cards show the package prompt in a gray read-only control.
- [ ] Additional instructions are editable by default and saved in Profile scope.
- [ ] Override remains hidden/disabled until explicit confirmation.
- [ ] Restore package prompt clears only override and preserves additional instructions.
- [ ] Cover optimistic concurrency, save failure, Profile switching, and unmount.

## Task 7: Lightweight post-Turn Branch review

**Modify:** `branch-review.ts`, Session events, service lifecycle; **test:** branch-review/service specs.

- [ ] Respond only to `turn/end` with `reason.kind === 'completed'`.
- [ ] Extract the Turn's first genuine user input and final visible assistant output; ignore reasoning, tools, and intermediate output.
- [ ] Keep automatic review disabled by default; expose one explicit Profile checkbox because enabling it adds a model call per Turn.
- [ ] After the parent Agent becomes idle, asynchronously run one text-only auxiliary call with `maxTokens=320`; do not create a visible subagent.
- [ ] Parse only `{ action: keep|suggest_branch, confidence, reason }` from the bounded response.
- [ ] Do not surface confidence below 0.8; write at most one review event per turnEndSeq.
- [ ] Never block the primary answer, enter an Agent loop, or append review prompt/reasoning to the parent transcript.

## Task 8: Idempotent native Branch relocation

**Modify:** Host Remote and Session event; **test:** service spec.

- [ ] Before acceptance, assert idle Agent, available suggestion, fresh plan/graph, and no newer conversation event.
- [ ] Derive a SHA-256 relocation key and deterministic child Session ID from source Session + turnEndSeq.
- [ ] Archive source input/output in one source plan revision.
- [ ] Call `sessions.fork` at `boundaryBefore` and replay exact input/output as one completed Turn in the child.
- [ ] Write a relocation marker in the child; retry returns that child when the marker exists.
- [ ] Retry after a fork failure can recover from source placeholders without re-archiving.

## Task 9: Branch suggestion card and navigation

**Modify:** `BranchSuggestionCard`, `ContextMessageAction`, client adapter; **test:** client specs.

- [ ] Render the card only beside the suggestion's final output; never use a modal.
- [ ] Show a concise reason and two actions: Keep here, Move to new branch.
- [ ] Keep here only dismisses; Move calls the Remote and opens the returned child Session.
- [ ] Present stale/error through the ordinary error panel; never retry mutation implicitly.

## Task 10: Opaque menu and final copy

- [ ] Menu uses a semantic layer background, `opacity: 1`, no backdrop transparency, and sits above edges/nodes.
- [ ] Menu items depend precisely on node state, avoiding confusion between Archive and Restore automatic.
- [ ] Use Current/Proposed, Archive, and Branch consistently; remove legacy cleanup/delete wording.

## Task 11: Documentation, types, and generated catalogs

- [ ] Update Host/Client Contextify READMEs in English and Chinese.
- [ ] Add an implemented Agent Note and translation pairing record.
- [ ] Complete JSDoc params/returns for every exported API.
- [ ] Run `pnpm run gen-client-catalog`, `gen-cordis-catalog`, `gen-persistence-catalog`, and `doc-sync`.
- [ ] Run translation pairing, Markdown, package path, and `git diff --check` gates.

## Task 12: Release acceptance

Run in order:

```bash
pnpm run typecheck
pnpm vitest run packages/context/contextify/tests packages/client/ui-contextify/tests packages/client/ui-workspace/tests/tree.client.spec.ts
pnpm run lint
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
```

Browser acceptance:

- [ ] Real chat renders only initial input and final output.
- [ ] Long nodes rank by measured bounding boxes without overlap.
- [ ] Right-click menu is fully opaque; Locate, Branch, Archive, and Restore work.
- [ ] Archive does not alter the checkbox; Restore recovers original content.
- [ ] Recommend shows one complete diff; Apply/Undo operate on versions.
- [ ] Prompt Dashboard is read-only by default, append saves, and override needs confirmation.
- [ ] A high-confidence Branch card moves Q&A and opens the child; refresh and retry do not duplicate it.
- [ ] Branches from one inherited boundary are siblings in the sidebar and Map; branch-local forks remain children.

## Definition of done

All automated gates and browser acceptance pass; no skipped item is hidden; the worktree contains only this feature and its generated catalogs; the commit message independently describes Context Map release semantics. If Web replay cannot run because of an external dependency, the handoff must state that clearly and must not claim full release readiness.

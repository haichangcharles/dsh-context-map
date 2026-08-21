# Lightweight Context Recommendations Implementation Plan

English | [中文](2026-08-20-lightweight-context-recommendations.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the slow recommendation subagent with a direct three-list classifier and render Branch decisions inline after the completed turn.

**Architecture:** The model emits only `include`, `exclude`, and `archive` JSON; `recommendation.ts` owns parsing, no-op filtering, conflict rejection, and proposal construction. `ContextifyService` owns one bounded direct LLM request and stale checks. The client registers Branch review in the native `conversation.chat.turnTail` slot and renders recommendation failures once near the toolbar.

**Tech Stack:** TypeScript, Cordis services/slots, Harness LLM streaming, React 18, Vitest, Testing Library.

---

### Task 1: Define and validate the three-list protocol

**Files:**
- Modify: `packages/context/contextify/src/recommendation.ts`
- Modify: `packages/context/contextify/tests/recommendation.spec.ts`

- [ ] **Step 1: Write failing parser and validator tests**

Add tests that call `parseRecommendationDecisionText()` with fenced JSON and missing arrays, then call `validateRecommendation()` with `include`, `exclude`, and `archive`. Assert already-effective actions disappear, conflicting actions and unknown IDs throw, and the resulting `currentNodeIds`, `proposedNodeIds`, `addedNodeIds`, and `removedNodeIds` are complete graph-ordered versions.

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts`. Expect failure because the parser is not exported and the validator still requires `selection`.

- [ ] **Step 3: Implement the minimal parser and normalizer**

Export `parseRecommendationDecisionText(text)`. Extract one JSON object, normalize absent arrays to `[]`, validate only `{nodeId, reason}` items, translate include/exclude entries into the existing internal selection records, and preserve deterministic system-owned archive metadata. Reject cross-list conflicts before filtering no-ops.

- [ ] **Step 4: Verify GREEN**

Run `pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts`. Expect all protocol tests to pass.

### Task 2: Replace the recommendation subagent with one direct LLM request

**Files:**
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`

- [ ] **Step 1: Write failing direct-call service tests**

Replace the spawn-provider recommendation test with a captured `ctx.llm.stream()` request. Return text containing the three-list JSON and assert the proposal is review-only, the request has no tools, uses a bounded output budget, and creates no child Session. Update the stale-family test so its delayed direct stream completes after a sibling mutation.

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run packages/context/contextify/tests/service.spec.ts -t recommendation`. Expect the service to fail because it still requires the spawn provider.

- [ ] **Step 3: Implement the direct classifier**

Remove `CONTEXT_RECOMMENDATION_SCHEMA` and the spawn-provider guard. Assemble text blocks from one `ctx.llm.stream()` request using the latest assistant provider/model, a compact system prompt, `temperature: 0`, and a bounded token budget. Parse with `parseRecommendationDecisionText()`, validate with the Task 1 system layer, retain both stale checks, and keep the `recommending` concurrency guard.

- [ ] **Step 4: Verify GREEN**

Run the targeted recommendation service tests, then the complete `packages/context/contextify/tests/service.spec.ts` suite. Expect all tests to pass and no recommendation-created Session.

### Task 3: Put Branch suggestions in the turn flow

**Files:**
- Create: `packages/client/ui-contextify/src/client/BranchSuggestionTail.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMessageAction.tsx`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/src/client/BranchSuggestionCard.module.css`
- Modify: `packages/client/ui-contextify/tests/branch-suggestion.client.spec.tsx`
- Modify: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **Step 1: Write failing slot and visibility tests**

Assert the plugin registers `conversation.chat.turnTail`; the tail renders the card only when `suggestion.output.seq` equals the owning turn's output sequence; the message action never renders the card; disposal removes the added slot.

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run packages/client/ui-contextify/tests/branch-suggestion.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`. Expect missing turnTail registration/component failures.

- [ ] **Step 3: Implement the in-flow tail**

Move suggestion selection/dismiss state into `BranchSuggestionTail`. Register it at `conversation.chat.turnTail`, inject the shared controller and native relocation action, remove card rendering and relocation dependencies from `ContextMessageAction`, and style the card as a normal-flow bounded block without absolute/fixed positioning.

- [ ] **Step 4: Verify GREEN**

Run both client test files and expect all slot, card, and action tests to pass.

### Task 4: Show one compact recommendation failure

**Files:**
- Modify: `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Write a failing error-state test**

Render the panel with `recommendation.phase === 'error'` and assert exactly one `role="alert"`, a dismiss action, and no recommendation `role="dialog"` overlay.

- [ ] **Step 2: Verify RED**

Run `pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`. Expect duplicate/overlay behavior to fail the assertions.

- [ ] **Step 3: Implement one inline notice**

Render the recommendation error between the toolbar and canvas, make Recommend rely on controller state instead of copying the same exception into `actionError`, and make `ContextRecommendationReview` render only ready/stale proposals.

- [ ] **Step 4: Verify GREEN**

Run the panel test and expect one non-modal failure notice.

### Task 5: Reduce Branch classifier work and run release verification

**Files:**
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`

- [ ] **Step 1: Add a failing request-bound test**

Capture the Branch `llm.stream()` request and assert at most four recent nodes and a small output-token budget while preserving the completed Q&A and prompt-dashboard system prompt.

- [ ] **Step 2: Verify RED, then implement GREEN**

Run the targeted Branch review test, reduce the recent window from eight to four and the response budget to 200 tokens, then rerun it until green.

- [ ] **Step 3: Run focused and package verification**

Run:

```bash
pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts packages/context/contextify/tests/service.spec.ts
pnpm vitest run packages/client/ui-contextify/tests/branch-suggestion.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
pnpm eslint packages/context/contextify/src packages/context/contextify/tests packages/client/ui-contextify/src packages/client/ui-contextify/tests
pnpm typecheck
```

Expect zero failures, type errors, or lint errors.

- [ ] **Step 4: Browser acceptance**

Open the walkthrough Session at `http://127.0.0.1:3080/`, run Recommend, verify a quick Current → Proposed review and Apply/Undo, trigger/demonstrate a Branch suggestion, verify its card is inline after the output and does not cover the composer, and verify invalid JSON produces one compact notice.

- [ ] **Step 5: Commit**

Stage only the files in this plan and commit with `feat(context-map): simplify recommendations and branch review`.

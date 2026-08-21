# Context Map Dual-Mode Recommendations Implementation Plan

[English](2026-08-20-context-map-dual-mode-recommendations.md) | 中文

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fast bounded Context recommendation, an explicit full-tree Deep recommendation backed by a temporary file and a restricted Harness child, and a lightweight topology-aware automatic Branch classifier.

**Architecture:** Contextify keeps one shared recommendation decision and validator contract. Fast builds a deterministic candidate packet and performs one tool-free LLM request; Deep freezes the complete visible graph into a private temporary JSONL file and creates one scoped Harness child that can only read/search that file and submit structured results. The client selects Fast or Deep manually, reviews the same Current/Proposed diff, and can cancel Deep; Branch review remains a separate small classifier whose decision is computed concurrently with the main response and only published after the final output is durable.

**Tech Stack:** TypeScript, Cordis scoped services, DeepSeek Harness Agent/Tools/LLM/Session runtimes, Node.js temporary filesystem APIs, React 18, XYFlow, Vitest, Testing Library, Playwright.

---

## File map

- `packages/context/contextify/src/types.ts`: public recommendation mode, proposal, progress, settings, and error vocabulary.
- `packages/context/contextify/src/recommendation.ts`: shared decision parsing and fail-closed proposal validation.
- `packages/context/contextify/src/fast-recommendation.ts`: deterministic ChatIndex-style candidate routing only.
- `packages/context/contextify/src/deep-recommendation.ts`: full-tree JSONL projection, private temporary-file lifecycle, exact-path guard, and one-shot child runner.
- `packages/context/contextify/src/branch-review.ts`: pre-response Branch review input projection and decision validation.
- `packages/context/contextify/src/index.ts`: Remote orchestration, route resolution, cancellation, revision checks, and Branch scheduling.
- `packages/client/ui-contextify/src/client/controller.ts`: mode-aware request/cancel state machine.
- `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`: Fast/Deep manual controls and compact running/error presentation.
- `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`: common mode-labelled Current/Proposed review.
- `packages/context/contextify/tests/*.spec.ts`, `packages/client/ui-contextify/tests/*.spec.tsx`, and `apps/web/tests/contextify-map.e2e.ts`: unit, integration, UI, and assembled replay coverage.

### Task 1: Pin the shared recommendation contract and manual-override semantics

**Files:**
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/src/recommendation.ts`
- Test: `packages/context/contextify/tests/recommendation.spec.ts`

- [ ] **Step 1: Write failing contract tests**

Add tests proving that the proposal records its mode, harmless already-effective actions disappear, explicit Include and Exclude nodes cannot be reversed, unknown IDs and opposing actions remain invalid, and archive suggestions stay advisory.

```text
const proposal = validateRecommendation({
  exclude: [
    { nodeId: 'active-natural', reason: 'irrelevant' },
    { nodeId: 'explicit-include', reason: 'must not reverse a pin' },
  ],
  include: [
    { nodeId: 'off-path', reason: 'relevant' },
    { nodeId: 'explicit-exclude', reason: 'must not reverse a block' },
  ],
  archive: [{ nodeId: 'obsolete', reason: 'superseded' }],
}, {
  mode: 'fast',
  base,
  graph,
  effectiveIncludedNodeIds: ['active-natural', 'explicit-include'],
  explicitIncludedNodeIds: ['explicit-include'],
  explicitExcludedNodeIds: ['explicit-exclude'],
})

expect(proposal.mode).toBe('fast')
expect(proposal.selection.map(item => [item.nodeId, item.action])).toEqual([
  ['active-natural', 'exclude'],
  ['off-path', 'include'],
])
expect(proposal.archive).toHaveLength(1)
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts
```

Expected: failure because `ContextRecommendationMode`, proposal `mode`, and explicit override inputs do not exist.

- [ ] **Step 3: Add the public mode and mode-aware proposal types**

Add these exact public fields in `types.ts`:

```text
export type ContextRecommendationMode = 'fast' | 'deep'

export interface ContextRecommendationProposal {
  readonly mode: ContextRecommendationMode
  readonly base: ContextRecommendationBase
  readonly currentNodeIds: readonly string[]
  readonly proposedNodeIds: readonly string[]
  readonly addedNodeIds: readonly string[]
  readonly removedNodeIds: readonly string[]
  readonly selection: readonly ContextSelectionRecommendation[]
  readonly archive: readonly ContextArchiveCandidate[]
}
```

Extend `CONTEXTIFY_RECOMMENDATION_UNAVAILABLE` handling with `CONTEXTIFY_RECOMMENDATION_CANCELLED`; do not add a durable Session event for an ephemeral recommendation.

- [ ] **Step 4: Make validation preserve explicit user choices**

Change the validation context to:

```text
interface RecommendationValidationContext {
  readonly mode: ContextRecommendationMode
  readonly base: ContextRecommendationBase
  readonly graph: ContextFamilyGraph
  readonly effectiveIncludedNodeIds: readonly string[]
  readonly explicitIncludedNodeIds: readonly string[]
  readonly explicitExcludedNodeIds: readonly string[]
}
```

Validate unknown IDs and conflicting actions before no-op filtering. Then drop an `exclude` for an explicit Include and an `include` for an explicit Exclude. Construct `currentNodeIds` and `proposedNodeIds` in canonical graph order, and return `mode` unchanged.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: all recommendation protocol tests pass.

- [ ] **Step 6: Commit the shared contract**

```bash
git add packages/context/contextify/src/types.ts packages/context/contextify/src/recommendation.ts packages/context/contextify/tests/recommendation.spec.ts
git commit -m "feat(context-map): pin recommendation modes and overrides"
```

### Task 2: Build the bounded Fast recommendation packet

**Files:**
- Create: `packages/context/contextify/src/fast-recommendation.ts`
- Create: `packages/context/contextify/tests/fast-recommendation.spec.ts`
- Modify: `packages/context/contextify/src/index.ts`

- [ ] **Step 1: Write failing routing tests**

Create a graph with a long active path, one close sibling, one lexically relevant distant sibling, and explicit Include/Exclude nodes. Assert the packet contains the active path's latest three completed Q&A pairs, every explicit override, branch pivots on the active ancestry, and at most twelve ranked off-path candidates. Assert stable graph-order output and a hard maximum of 32 nodes.

```text
const packet = buildFastRecommendationInput({
  graph,
  contents,
  objective: 'compare observability tracing approaches',
  effectiveIncludedNodeIds,
  explicitIncludedNodeIds,
  explicitExcludedNodeIds,
})

expect(packet.nodes.length).toBeLessThanOrEqual(32)
expect(packet.nodes.filter(node => node.reason === 'recent-active')).toHaveLength(6)
expect(packet.nodes.some(node => node.id === distantRelevantId)).toBe(true)
expect(packet.nodes.some(node => node.id === explicitExcludedId)).toBe(true)
```

- [ ] **Step 2: Run the new test and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/fast-recommendation.spec.ts
```

Expected: module-not-found failure for `fast-recommendation.ts`.

- [ ] **Step 3: Implement deterministic candidate routing**

Export constants and types rather than embedding unexplained numbers:

```text
export const FAST_RECOMMENDATION_MAX_NODES = 32
export const FAST_RECOMMENDATION_OFF_PATH_LIMIT = 12
export const FAST_RECOMMENDATION_RECENT_TURNS = 3
export const FAST_RECOMMENDATION_MAX_NODE_CHARS = 1_200

export interface FastRecommendationNode extends ContextRecommendationInputNode {
  readonly reason: 'recent-active' | 'branch-pivot' | 'explicit-override' | 'off-path-candidate'
  readonly lexicalScore: number
  readonly graphDistance: number | null
}
```

Tokenize objective and message text with Unicode letter/number runs, lowercase them, discard one-character tokens, and compute Jaccard overlap. Compute undirected graph distance from active-path nodes with breadth-first search. Candidate priority is: explicit override, recent active, branch pivot, then off-path by descending lexical score, ascending graph distance, and canonical graph index. Truncate text by Unicode code point and return a frozen packet.

- [ ] **Step 4: Route Fast through the existing tool-free call**

In `ContextifyService.recommend`, move route/model/system assembly into private helpers and replace `buildRecommendationInput()` with `buildFastRecommendationInput()` when `mode === 'fast'`. Preserve temperature `0`, lowest reasoning effort, `maxTokens: 640`, no tools, both stale checks, and the shared validator.

- [ ] **Step 5: Verify Fast unit and service behavior**

```bash
pnpm vitest run packages/context/contextify/tests/fast-recommendation.spec.ts packages/context/contextify/tests/recommendation.spec.ts packages/context/contextify/tests/service.spec.ts -t "recommend"
```

Expected: bounded request, one direct LLM call, no child Session, review-only proposal, and stale-family rejection all pass.

- [ ] **Step 6: Commit Fast mode**

```bash
git add packages/context/contextify/src/fast-recommendation.ts packages/context/contextify/tests/fast-recommendation.spec.ts packages/context/contextify/src/index.ts packages/context/contextify/tests/service.spec.ts
git commit -m "feat(context-map): add fast candidate routing"
```

### Task 3: Implement the private full-tree snapshot lifecycle

**Files:**
- Create: `packages/context/contextify/src/deep-recommendation.ts`
- Create: `packages/context/contextify/tests/deep-recommendation.spec.ts`

- [ ] **Step 1: Write failing snapshot and cleanup tests**

Test that the JSONL snapshot contains one metadata line followed by one record for every visible user input/final assistant output, full untruncated text, incoming/outgoing IDs, native Session IDs, effective inclusion, explicit mode, and replacement/archive state. Confirm reasoning/tool/system events never enter the projection.

Test `withDeepSnapshot()` on success, callback failure, cancellation, and stale cleanup. In every case, the temporary directory must no longer exist after settlement. Create an old `dsh-contextify-*` directory and a fresh one, run startup cleanup, and assert only the old directory is removed.

- [ ] **Step 2: Run the new test and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/deep-recommendation.spec.ts
```

Expected: module-not-found failure for `deep-recommendation.ts`.

- [ ] **Step 3: Implement the JSONL projection**

Use these stable internal records:

```text
export interface DeepRecommendationSnapshot {
  readonly version: 1
  readonly rootSessionId: string
  readonly activeSessionId: string
  readonly graphRevision: string
  readonly planRevision: number
  readonly objective: string
  readonly nodes: readonly DeepRecommendationNode[]
}

export interface DeepRecommendationNode {
  readonly kind: 'node'
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly ownerSessionId: string
  readonly sessionIds: readonly string[]
  readonly activePath: boolean
  readonly included: boolean
  readonly explicitMode: 'natural' | 'include' | 'exclude'
  readonly archived: boolean
  readonly incoming: readonly string[]
  readonly outgoing: readonly string[]
}
```

Serialize the metadata record first and one node per later line. JSONL is private implementation data and receives no package export beyond testable pure builders.

- [ ] **Step 4: Implement private temporary-file ownership**

Use `mkdtemp(join(tmpdir(), 'dsh-contextify-'))`, `writeFile(path, body, { mode: 0o600 })`, and `chmod(directory, 0o700)`. `withDeepSnapshot(snapshot, signal, operation)` must check cancellation before and after writing, call `operation({ directory, filePath })`, and always execute `rm(directory, { recursive: true, force: true })` in `finally`.

Export `cleanupStaleDeepSnapshots({ now, retentionMs })`, scoped only to directory names beginning `dsh-contextify-`; reject non-positive retention. The production retention is seven days:

```text
export const DEEP_RECOMMENDATION_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
```

- [ ] **Step 5: Verify snapshot tests GREEN**

Run the focused test. Expected: projection, permissions where POSIX supports them, every cleanup path, and TTL cleanup pass.

- [ ] **Step 6: Commit the snapshot lifecycle**

```bash
git add packages/context/contextify/src/deep-recommendation.ts packages/context/contextify/tests/deep-recommendation.spec.ts
git commit -m "feat(context-map): add deep snapshot lifecycle"
```

### Task 4: Run Deep analysis in one restricted Harness child

**Files:**
- Modify: `packages/context/contextify/src/deep-recommendation.ts`
- Modify: `packages/context/contextify/tests/deep-recommendation.spec.ts`
- Modify: `packages/context/contextify/package.json`

- [ ] **Step 1: Write failing scoped-child tests**

Mount the real Agent loop testkit with mock LLM, `read`, and `grep`. Script the child to read the JSONL file, grep a node term, and call `submit_context_recommendation`. Assert its cwd is the temporary directory, its visible tools are exactly `read`, `grep`, and `submit_context_recommendation`, and the captured result matches the shared decision shape.

Script attempts to read the Workspace, use `grep` on the directory rather than the exact file, and use `../` traversal. Assert the scoped guard denies each request before filesystem execution. Also cover timeout, cancellation, missing structured submission, and child disposal.

- [ ] **Step 2: Run the scoped-child test and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/deep-recommendation.spec.ts -t "child|path|cancel|timeout"
```

Expected: failures because the runner and guard are absent.

- [ ] **Step 3: Add an exact-path monotonic tool guard**

Implement and unit-test:

```text
export function deepSnapshotGuard(filePath: string): ToolGuard {
  const exact = resolve(filePath)
  return (execution) => {
    if (execution.name !== 'read' && execution.name !== 'grep') return undefined
    const args = execution.arguments as Record<string, unknown>
    const requested = execution.name === 'read' ? args.file_path : args.path
    if (typeof requested !== 'string' || resolve(requested) !== exact) {
      return 'Deep Context review may access only its frozen Context Tree snapshot'
    }
    return undefined
  }
}
```

The guard compares canonical absolute lexical paths after the snapshot directory has been created; the file is newly created and contains no symlink. `grep` must receive the exact file path, not the directory.

- [ ] **Step 4: Create the one-shot child inside the protected creation window**

Use `agent.ctx.agents.create()` rather than starting a generic subagent and adding a guard after publication. Set `meta.cwd` to the temporary directory, `meta.origin` to `subagent`, and `meta.parentSession` to the reviewed Session. Resolve provider/model/maxTokens from the reviewed agent.

Inside `setup(childCtx)` before publication:

```text
applyChildComposition(childCtx, parent, {
  persona: deepPersona,
  toolFilter: { allow: ['read', 'grep'] },
})
childCtx.tools.guard(deepSnapshotGuard(filePath))
childCtx.tools.register(createRecommendationSubmissionTool(capture))
childCtx.systemPrompt.section({
  name: 'contextify:deep-review',
  order: 130,
  text: deepReviewInstructions,
})
```

Before publication append `sandbox/mode` with `{ mode: 'read-only', source: 'delegation' }` and append `approval/policy` with `{ policy: 'never', source: 'delegation' }` when approval support exists. The submission tool validates the three arrays, captures one value only, calls `exec.concludeTurn()`, and returns `{ accepted: true }`.

- [ ] **Step 5: Bound and dispose the child**

Use one `AbortController` combined with the caller signal and `DEEP_RECOMMENDATION_TIMEOUT_MS = 45_000`. Set `maxTokens: 1_200`. Follow up exactly one user message naming the absolute snapshot path and instructing the child to inspect current included nodes, search remaining nodes, and submit one result. Await idle, require one captured submission and a completed Turn, then dispose the child handle in `finally` before `withDeepSnapshot()` removes the directory.

- [ ] **Step 6: Verify the real restricted child GREEN**

Run the focused child tests. Expected: read/grep/submit succeeds, every other tool is absent, path escape is denied, timeout/cancellation settle, and both agent and temporary directory disappear.

- [ ] **Step 7: Commit the Deep runner**

```bash
git add packages/context/contextify/src/deep-recommendation.ts packages/context/contextify/tests/deep-recommendation.spec.ts packages/context/contextify/package.json pnpm-lock.yaml
git commit -m "feat(context-map): run deep review in a restricted child"
```

### Task 5: Orchestrate Fast/Deep, cancellation, revisions, and Remote compatibility

**Files:**
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`
- Modify generated Remote artifacts only through the repository's documented generation command if typecheck reports them stale.

- [ ] **Step 1: Write failing service tests**

Add cases for omitted mode defaulting to Fast, explicit Deep invoking the runner once, one recommendation per Session family, `cancelRecommendation()` aborting Deep without a proposal, stale plan and stale sibling revisions rejecting both modes, and startup TTL cleanup logging but not failing service construction.

```text
const proposal = await ctx.contextify.recommend(agent, base, undefined, 'deep')
expect(proposal.mode).toBe('deep')
expect(deepRunner).toHaveBeenCalledTimes(1)

const pending = ctx.contextify.recommend(agent, base, undefined, 'deep')
await ctx.contextify.cancelRecommendation(agent)
await expect(pending).rejects.toMatchObject({ code: 'CONTEXTIFY_RECOMMENDATION_CANCELLED' })
```

- [ ] **Step 2: Run service tests and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/service.spec.ts -t "recommend"
```

Expected: missing mode and cancellation APIs.

- [ ] **Step 3: Replace the running Set with owned operations**

Use one map keyed by the native family root, not merely active Session ID:

```text
interface RecommendationOperation {
  readonly mode: ContextRecommendationMode
  readonly controller: AbortController
}

private readonly recommendations = new Map<SessionId, RecommendationOperation>()
```

Load the family and resolve its root before reserving the operation. Recheck graph and plan revisions after either engine returns. Pass the effective selection and explicit plan lists to the shared validator. In `finally`, delete only when the stored operation is the same object.

- [ ] **Step 4: Add Remote mode and cancellation methods**

Keep old callers compatible by making the fourth `mode` argument optional and defaulting it to `fast`:

```text
@Remote('recommend')
async recommend(agent: Agent, base: ContextRecommendationBase, objective?: string,
  mode: ContextRecommendationMode = 'fast'): Promise<ContextRecommendationProposal>

@Remote('cancelRecommendation')
cancelRecommendation(agent: Agent): void
```

Cancellation is idempotent. It aborts only the operation owned by the active Session family; it never touches the main conversation agent.

- [ ] **Step 5: Verify service behavior GREEN**

Run the complete Contextify service suite. Expected: both modes, cancellation, concurrency, stale checks, and all pre-existing plan/archive/relocation tests pass.

- [ ] **Step 6: Commit orchestration**

```bash
git add packages/context/contextify/src/index.ts packages/context/contextify/src/types.ts packages/context/contextify/tests/service.spec.ts packages/context/contextify/lib 2>/dev/null || true
git commit -m "feat(context-map): orchestrate fast and deep reviews"
```

Do not stage unrelated generated files; inspect `git status --short` before committing.

### Task 6: Add manual Fast/Deep controls and shared review UX

**Files:**
- Modify: `packages/client/ui-contextify/src/client/controller.ts`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- Modify: `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextRecommendationReview.module.css`
- Test: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- Test: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **Step 1: Write failing controller and UI tests**

Assert `controller.recommend('fast')` is the default action, Deep is chosen only by a distinct manual menu item, the running state includes its mode, Deep exposes Cancel, Fast does not auto-escalate after failure, and both ready proposals use the same review sheet with a mode label. Assert a failed or cancelled Deep run leaves checkboxes and plan revision unchanged.

- [ ] **Step 2: Run client tests and verify RED**

```bash
pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

Expected: transport/state/actions have no mode or cancellation support.

- [ ] **Step 3: Make the controller mode-aware**

Change the transport and state contracts:

```text
recommend: (base: ContextRecommendationBase, objective: string | undefined,
  mode: ContextRecommendationMode) => Promise<ContextRecommendationProposal>
cancelRecommendation: () => Promise<void>

export type ContextRecommendationState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly mode: ContextRecommendationMode }
  | { readonly phase: 'ready'; readonly proposal: ContextRecommendationProposal }
  | { readonly phase: 'stale'; readonly proposal: ContextRecommendationProposal }
  | { readonly phase: 'error'; readonly mode: ContextRecommendationMode; readonly error: string }
```

`recommend(mode = 'fast', objective?)` forwards the mode. `cancelRecommendation()` only accepts a running Deep state, calls the Remote, and returns to idle. A late aborted promise must not overwrite a newer state; use an incrementing request token.

- [ ] **Step 4: Implement the compact manual selector**

Keep the primary `Recommend` button as Fast. Add an adjacent disclosure button labelled `Recommendation mode`; its opaque anchored menu contains `Fast review` and `Deep tree review`. Choosing either starts immediately and closes the menu. While Deep runs, replace the action label with `Inspecting tree…` and show `Cancel`; do not render tool transcripts or a modal progress overlay.

- [ ] **Step 5: Label the common Current/Proposed review**

Render `Fast review` or `Deep tree review` beside the review heading. Keep selection as one replacement diff and Archive as separate individually confirmed suggestions. Apply and Undo semantics remain identical.

- [ ] **Step 6: Verify UI GREEN**

Run both focused client suites. Expected: keyboard-accessible menu, manual-only Deep, cancel, common review, non-blocking failure, Apply, Archive, and Undo pass.

- [ ] **Step 7: Commit the client UX**

```bash
git add packages/client/ui-contextify/src/client packages/client/ui-contextify/tests
git commit -m "feat(context-map): expose fast and deep review controls"
```

### Task 7: Make Branch review lightweight, topology-aware, and concurrent

**Files:**
- Modify: `packages/context/contextify/src/branch-review.ts`
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/tests/branch-review.spec.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`
- Modify: `packages/context/contextify/tests/settings.spec.ts`

- [ ] **Step 1: Write failing Branch packet tests**

Build a root → child → grandchild family with siblings. Assert the packet contains the current local objective before the new input, ancestor objectives, the last three completed local Turns, depth, active branch count, and at most four sibling intents. It must contain the new input but never serialize the full graph or tool/reasoning events.

```text
const input = buildBranchReviewInput({ graph, candidateInput, contents })
expect(input.currentObjective).toBe('local observability design')
expect(input.ancestorObjectives).toEqual(['root product goal', 'parent architecture goal'])
expect(input.recentTurns).toHaveLength(3)
expect(input.branchDepth).toBe(2)
expect(input.siblingIntents.length).toBeLessThanOrEqual(4)
```

- [ ] **Step 2: Write failing concurrency and fail-silent tests**

Use separate gates for the main mock response and auxiliary classifier. Assert the Branch classifier starts after the accepted human `user/message` and before final `assistant/message`; no suggestion appears until completed `turn/end`. Classifier failure, malformed JSON, confidence below threshold, unsuccessful Turn, disabled setting, or later conversation activity must append either a durable null review for the same completed Turn or no visible suggestion, never surface an error.

- [ ] **Step 3: Run Branch tests and verify RED**

```bash
pnpm vitest run packages/context/contextify/tests/branch-review.spec.ts packages/context/contextify/tests/service.spec.ts -t "Branch|branch"
```

Expected: packet builder and pre-response scheduling assertions fail.

- [ ] **Step 4: Implement the bounded Branch packet**

Export constants `BRANCH_RECENT_TURNS = 3`, `BRANCH_SIBLING_INTENTS = 4`, `BRANCH_MAX_TEXT_CHARS = 800`, and `BRANCH_REVIEW_MAX_TOKENS = 200`. Derive objectives from the most recent human user message before the candidate on each relevant native Session path. Branch depth and family load raise the display threshold:

```text
export function branchSuggestionThreshold(depth: number, activeBranches: number): number {
  return Math.min(0.95, 0.80 + Math.min(depth, 3) * 0.03 + Math.min(activeBranches, 6) * 0.01)
}
```

- [ ] **Step 5: Start and finalize the classifier without blocking Chat**

On a human append `user/message` inside an open Turn, capture the family packet and start one direct LLM request immediately using the Session request route and lowest reasoning effort. Store `{ turn, inputSeq, baseRevision, controller, decisionPromise }` by Session.

On completed `turn/end`, obtain the exact first human input/final assistant output candidate, await the already-running decision outside the main loop, reject stale state, apply the dynamic threshold, and append `contextify/branch-review`. Abort and discard pending work on unsuccessful Turn, agent disposal, setting disablement, or a newer human input.

- [ ] **Step 6: Enable the feature for fresh profiles while preserving the dashboard toggle**

Change only `CONTEXTIFY_DEFAULT_SETTINGS.automaticBranchReview` to `true`. Persisted profiles remain authoritative. Update settings tests to prove fresh defaults are on and an explicit profile `false` disables every auxiliary request.

- [ ] **Step 7: Verify Branch GREEN**

Run the complete Branch and Contextify service/settings suites. Expected: bounded input, concurrent start, silent Keep fallback, dynamic threshold, exact Q&A relocation, and existing idempotency pass.

- [ ] **Step 8: Commit Branch improvements**

```bash
git add packages/context/contextify/src/branch-review.ts packages/context/contextify/src/index.ts packages/context/contextify/src/types.ts packages/context/contextify/tests/branch-review.spec.ts packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/settings.spec.ts
git commit -m "feat(context-map): route lightweight branch suggestions"
```

### Task 8: Update package documentation and assembled acceptance coverage

**Files:**
- Modify: `packages/context/contextify/README.md`
- Modify: `packages/context/contextify/README.zh.md`
- Modify: `packages/context/contextify/README.i18n.yaml`
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`
- Modify: `packages/client/ui-contextify/README.i18n.yaml`
- Modify: `apps/web/tests/contextify-map.e2e.ts`
- Modify or create snapshots only through the existing snapshot update workflow when behavior changes.

- [ ] **Step 1: Extend the assembled keyless replay**

The replay must click the primary Fast action, confirm no plan mutation before Apply, apply and Undo, choose Deep from the disclosure menu, observe `Inspecting tree…`, cancel once, rerun Deep to a common review, and assert no temporary child Session or filesystem directory remains. It must also finish one off-topic Turn and verify the inline Branch card appears without covering the composer.

- [ ] **Step 2: Run the assembled test and verify RED, then GREEN**

```bash
pnpm vitest run apps/web/tests/contextify-map.e2e.ts
```

Expected before fixture updates: mode-control assertions fail. Expected after fixture/interaction updates: the keyless assembled replay passes.

- [ ] **Step 3: Document behavior and ownership in both languages**

Document that Fast is the default bounded review, Deep is explicit and temporary, both are inert until Apply, Archive remains per-node confirmation, prompt customization is shared, explicit pins/blocks win, and Branch review is a lightweight independent classifier. Do not document JSONL as a stable public format.

- [ ] **Step 4: Record translation pairings**

```bash
pnpm run verify-translation-pairing --write packages/context/contextify/README.md
pnpm run verify-translation-pairing --write packages/client/ui-contextify/README.md
pnpm run verify-translation-pairing packages/context/contextify/README.md
pnpm run verify-translation-pairing packages/client/ui-contextify/README.md
```

Expected: both named pairs are consistent.

- [ ] **Step 5: Commit documentation and replay**

```bash
git add packages/context/contextify/README.md packages/context/contextify/README.zh.md packages/context/contextify/README.i18n.yaml packages/client/ui-contextify/README.md packages/client/ui-contextify/README.zh.md packages/client/ui-contextify/README.i18n.yaml apps/web/tests/contextify-map.e2e.ts apps/web/tests/snapshots
git commit -m "docs(context-map): explain dual-mode reviews"
```

### Task 9: Release verification and final commit audit

**Files:**
- Inspect every file changed by Tasks 1–8.
- Do not edit unrelated user changes.

- [ ] **Step 1: Run focused package tests**

```bash
pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts packages/context/contextify/tests/fast-recommendation.spec.ts packages/context/contextify/tests/deep-recommendation.spec.ts packages/context/contextify/tests/branch-review.spec.ts packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/settings.spec.ts
pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx packages/client/ui-contextify/tests/branch-suggestion.client.spec.tsx
```

Expected: zero failures.

- [ ] **Step 2: Run static and documentation gates**

```bash
pnpm eslint packages/context/contextify/src packages/context/contextify/tests packages/client/ui-contextify/src packages/client/ui-contextify/tests apps/web/tests/contextify-map.e2e.ts
pnpm typecheck
pnpm run verify-agent-note-format
pnpm run verify-translation-pairing
pnpm run verify-md-wrap
git diff --check
```

Expected: zero lint, type, documentation, pairing, or whitespace failures. Use the repository-compatible Node version declared by `package.json` for every command and commit hook.

- [ ] **Step 3: Run the assembled Web replay**

```bash
pnpm vitest run apps/web/tests/contextify-map.e2e.ts
```

Expected: Fast, Deep, cancel, Apply/Undo, Archive review, and Branch suggestion flows pass without a model key.

- [ ] **Step 4: Manually verify the running product**

Open `http://127.0.0.1:3080/`, create a native Session branch family, and verify:

1. Recommend immediately runs Fast and returns without a modal error.
2. Deep tree review is a deliberate menu action and can be cancelled.
3. Neither mode changes a checkbox until Apply.
4. Apply creates one plan revision and Undo restores the previous version.
5. Explicit Include/Exclude choices are not reversed by either proposal.
6. Deep cannot read a Workspace path and leaves no temporary Session or directory.
7. An off-topic successful Q&A may show one inline Branch suggestion; Keep/failure is silent.
8. Accepting Branch relocates only the exact input and final output through native Session forking.

- [ ] **Step 5: Audit commits and worktree**

```bash
git status --short
git log --oneline -10
git diff HEAD~8 --stat
```

Expected: only planned files are changed, all work is committed, and unrelated pre-existing changes are untouched.

## Self-review record

- Spec coverage: Fast default/manual behavior is Tasks 2 and 6; Deep temporary file, exact-path tools, structured result, cancellation, cleanup, and stale checks are Tasks 3–6; shared prompt/validator and review-only Apply are Tasks 1, 5, and 6; lightweight Branch input, concurrent execution, fail-silent behavior, and native relocation are Task 7; documentation and assembled proof are Tasks 8–9.
- Type consistency: the plan uses one `ContextRecommendationMode`, one mode-bearing `ContextRecommendationProposal`, one three-list decision, and the same `ContextRecommendationBase` across package, Remote, controller, and client.
- Scope: no permanent Context Tree tool or public snapshot format is introduced; Deep does not become automatic; Branch receives no Deep mode; model output never directly mutates selection, archive, or Session topology.

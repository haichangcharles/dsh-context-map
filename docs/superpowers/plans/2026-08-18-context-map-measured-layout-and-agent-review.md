# Context Map Measured Layout and Agent Review Implementation Plan

English | [中文](2026-08-18-context-map-measured-layout-and-agent-review.zh.md)

> **For the implementing agent:** Execute tasks in order and use red-green TDD for every task. Recommendations must never mutate a Context Plan by themselves, and native Harness Session events must never be deleted or rewritten.

**Goal:** Fix overlap between variable-height message nodes and add two human-reviewed capabilities on the native DeepSeek Harness Agent loop: Include/Exclude recommendations execute only after approval; cleanup recommendations only identify candidates, and an individually confirmed candidate becomes a recoverable placeholder while preserving the native node, edges, fork point, and Session lineage.

**Architecture:** React Flow first renders an estimated Dagre layout, then feeds measured node bounds back into Dagre. Recommendation analysis runs in an isolated one-shot `spawn` subagent using the current Agent's provider/model route, Harness loop, and `structured_output`; it never enters the current chat Session. Proposals are ephemeral. Approved selection delegates to existing `setNodeModes()`. Confirmed cleanup appends a local `context/compiler-snapshot` and a Context Plan v3 replacement. Original messages remain append-only Session facts.

**Stack:** TypeScript 6, Cordis, Harness Agent/Subagent, Typert Remote, append-only Session, Context Compiler, React 18, React Flow, Dagre, Vitest, Testing Library, Playwright.

---

## 1. Fixed product contracts

1. The Map continues to show only the initial user input and final assistant output of each Turn. Reasoning, tools, results, and intermediate assistant steps remain hidden.
2. The Map continues to project native Session fork families; no second branch/session model is introduced.
3. Include/Exclude recommendations may be accepted individually or as a reviewed batch and execute only after approval.
4. Cleanup recommendations never auto-execute and have no “apply all cleanup” path.
5. Cleanup is semantic replacement. The same `nodeId`, edges, fork anchor, and Locate target remain; only the model-visible content is replaced.
6. A placeholder retains the original user/assistant role. The original is viewable and recoverable through Restore, Undo/Redo, and Clear manual changes.
7. Replacements and selection overrides belong to the active Session's Context Plan. A newly forked Session starts Natural, matching existing behavior.
8. Polling, remeasurement, and proposal state changes never take viewport ownership.
9. Manual node positions remain user-owned and may overlap intentionally. Automatic non-overlap applies to nodes without position overrides; Re-layout clears overrides.
10. Automatic branch routing, main-line promotion, cross-map recommendations, and physical Session-history deletion are out of scope.

## 2. Chosen approaches

### Layout

Use measured bounds with Dagre. Increasing a fixed `ranksep` cannot solve an unbounded card-height mismatch, while a new custom tree walker would duplicate Dagre's family-graph handling.

```text
parentBottom = parent.position.y + parent.height
childTop = child.position.y
childTop - parentBottom >= CONTEXT_MAP_RANK_GAP

leftRightGap(a, b) >= CONTEXT_MAP_NODE_GAP
```

### Recommendation execution

Use `ctx.subagents.start('spawn', ...)`, not the current Agent's next turn and not a provider-specific SDK. Pass `toolFilter: { allow: [] }`: inherited global tools disappear, while the child-scoped `structured_output` tool remains available.

### Cleanup

Use a same-ID Context Plan replacement overlay. Reuse the standalone Context Map's impact-preview ideas, not its graph-rewriting store algorithm; Harness Session logs and lineage remain the topology authority.

## 3. End-to-end data flow

```text
React Flow 首帧
  -> 224x116 估算 Dagre 布局
  -> onNodesChange(dimensions)
  -> measuredSizes[nodeId]
  -> 真实尺寸 Dagre 布局
  -> 只更新节点坐标，不 fitView

Recommend
  -> Contextify Remote 校验 live + idle + planRevision + graphAsOfSeq
  -> 读取原生 family 和精确消息
  -> 构造有界、只读的 graph snapshot
  -> Harness spawn subagent + structured_output schema
  -> 校验 nodeId/action/重复项
  -> 返回临时 proposal
  -> UI 标注建议，但 Context Plan 不变

Accept Include/Exclude
  -> proposal 映射成 ContextNodeMutation[]
  -> 已有 setNodeModes(ref, mutations)
  -> 一个新 Context Plan revision

Confirm cleanup candidate
  -> replaceNode(ref, owner, placeholderText, reason)
  -> append context/compiler-snapshot
  -> append Context Plan v3 replacement
  -> compileContextify 用 snapshot seq 替换原 event/include snapshot seq
  -> family graph 仍使用原 nodeId 和原边，只改变显示状态
```

## 4. Required core shapes and pseudocode

### Measured layout

```text
interface ContextMapNodeSize {
  readonly width: number
  readonly height: number
}

type ContextMapNodeSizes = Readonly<Record<string, ContextMapNodeSize>>

function normalizedSize(change): ContextMapNodeSize | undefined {
  if dimensions missing or width <= 0 or height <= 0: return undefined
  return {
    width: roundToHalfPixel(width),
    height: roundToHalfPixel(height),
  }
}

function reduceMeasuredSizes(current, changes): ContextMapNodeSizes {
  next = current
  for each dimensions change:
    size = normalizedSize(change)
    if size is undefined: continue
    if abs(old.width-size.width) < 1 and abs(old.height-size.height) < 1: continue
    lazily clone current, then next[change.id] = size
  return next
}
```

```text
function sizeFor(id, sizes) {
  return sizes[id] ?? { width: 224, height: 116 }
}

for record in records:
  graph.setNode(record.id, sizeFor(record.id, sizes))

dagre.layout(graph)

return records.map(record => {
  size = sizeFor(record.id, sizes)
  center = graph.node(record.id)
  return {
    ...reactFlowNode(record),
    position: {
      x: center.x - size.width / 2,
      y: center.y - size.height / 2,
    },
  }
})
```

### Recommendation proposal

```text
interface ContextRecommendationBase {
  readonly planRevision: number
  readonly graphAsOfSeq: number
  readonly activeSessionId: SessionId
}

interface ContextSelectionRecommendation {
  readonly nodeId: string
  readonly action: 'include' | 'exclude'
  readonly reason: string
  readonly confidence: 'high' | 'medium' | 'low'
}

interface ContextCleanupCandidate {
  readonly nodeId: string
  readonly category: 'obsolete' | 'conflict' | 'redundant'
  readonly reason: string
  readonly evidenceNodeIds: readonly string[]
  readonly placeholderText: string
}

interface ContextRecommendationProposal {
  readonly base: ContextRecommendationBase
  readonly selection: readonly ContextSelectionRecommendation[]
  readonly cleanup: readonly ContextCleanupCandidate[]
}
```

The output schema contains no mutation or execute field. Host validation rejects unknown IDs, duplicate/conflicting actions, invalid evidence, empty/oversized text, and recommendations that do not change the effective state.

### Context Plan v3 replacement

```text
interface ContextReplacementNode {
  readonly nodeId: string
  readonly snapshotSeq: number
  readonly originalEventSeq: number | null
  readonly role: 'user' | 'assistant'
  readonly kind: 'placeholder'
  readonly reason: string
}

interface ContextPlanStateV3 {
  readonly excluded: readonly ContextExcludedNode[]
  readonly included: readonly ContextIncludedNode[]
  readonly replacements: readonly ContextReplacementNode[]
}
```

```text
selected = naturalSurfaceMinusExcludedAndToolGroups()
protectCurrentTurn(selected)

eventSeqs = selected.map(seq => {
  replacement = replacements.find(item => item.originalEventSeq === seq)
  return replacement?.snapshotSeq ?? seq
})

for included ordered by position:
  replacement = replacementByNodeId.get(included.nodeId)
  seq = replacement?.snapshotSeq ?? included.snapshotSeq
  insertAtStablePosition(eventSeqs, seq, included.position)

assert no duplicate seq
messages = eventSeqs.map(selectedMessage)
```

Replacement is independent of Include/Exclude. Restore removes only replacement. Reset clears all three override collections.

---

## 5. Executable tasks

### Task 1: Reproduce variable-height overlap in pure layout tests

**Files:**
- Create: `packages/client/ui-contextify/tests/{layout.client.spec.ts}`
- Modify: `packages/client/ui-contextify/src/client/layout.ts`

- [ ] Add RED cases for a 340px parent, a 340px child, and different-width siblings. Assert bounding-box gaps, not center distances.
- [ ] Run the RED check. Expect the fourth layout argument to be missing or the tall-parent gap to be negative.

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/{layout.client.spec.ts}
```

- [ ] Export rank/node gap constants and accept `ContextMapNodeSizes`. Register each Dagre node with its own bounds and subtract its own half-size from the returned center.
- [ ] Prove deterministic repeated calls and GREEN geometry.
- [ ] Commit.

```bash
git add packages/client/ui-contextify/src/client/layout.ts packages/client/ui-contextify/tests/{layout.client.spec.ts}
git commit -m "fix(context-map): lay out measured message bounds"
```

### Task 2: Feed React Flow dimensions into layout without taking viewport ownership

**Files:**
- Create: `packages/client/ui-contextify/src/client/{layout-measurements.ts}`
- Create: `packages/client/ui-contextify/tests/{layout-measurements.client.spec.ts}`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] RED-test invalid bounds, half-pixel normalization, 1px epsilon, identity preservation, and removed-node cleanup.
- [ ] Extend the React Flow test seam to expose current nodes and emit dimensions.
- [ ] RED-test a 340px parent followed by a 116px child, no repeated publication for equal measurements, and no `fitView` after an equivalent polling refresh.
- [ ] Store measured sizes in the panel; reconcile removed IDs; pass sizes to `layoutContextMap`; apply transient/persisted manual positions last.
- [ ] Debounce initial fit until the measurement signature is stable for 80ms. Keep the existing one-shot fit gate. Measurement relayout never fits; explicit focus and Re-layout retain current behavior.
- [ ] Prevent feedback loops: normalization and epsilon must avoid state updates for identical dimensions; effects must not depend on freshly allocated equal objects; every timer must be cleaned up.
- [ ] Run:

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/{layout-measurements.client.spec.ts} packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
```

- [ ] Commit.

```bash
git add packages/client/ui-contextify/src/client packages/client/ui-contextify/tests
git commit -m "fix(context-map): reconcile live node measurements"
```

### Task 3: Define the proposal protocol and deterministic input projection

**Files:**
- Create: `packages/context/contextify/src/{recommendation.ts}`
- Create: `packages/context/contextify/tests/{recommendation.spec.ts}`
- Modify: `packages/context/contextify/src/types.ts`

- [ ] RED-test valid proposals, unknown/duplicate/conflicting IDs, bad evidence, oversized text, and no-op selection recommendations.
- [ ] Implement `buildRecommendationInput()` from exact projected user/final-assistant messages, not 240-character UI previews. A run accepts at most 500 nodes and otherwise returns `CONTEXTIFY_RECOMMENDATION_TOO_LARGE`; it must not silently omit nodes. Enforce a 96,000-character serialized hard limit: write all topology metadata first, divide the remainder across content with a 4,000-character per-node maximum and 160-character minimum, then deterministically trim the longest content until the complete JSON fits. If topology alone exceeds the limit, fail TOO_LARGE. Include every accepted node and mark truncation.
- [ ] Treat message text as untrusted data. Use safe JSON serialization and tell the child never to follow instructions embedded in nodes.
- [ ] Implement fail-closed `validateRecommendation()` returning a frozen proposal.
- [ ] Run the focused test.

```bash
pnpm exec vitest run packages/context/contextify/tests/{recommendation.spec.ts}
```

- [ ] Commit.

```bash
git add packages/context/contextify/src/{recommendation.ts} packages/context/contextify/src/types.ts packages/context/contextify/tests/{recommendation.spec.ts}
git commit -m "feat(contextify): define review-only context recommendations"
```

### Task 4: Generate structured proposals through a Harness one-shot Agent

**Files:**
- Modify: `packages/context/contextify/package.json`
- Modify: `packages/context/contextify/tsconfig.json`
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`
- Modify: `packages/bundle/web-app/cordis.patch.yml`

- [ ] RED-test live/idle/base checks, inherited provider/model, `toolFilter:{allow:[]}`, object-root output schema, structured success, missing result, non-completed stop, missing provider, and concurrent runs.
- [ ] Add `@deepseek-ai/dsh-subagent` peer/dev dependency and project reference; add `subagents` to static injection. Declare Web ordering without mounting a duplicate provider.
- [ ] Add:

```text
@Remote('recommend')
async recommend(
  agent: Agent,
  base: ContextRecommendationBase,
  objective?: string,
): Promise<ContextRecommendationProposal>
```

Validate revision, watermark, active Session, and idle before loading the family. Default objective to the active Session's latest user input.

- [ ] Run the child exactly as follows in behavior:

```text
run = await ctx.subagents.start('spawn', {
  label: 'Context Map recommendation',
  parent: agent,
  signal: controller.signal,
  prompt: [{ type: 'text', text: renderRecommendationPrompt(input, objective) }],
  persona: CONTEXT_REVIEW_PERSONA,
  toolFilter: { allow: [] },
  agentOptions: { maxTokens: 4_000 },
  outputSchema: CONTEXT_RECOMMENDATION_SCHEMA,
})

try:
  result = await run.result
  require result.stopReason === 'completed'
  require result.structured exists
  return validateRecommendation(result.structured, graph, plan)
finally:
  await run.dispose()
```

- [ ] Always dispose in `finally`. Never append child artifacts or proposals to the parent Session. Add stable stale/busy/unavailable/too-large/invalid recommendation error codes.

- [ ] Run:

```bash
pnpm exec vitest run packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/{recommendation.spec.ts}
pnpm run build:lib:host
```

- [ ] Commit.

```bash
git add packages/context/contextify packages/bundle/web-app/cordis.patch.yml
git commit -m "feat(contextify): run isolated recommendation agents"
```

### Task 5: Add an ephemeral proposal state machine to the client controller

**Files:**
- Modify: `packages/client/ui-contextify/src/client/controller.ts`
- Modify: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] RED-test idle/running/ready/error/clear and staleness when revision, watermark, or active Session changes. Equivalent polling preserves the proposal.
- [ ] Add transport methods for recommend, replace, and restore. Keep proposals memory-only and controller-local.
- [ ] Accept selected Include/Exclude items by resolving current graph owners and calling existing `setNodeModes()` once.
- [ ] Expose only an individually confirmed cleanup call; no batch-cleanup method.
- [ ] Run the focused client test and commit.

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
git add packages/client/ui-contextify/src/client/controller.ts packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
git commit -m "feat(context-map): manage ephemeral agent proposals"
```

### Task 6: Build proposal review UI without changing checkbox meaning

**Files:**
- Create: `packages/client/ui-contextify/src/client/{ContextRecommendationReview.tsx}`
- Create: `packages/client/ui-contextify/src/client/{ContextRecommendationReview.module.css}`
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] RED-test loading, badges, reasons, individual/batched selection approval, dismiss, stale UI, no pre-approval mutation, and cleanup actions with no “apply all”.
- [ ] Add a Recommend toolbar action and a review sheet over the canvas bottom so the graph stays visible.
- [ ] Render suggestion badges without changing the current effective checkbox state.
- [ ] Allow reviewed selection items to call Apply selected. State clearly that this changes next-turn context.
- [ ] For cleanup, show category, evidence, deterministic in/out degree, branch-pivot status, affected Sessions, editable placeholder, and before/after preview.
- [ ] Add stable accessible names, alert errors, keyboard access, and focus restoration.
- [ ] Run panel/browser tests.

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

- [ ] Commit.

```bash
git add packages/client/ui-contextify/src/client packages/client/ui-contextify/tests
git commit -m "feat(context-map): review context recommendations in canvas"
```

### Task 7: Upgrade to Context Plan v3 and implement recoverable replacements

**Files:**
- Modify: `packages/context/contextify/src/types.ts`
- Modify: `packages/context/contextify/src/plan.ts`
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/tests/compiler.spec.ts`
- Modify: `packages/context/contextify/tests/service.spec.ts`

- [ ] RED-test v2 normalization preserving revisions/history/selection without writing during read; the next mutation writes v3.
- [ ] RED-test active user/assistant replacement, off-path include replacement, exclusion, restore, reset, undo/redo, deduplication, and current-turn protection.
- [ ] Normalize both current and historical v2 snapshots to v3 with `replacements: []`.
- [ ] Extend all plan freeze/assert/next/reset/history helpers with replacement validation and uniqueness.
- [ ] Substitute replacement snapshot sequences during compilation; keep the generic Context Compiler registry unchanged.
- [ ] Add `replaceNode`: validate live/idle/CAS/family/text, append a role-preserving compiler snapshot with `contextify-placeholder` provenance, then append the v3 plan. Replacing again points a new revision at a new append-only snapshot.
- [ ] Add `restoreNode`: remove replacement only, retain selection overrides, and reject a missing replacement.
- [ ] Decorate `familyPage()` records with optional replacement view data without changing the pure native topology projection.
- [ ] Run contextify compiler/service/family tests.

```bash
pnpm exec vitest run packages/context/contextify/tests/compiler.spec.ts packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/family.spec.ts
```

- [ ] Commit.

```bash
git add packages/context/contextify
git commit -m "feat(contextify): replace message semantics with placeholders"
```

### Task 8: Render and restore same-ID placeholders

**Files:**
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] RED-test unchanged node ID/count/edges, placeholder text, preserved checkbox/Branch/Locate, and Show original/Restore original menu items.
- [ ] Render replacement content on the same graph node with an “Original retained” status. Show original is read-only.
- [ ] Wire restore, Undo/Redo, and Clear manual changes.
- [ ] Confirm the shorter placeholder triggers measured relayout without fitting or looping.
- [ ] Run the panel test and commit.

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git add packages/client/ui-contextify
git commit -m "feat(context-map): render reversible cleanup placeholders"
```

### Task 9: E2E, regression, documentation, and release gates

**Files:**
- Modify: `apps/web/tests/contextify-map.e2e.ts`
- Modify: `packages/context/contextify/README.md`
- Modify: `packages/context/contextify/README.zh.md`
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`
- Modify: `packages/client/ui-contextify/FUTURE_WORK.md`
- Modify: `packages/client/ui-contextify/FUTURE_WORK.zh.md`

- [ ] Add keyless E2E proving proposal generation alone changes nothing; selection approval changes the next model request; unconfirmed cleanup changes nothing; confirmation inserts a placeholder; restore returns the original.
- [ ] Add a long-node geometry E2E with at least 600 assistant characters and a short child. Assert measured bounding-box gap with 1px browser tolerance and stable transform across two polls.
- [ ] Regress Branch, Locate, archive projection, and Natural state in a newly forked Session.
- [ ] Document measured layout, review-only Agent behavior, Session isolation, replacement overlay, append-only original history, reset, and undo/redo in both README languages.
- [ ] Mark selection/pruning recommendations complete in both FUTURE_WORK documents while branch recommendation remains future work.
- [ ] Run:

```bash
pnpm exec vitest run packages/context/contextify/tests packages/client/ui-contextify/tests
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts
```

- [ ] Run build and documentation gates under Node 22.

```bash
export PATH="/Users/haichangli/.nvm/versions/node/v22.23.2/bin:$PATH"
hash -r
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run verify-translation-pairing --write packages/context/contextify/README.md
pnpm run verify-translation-pairing --write packages/client/ui-contextify/README.md
pnpm run verify-translation-pairing --write packages/client/ui-contextify/FUTURE_WORK.md
git diff --check
```

- [ ] Manually verify long cards, live drag, stable viewport, proposal-only badges, approved selection, per-item cleanup confirmation, unchanged topology, Show/Restore, Undo/Redo, and Clear manual changes at `http://127.0.0.1:3080/`.
- [ ] Commit remaining E2E/docs only after every check passes.

```bash
git add apps/web/tests/contextify-map.e2e.ts packages/context/contextify/{README.md,README.zh.md} packages/client/ui-contextify/{README.md,README.zh.md} packages/client/ui-contextify/{FUTURE_WORK.md,FUTURE_WORK.zh.md}
git commit -m "test(context-map): verify agent-reviewed context editing"
```

## 6. Required conflict/failure cases

| Case | Required behavior |
|---|---|
| User continues chatting during recommendation | Idle/watermark validation fails; nothing executes |
| Equivalent polling after a proposal | Proposal and viewport remain |
| Manual checkbox change before accepting an old proposal | CAS rejects and marks proposal stale |
| Model returns unknown IDs | Reject the complete proposal |
| Model asks to auto-delete | Schema has no execution field/path |
| Cleanup of a branch pivot | Same-ID replacement; edges and `branchAtSeq` stay unchanged; impact UI warns |
| Cleanup of an off-path node | Placeholder is visible but not compiled until included |
| Cleanup of an included node | Include remains; compilation selects the placeholder snapshot |
| Cleanup of an excluded node | Exclude remains; restoring the original still leaves it excluded |
| Replace a replacement | New snapshot wins; old snapshot remains unselected in append-only history |
| Reset | Clear selection and replacements; Undo can restore |
| New fork | Native fork succeeds; child is Natural with no inherited replacement |
| Archive a Session that owns a replacement | Existing unarchived-family projection hides/rebinds it without dangling or unlocatable ghost nodes |
| Font load changes height | Measured relayout without fit or feedback loop |
| Manual drag causes overlap | Preserve override until Re-layout |

## 7. Definition of done

- Measured automatic parent/child cards keep the configured rank gap between actual bottom/top bounds.
- Measurement produces no feedback loop and preserves the prior viewport-stability fix.
- Recommendation uses a real isolated Harness one-shot Agent and inherits provider/model without adding a recommendation Turn to the current Session.
- Proposals do not change model input; approved selection creates one atomic plan revision.
- Cleanup has no automatic batch path and preserves node IDs, edges, forks, and original history.
- Placeholder content is actually compiled and is recoverable through Restore, Reset, Undo, and Redo.
- Persisted v2 plans and their history remain readable; new mutations write v3.
- Focused unit/client/E2E tests, typecheck, lint, doc-sync, and `git diff --check` all pass.

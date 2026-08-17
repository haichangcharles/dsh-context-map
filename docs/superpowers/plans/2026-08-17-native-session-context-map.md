# Native Session Context Map Implementation Plan

English | [中文](2026-08-17-native-session-context-map.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Contextify's same-Session virtual branches with a real graph of native Session forks and let Chat and Context Map control one durable message-level Context Plan.

**Architecture:** `@deepseek-ai/dsh-contextify` projects a Session family from persistence inspections and stores only revisioned context choices in the active Session. Cross-branch messages become local `context/compiler-snapshot` events before the Context Plan selects them. The browser ports the independent Context Map's React Flow and Dagre interaction model while native Session services remain responsible for fork, lineage, and navigation.

**Tech Stack:** TypeScript 6, Cordis services, Harness append-only Session events, Typert Remote, React 18, `@xyflow/react`, Dagre, CSS Modules, Vitest, Testing Library, Playwright.

---

## File structure

- `packages/context/context-compiler/src/index.ts`: generic durable compiler-snapshot event and validation.
- `packages/context/contextify/src/types.ts`: native family, canonical message, Context Plan, and Remote result types.
- `packages/context/contextify/src/family.ts`: pure lineage and canonical-message projection.
- `packages/context/contextify/src/plan.ts`: pure plan fold, mutation history, and compiler selection.
- `packages/context/contextify/src/index.ts`: Cordis service, persistence reads, Remote methods, compiler registration, and child reset.
- `packages/client/ui-workspace/src/client/tree.ts`: recursive Workspace/Session tree projection.
- `packages/client/ui-contextify/src/client/controller.ts`: apply-owned observable cache shared by graph and Chat actions.
- `packages/client/ui-contextify/src/client/store.ts`: graph-only viewing state.
- `packages/client/ui-contextify/src/client/ContextMapNode.tsx`: one message node renderer.
- `packages/client/ui-contextify/src/client/layout.ts`: Dagre tree, mind-map, and timeline placement.
- `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`: React Flow canvas and controls.
- `packages/client/ui-contextify/src/client/ContextMessageAction.tsx`: Chat-side Natural, Include, Exclude, and Locate action.
- `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`: native Branch action on finalized user messages.
- `apps/web/tests/contextify-map.e2e.ts`: replay-backed native-fork and model-input proof.

### Task 1: Durable compiler snapshot events

**Files:**
- Modify: `packages/context/context-compiler/src/index.ts`
- Modify: `packages/context/context-compiler/tests/registry.spec.ts`
- Modify: `packages/context/context-compiler/README.md`
- Modify: `packages/context/context-compiler/README.zh.md`

- [ ] **Step 1: Write the failing registry tests**

Add tests which append and select a local snapshot event, and reject a missing or duplicate selected event sequence:

```text
it('compiles a durable compiler snapshot without adding it to the Session surface', async () => {
  const ctx = new Context()
  await ctx.plugin(ContextCompilerRegistry)
  const session = Session.create(SessionId('snapshot-selection'))
  const snapshot = session.append('context/compiler-snapshot', {
    id: 'sibling:7',
    message: createUserMessage({
      content: [{ type: 'text', text: 'imported sibling fact' }],
      source: { kind: 'runtime-context', provenance: 'contextify:sibling:7' },
    }),
  })
  ctx.contextCompiler.register({
    id: 'snapshot-provider', version: 1,
    select: () => ({ eventSeqs: [snapshot.seq] }),
  })
  ctx.contextCompiler.select(session, 'snapshot-provider')

  expect(session.surface.nodes).toEqual([])
  expect(ctx.contextCompiler.compile({ session, turn: 1, step: 1 })).toMatchObject({
    eventSeqs: [snapshot.seq],
    messages: [{ content: [{ type: 'text', text: 'imported sibling fact' }] }],
  })
})
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/context/context-compiler/tests/registry.spec.ts`

Expected: TypeScript or runtime failure because `context/compiler-snapshot` is not registered and the registry rejects its event type.

- [ ] **Step 3: Add the event and exact resolver**

Add this declaration and resolve it in `compile()` beside the three surface message types:

```text
export interface ContextCompilerSnapshot {
  readonly id: string
  readonly message: Message
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Model-visible message copied into this Session for compiler selection. */
    'context/compiler-snapshot': ContextCompilerSnapshot
  }
}

function selectedMessage(session: Session, seq: number): Message {
  const event = session.events[seq]
  if (event === undefined) throw invalidSelection(`event seq ${String(seq)} does not exist`)
  if (event.type === 'context/compiler-snapshot') return event.data.message
  if (event.type !== 'user/message'
    && event.type !== 'assistant/message'
    && event.type !== 'tool/result') {
    throw invalidSelection(`event seq ${String(seq)} has non-message type "${event.type}"`)
  }
  const message = session.deriveEventMessage(event)
  if (message === null) throw invalidSelection(`event seq ${String(seq)} does not derive a message`)
  return message
}
```

Use `selectedMessage(request.session, seq)` in the existing compilation loop. Keep `eventSeqs` duplicate and bounds checks unchanged.

- [ ] **Step 4: Verify GREEN and documentation**

Run: `pnpm exec vitest run packages/context/context-compiler/tests/registry.spec.ts`

Expected: all registry tests pass. Update both READMEs to state that snapshot events are log-only, model-visible only when a compiler selects them, and never join `Session.surface`.

- [ ] **Step 5: Commit**

```bash
git add packages/context/context-compiler
git commit -m "feat: add durable context compiler snapshots"
```

### Task 2: Native Session family projection

**Files:**
- Create: `packages/context/contextify/src/family.ts`
- Modify: `packages/context/contextify/src/types.ts`
- Create: `packages/context/contextify/tests/family.spec.ts`

- [ ] **Step 1: Write failing projection tests**

Create fixtures for root, two children, one grandchild, and an empty child. Assert inherited messages share a node ID, local messages are child-owned, reasoning and tools create no nodes, and the two child edges leave the canonical fork message:

```text
const graph = projectSessionFamily({
  activeSessionId: childA.meta.id,
  sessions: [root, childA, childB, grandchild, emptyChild],
})

expect(graph.rootSessionId).toBe(root.meta.id)
expect(graph.nodes.map(node => node.preview)).toEqual([
  'root question', 'root answer', 'child A question', 'child B question', 'grandchild question',
])
expect(graph.nodes.filter(node => node.preview === 'root answer')).toHaveLength(1)
expect(graph.nodes.some(node => node.preview.includes('tool output'))).toBe(false)
expect(graph.edges.filter(edge => edge.source === graph.nodes[1]!.id)).toHaveLength(2)
expect(graph.sessions.find(item => item.id === emptyChild.meta.id)?.tipNodeId).toBe(graph.nodes[1]!.id)
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/context/contextify/tests/family.spec.ts`

Expected: import failure for the missing `family.ts` projection.

- [ ] **Step 3: Define native family types**

Replace `ContextPath`, `ContextRoute`, and `pathId` graph types with:

```text
export interface ContextMessageRef {
  readonly sessionId: SessionId
  readonly seq: number
}

export interface ContextFamilySession {
  readonly id: SessionId
  readonly parentSessionId?: SessionId
  readonly seedLength: number
  readonly depth: number
  readonly tipNodeId: string | null
}

export interface ContextGraphNode {
  readonly id: string
  readonly owner: ContextMessageRef
  readonly role: 'user' | 'assistant'
  readonly preview: string
  readonly time: number
  readonly sessionIds: readonly SessionId[]
  readonly activeEventSeq: number | null
}

export interface ContextGraphEdge {
  readonly id: string
  readonly source: string
  readonly target: string
  readonly sessionIds: readonly SessionId[]
}

export interface ContextFamilyGraph {
  readonly rootSessionId: SessionId
  readonly activeSessionId: SessionId
  readonly sessions: readonly ContextFamilySession[]
  readonly nodes: readonly ContextGraphNode[]
  readonly edges: readonly ContextGraphEdge[]
}
```

- [ ] **Step 4: Implement the pure projection**

Implement `projectSessionFamily({ activeSessionId, sessions })` over `SessionInspection[]` with these rules:

```text
const visible = (event: SessionEvent): event is SessionEvent<'user/message' | 'assistant/message'> =>
  (event.type === 'user/message' || event.type === 'assistant/message')
  && event.surfaceOp === 'append'
  && (event.type !== 'assistant/message' || event.data.message.content.length > 0)

const canonicalOwner = (
  inspection: SessionInspection,
  seq: number,
  byId: ReadonlyMap<SessionId, SessionInspection>,
): ContextMessageRef => {
  let cursor = inspection
  while (cursor.meta.parentSession !== undefined && seq < (cursor.meta.seedLength ?? 0)) {
    const parent = byId.get(cursor.meta.parentSession)
    if (parent === undefined) break
    cursor = parent
  }
  return { sessionId: cursor.meta.id, seq }
}
```

Walk each family Session in ancestor-first order, merge nodes by `${owner.sessionId}:${owner.seq}`, merge consecutive visible-message edges by source and target IDs, and record every Session that traverses each node or edge. Freeze the returned arrays and records.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm exec vitest run packages/context/contextify/tests/family.spec.ts`

```bash
git add packages/context/contextify/src/family.ts packages/context/contextify/src/types.ts packages/context/contextify/tests/family.spec.ts
git commit -m "feat: project native Session families"
```

### Task 3: Revisioned Context Plan and compiler

**Files:**
- Create: `packages/context/contextify/src/plan.ts`
- Modify: `packages/context/contextify/src/types.ts`
- Replace: `packages/context/contextify/tests/compiler.spec.ts`

- [ ] **Step 1: Write failing plan and compiler tests**

Cover Natural selection, current-path Exclude, sibling snapshot Include, current-turn protection, reset, undo, redo, and removal of every virtual path event:

```text
expect(compileContextify({ session: child, turn: 3, step: 1 }).eventSeqs)
  .toEqual([inheritedUserSeq, localUserSeq])

child.append('context/compiler-snapshot', {
  id: 'sibling:9', message: siblingMessage,
})
child.append('contextify/plan', planWith({
  revision: 2,
  excluded: [{ nodeId: inheritedNodeId, eventSeq: inheritedAssistantSeq }],
  included: [{ nodeId: siblingNodeId, snapshotSeq, position: 1 }],
}))

expect(compileContextify({ session: child, turn: 3, step: 1 }).eventSeqs)
  .toEqual([inheritedUserSeq, snapshotSeq, localUserSeq])
expect(child.events.some(event => event.type === 'contextify/route')).toBe(false)
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/context/contextify/tests/compiler.spec.ts`

Expected: failures because the current compiler still derives same-Session virtual paths and the new plan fields do not exist.

- [ ] **Step 3: Define the version-two plan**

```text
export interface ContextExcludedNode {
  readonly nodeId: string
  readonly eventSeq: number
}

export interface ContextIncludedNode {
  readonly nodeId: string
  readonly snapshotSeq: number
  readonly position: number
}

export interface ContextPlanSnapshot {
  readonly kind: 'contextify/plan'
  readonly version: 2
  readonly revision: number
  readonly stateRevision: number
  readonly history: { readonly past: readonly number[]; readonly future: readonly number[] }
  readonly excluded: readonly ContextExcludedNode[]
  readonly included: readonly ContextIncludedNode[]
}
```

`createInitialContextPlan()` returns revision and stateRevision `1`, empty history, and empty selections. Remove the `contextify/route` event declaration completely.

- [ ] **Step 4: Implement pure selection and history transitions**

`compileContextify()` starts from `session.surface.nodes`, removes excluded event sequences, inserts included snapshot sequences by ascending `position`, and then restores every surface message belonging to the current turn. Keep tool calls and results closed as one group. Export pure `nextPlan`, `undoPlan`, `redoPlan`, and `resetPlan` helpers; each returns a new full snapshot and never edits an earlier object.

The mutation helper uses this exact history update:

```text
export function nextPlan(current: ContextPlanSnapshot, state: ContextPlanState): ContextPlanSnapshot {
  const revision = current.revision + 1
  return freezePlan({
    kind: 'contextify/plan', version: 2, revision, stateRevision: revision,
    history: { past: [...current.history.past, current.stateRevision], future: [] },
    excluded: state.excluded,
    included: state.included,
  })
}
```

Undo and Redo resolve `stateRevision` from earlier `contextify/plan` events in the same Session and append a copied state with updated `past` and `future` arrays.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm exec vitest run packages/context/contextify/tests/compiler.spec.ts`

```bash
git add packages/context/contextify/src packages/context/contextify/tests/compiler.spec.ts
git commit -m "feat: compile revisioned native context plans"
```

### Task 4: Contextify service over persistence-backed Session families

**Files:**
- Modify: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/package.json`
- Modify: `packages/context/contextify/tsconfig.json`
- Replace: `packages/context/contextify/tests/service.spec.ts`
- Modify: `packages/context/contextify/src/invariant.ts`

- [ ] **Step 1: Write failing service tests**

Build a real `SessionStore`, Context Compiler registry, Agent registry, and fake `SessionPersistence` containing a root and two children. Assert `familyPage()` returns one de-duplicated family, Include appends snapshot then plan, cross-family Include appends nothing, stale revisions append nothing, and a new fork child resets inherited choices on `agent/session-start`.

```text
const before = active.session.seq
const included = await ctx.contextify.setNodeMode(
  active.agent,
  { revision: 1 },
  { sessionId: sibling.id, seq: siblingMessageSeq },
  'include',
)
expect(active.session.events.slice(before).map(event => event.type))
  .toEqual(['context/compiler-snapshot', 'contextify/plan'])
expect(included.plan.included).toMatchObject([{ snapshotSeq: before }])

await expect(ctx.contextify.setNodeMode(
  active.agent,
  { revision: included.plan.revision },
  { sessionId: unrelated.id, seq: 0 },
  'include',
)).rejects.toMatchObject({ code: 'CONTEXTIFY_CROSS_FAMILY' })
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/context/contextify/tests/service.spec.ts`

Expected: failures because the current service exposes virtual-path RPC methods and cannot inspect persisted siblings.

- [ ] **Step 3: Replace the service API**

Use `static inject = ['agents', 'sessions', 'sessionPersistence', 'contextCompiler']`. Replace `createBranch`, `selectPath`, and `returnToMainline` with:

```text
@Remote('get')
get(agent: Agent): ContextifyView

@Remote('familyPage')
async familyPage(agent: Agent, after?: number, limit?: number): Promise<ContextFamilyGraphPage>

@Remote('setNodeMode')
async setNodeMode(
  agent: Agent,
  ref: ContextPlanRef,
  node: ContextMessageRef,
  mode: 'natural' | 'include' | 'exclude',
): Promise<ContextifyView>

@Remote('setNodeModes')
async setNodeModes(agent: Agent, ref: ContextPlanRef, mutations: readonly ContextNodeMutation[]): Promise<ContextifyView>

@Remote('reset')
reset(agent: Agent, ref: ContextPlanRef): ContextifyView

@Remote('undo')
undo(agent: Agent, ref: ContextPlanRef): ContextifyView

@Remote('redo')
redo(agent: Agent, ref: ContextPlanRef): ContextifyView
```

`familyPage()` combines `ctx.sessions.list()` snapshots with `ctx.sessionPersistence.list()` and `inspect()`, chooses live Session events over persisted copies, projects only the active root family, and pages the frozen node array by numeric offset. `setNodeMode()` calls the same projection, verifies family membership and content hash, and appends `context/compiler-snapshot` before the new plan only for a valid off-path Include.

- [ ] **Step 4: Reset inherited plans and register the compiler**

On `agent/session-start`, append the initial version-two plan when absent. For a child, append a reset plan when the newest plan event lies before `session.header.seedLength`. Select the `contextify` compiler without appending any route event or pre-step listener.

```text
const latestPlan = agent.session.events.findLast(event => event.type === 'contextify/plan')
const inherited = agent.session.header.parentSession !== undefined
  && latestPlan !== undefined
  && latestPlan.seq < (agent.session.header.seedLength ?? 0)
if (latestPlan === undefined || inherited) {
  agent.session.append('contextify/plan', createInitialContextPlan(
    latestPlan === undefined ? 1 : latestPlan.data.revision + 1,
  ))
}
ctx.contextCompiler.select(agent.session, name)
```

- [ ] **Step 5: Add dependencies, invariant, verify, and commit**

Add `@deepseek-ai/dsh-session-persistence` to peer/dev dependencies and its project reference. Update the invariant to prove every selected snapshot sequence names a local `context/compiler-snapshot` event.

Run: `pnpm exec vitest run packages/context/contextify packages/context/context-compiler`

```bash
git add packages/context/contextify packages/context/context-compiler
git commit -m "feat: manage context across native Session families"
```

### Task 5: Recursive collapsible Workspace and Session tree

**Files:**
- Modify: `packages/client/ui-workspace/src/client/tree.ts`
- Modify: `packages/client/ui-workspace/src/client/stores.ts`
- Modify: `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`
- Modify: `packages/client/ui-workspace/src/client/rows/Rows.tsx`
- Modify: `packages/client/ui-workspace/src/client/rows/Rows.module.css`
- Modify: `packages/client/ui-workspace/tests/tree.client.spec.ts`
- Modify: `packages/client/ui-workspace/tests/rows.client.spec.tsx`

- [ ] **Step 1: Write failing tree tests**

Assert `root → child → grandchild` ordering, depth values `0, 1, 2`, sibling ordering from the Workspace account, collapsed-child omission, and preservation of unrelated roots:

```text
const groups = deriveGroups(list(root, child, grandchild, sibling, otherRoot), [project], [], {
  expandedGroups: ['project'], collapsedSessionIds: [child.id],
})
expect(groups[0]!.sessions.map(node => [node.id, node.depth, node.hasChildren])).toEqual([
  [root.id, 0, true],
  [child.id, 1, true],
  [sibling.id, 1, false],
  [otherRoot.id, 0, false],
])
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/client/ui-workspace/tests/tree.client.spec.ts packages/client/ui-workspace/tests/rows.client.spec.tsx`

Expected: the current projection returns every Session at depth zero and has no Session collapse control.

- [ ] **Step 3: Implement recursive projection and persisted collapse state**

Extend `SessionNode` with `depth`, `hasChildren`, and `expanded`. Extend `TreeView` and `WorkspaceViewState` with `collapsedSessionIds`. Add `setSessionExpanded`, preserving keys while Sessions exist. Within each Workspace group, build `byId`, `children`, and root lists from `parentSessionId`; recursively emit children unless their parent ID is collapsed. Orphans emit as roots and cycles emit once at root depth.

- [ ] **Step 4: Render and test chevrons**

Pass `toggleSession` into `SessionNodeItem`. Render a chevron button only for `hasChildren`, indent by `depth * 16px`, and prevent the chevron click from opening the Session. Add accessible labels `Collapse <title>` and `Expand <title>`.

Run: `pnpm exec vitest run packages/client/ui-workspace/tests`

- [ ] **Step 5: Commit**

```bash
git add packages/client/ui-workspace
git commit -m "feat: nest native Session forks in Workspace tree"
```

### Task 6: Branch from user and assistant messages through completed turns

**Files:**
- Modify: `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`
- Modify: `packages/client/ui-conversation/src/client/chat/TurnTailNodeView.tsx`
- Modify: `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`
- Modify: `packages/client/ui-conversation/src/client/contract/slots.ts`
- Modify: `packages/client/ui-conversation/tests/chat-view.client.spec.tsx`
- Modify: `packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`

- [ ] **Step 1: Write the failing user-Branch test**

Replace the old assertion that user bubbles have no Branch action. Click Branch on the user message and assert `forkAt()` receives the completed `turn/end` sequence, while the assistant button receives the same boundary.

```text
const buttons = view.getAllByRole('button', { name: '在新对话中分支' })
expect(buttons).toHaveLength(2)
fireEvent.click(buttons[0]!)
fireEvent.click(buttons[1]!)
expect(h.forkAt.mock.calls).toEqual([[3], [3]])
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/client/ui-conversation/tests/chat-view.client.spec.tsx -t "completed turn"`

Expected: only the assistant Branch button exists and it calls the assistant message sequence.

- [ ] **Step 3: Resolve Branch at the Turn boundary**

Pass the completed Turn end sequence from Chat Node owner data. `UserMessageNodeView` uses `useSession` to find the Turn containing `node.data.seq` and exposes Branch only when that Turn has a durable end and no later Chat node. `TurnTailNodeView` passes `turn.end.seq`. Keep unavailable behavior for incomplete or followed content.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm exec vitest run packages/client/ui-conversation/tests`

```bash
git add packages/client/ui-conversation
git commit -m "feat: branch native Sessions from any completed message"
```

### Task 7: React Flow Context Map canvas

**Files:**
- Modify: `packages/client/ui-contextify/package.json`
- Modify: `packages/client/ui-contextify/src/css-modules.d.ts`
- Create: `packages/client/ui-contextify/src/client/layout.ts`
- Create: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Create: `packages/client/ui-contextify/src/client/store.ts`
- Replace: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Replace: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- Replace: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Add dependencies and write failing component tests**

Add `@xyflow/react`, `dagre`, and `@types/dagre`. Mock `ResizeObserver` in the component test. Assert graph nodes and edges render, tool/reasoning records are absent from the fixture contract, search advances between results, layout buttons call all three layout modes, selection batch actions invoke mutations, and Branch/Navigate/Locate callbacks carry the canonical message reference.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

Expected: the vertical card panel has no React Flow canvas, layout switcher, search, or batch selection.

- [ ] **Step 3: Port the three layout algorithms**

Implement:

```text
export type ContextMapLayout = 'tree' | 'mindmap' | 'timeline'

export function layoutContextMap(
  nodes: readonly ContextGraphRecord[],
  edges: readonly ContextGraphEdge[],
  mode: ContextMapLayout,
): Node<ContextMapNodeData>[]
```

Use Dagre `rankdir: 'TB'` for tree and `rankdir: 'LR'` for timeline. Mind-map assigns root-family child lanes alternately left and right, using the independent repository's lane offset rule. Node size is `224 × 104`; layout only changes coordinates and handle positions.

- [ ] **Step 4: Build the graph component**

Use `<ReactFlow>` with `Background`, `Controls`, fit view, pan/zoom, draggable nodes, multi-selection, and marquee selection. Render a dedicated node component with role, preview, Session label, and Natural/Included/Excluded badge. Add search previous/next, Tree/Mind map/Timeline selector, Reset, Undo, Redo, close, and the batch action bar. Persist only `layout`, panel selection, and node-position overrides in `createContextMapStore()`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

```bash
git add packages/client/ui-contextify pnpm-lock.yaml
git commit -m "feat: render Context Map as an interactive graph"
```

### Task 8: Shared Contextify controller and Chat context actions

**Files:**
- Create: `packages/client/ui-contextify/src/client/controller.ts`
- Create: `packages/client/ui-contextify/src/client/ContextMessageAction.tsx`
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`
- Modify: `packages/client/ui-conversation/src/client/contract/slots.ts`
- Modify: `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`
- Modify: `packages/client/ui-conversation/src/client/chat/TurnTailNodeView.tsx`

- [ ] **Step 1: Write failing assembly tests**

Declare user and assistant action slots, mount the plugin, and assert one controller refresh updates both the pinned map and a Chat action. Assert graph Branch calls `sessions.fork({ sessionId: sourceSessionId, atSeq: turnEndSeq, increaseTitle: true })`, opens the child, and refreshes the family. Assert Navigate calls `sessions.open`, while Locate only opens details and focuses the node.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec vitest run packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

Expected: the plugin still calls virtual `createBranch/selectPath` RPC methods and registers no Chat action contributions.

- [ ] **Step 3: Implement one apply-owned observable controller**

`ContextifyController` keeps an immutable snapshot per active Session and exposes stable `getSnapshot`, `subscribe`, `refresh`, and mutation methods. `refresh()` loads `get` plus every `familyPage`, coalesces concurrent requests, and publishes once. Mutation methods use the current plan revision, await Remote success, then refresh. A 1.5-second timer runs only while at least one subscriber exists.

- [ ] **Step 4: Register graph and message actions through slots**

Extend conversation slots with:

```text
'conversation.chat.user-actions': {
  kind: 'list'; scope: 'session'; owner: { seq: number }
}
'conversation.chat.assistant-actions': {
  kind: 'list'; scope: 'session'; owner: { messageId: MessageId; seq: number }
}
```

The ui-contextify plugin registers the shared viewing store into the pinned panel and registers `ContextMessageAction` into both message-action slots. Inject the controller as a reserved `hooks.contextify` observable. Components receive only the bound `useContextify` hook and plain callbacks.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm exec vitest run packages/client/ui-contextify packages/client/ui-conversation`

```bash
git add packages/client/ui-contextify packages/client/ui-conversation
git commit -m "feat: synchronize Chat and Context Map controls"
```

### Task 9: Remote generation, documentation, and assembled browser proof

**Files:**
- Modify generated outputs from: `packages/context/contextify/src/index.ts`
- Modify: `packages/context/contextify/README.md`
- Modify: `packages/context/contextify/README.zh.md`
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`
- Create: `.agents/notes/proposed/feature/2026-08-17-native-session-context-map.md`
- Create: `.agents/notes/proposed/feature/2026-08-17-native-session-context-map.zh.md`
- Create: `.agents/notes/proposed/feature/2026-08-17-native-session-context-map.i18n.yaml`
- Replace: `apps/web/tests/contextify-map.e2e.ts`

- [ ] **Step 1: Write the failing E2E scenario**

Use the replay scaffold to create a root conversation, fork two native child Sessions, append one child-local message to each, open the right map, and assert shared prefix de-duplication, two branch edges, recursive sidebar rows, and no tool/reasoning graph nodes. Exclude a Natural message from Chat, Include a sibling message from the graph, reload, and assert both states survive. Submit a child request and inspect the mock provider input for the exact included and excluded texts.

- [ ] **Step 2: Verify RED**

Run: `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts`

Expected: failure because the current UI renders virtual paths as cards and cannot show or compile sibling Session messages.

- [ ] **Step 3: Generate Remote and documentation artifacts**

Run:

```bash
pnpm run gen-cordis-api
pnpm run gen-cordis-catalog
pnpm run gen-persistence-catalog
pnpm run gen-doc-graphs
pnpm run verify-translation-pairing --write packages/context/contextify/README.i18n.yaml
pnpm run verify-translation-pairing --write packages/client/ui-contextify/README.i18n.yaml
```

Update the READMEs and Agent Note with native Session family semantics, model-visible snapshot effects, no cross-map imports, child-plan reset, and the append-only replacements for Edit/Delete/Promote.

- [ ] **Step 4: Make E2E GREEN**

Run the focused replay E2E until it passes, then run `pnpm exec vitest run apps/web/tests/details-session-lifecycle.e2e.ts` to preserve the pinned-details lifecycle.

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests packages/context/contextify packages/client/ui-contextify docs .agents/notes packages/api/remotes packages/extensions
git commit -m "test: prove native Session Context Map workflow"
```

### Task 10: Completion audit and full verification ladder

**Files:**
- Inspect: `docs/superpowers/specs/2026-08-17-native-session-context-map-design.md`
- Inspect: all files changed since commit `8c54571b1e`

- [ ] **Step 1: Prove removal of virtual branch vocabulary**

Run:

```bash
rg -n "ContextPath|pathId|contextify/route|createBranch|selectPath|returnToMainline" \
  packages/context/contextify packages/client/ui-contextify apps/web/tests/contextify-map.e2e.ts
```

Expected: no production or active test matches.

- [ ] **Step 2: Run focused and GUI checks**

```bash
pnpm exec vitest run packages/context/context-compiler packages/context/contextify
pnpm run test:gui
```

Expected: all tests pass with no warnings or unhandled errors.

- [ ] **Step 3: Run static and documentation checks**

```bash
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 4: Run assembled browser and production build checks**

```bash
DSH_SNAPSHOT=replay pnpm run test:web
pnpm run build:web
```

Expected: replay-backed browser tests and the production web build pass.

- [ ] **Step 5: Audit all twelve acceptance criteria**

For each numbered criterion in the design spec, record the source file and test or command proving it. Treat any missing proof as unfinished work and add the narrowest test that demonstrates the real assembled behavior.

- [ ] **Step 6: Commit verification fixes**

```bash
git add -A
git commit -m "fix: complete native Session Context Map verification"
```

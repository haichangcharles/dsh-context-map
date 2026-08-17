# Context Map Canvas Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the independent Context Map's click, multi-select, context-menu, live-drag, and Chat-location interactions while keeping Harness Context Plan and native Sessions authoritative.

**Architecture:** `ui-contextify` owns transient canvas gestures and delegates durable mutations through its existing injected action face. `ui-conversation` adds a narrow Session-and-sequence reveal controller so Contextify can request Chat navigation without querying another package's DOM. React Flow applies drag changes locally on every frame and commits only the final position to the existing viewing store.

**Tech Stack:** React 19, TypeScript, `@xyflow/react`, Cordis client services and slots, Vitest, Testing Library, CSS Modules.

---

## File structure

- Create `packages/client/ui-contextify/src/client/canvas-interactions.ts`: pure mode-cycle and rectangle-intersection rules shared by the panel and tests.
- Create `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`: pointer-positioned right-click menu with Harness-backed actions.
- Modify `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`: Normal/Selection modes, custom marquee, batch bar, live controlled nodes, and context-menu orchestration.
- Modify `packages/client/ui-contextify/src/client/ContextMapNode.tsx`: card click and context-menu event handoff while preserving accessible direct controls.
- Modify `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`: selection toggle, marquee, menu, highlight, and floating action-bar presentation.
- Create `packages/client/ui-conversation/src/client/chat/message-reveal.ts`: per-Session one-shot reveal request registry.
- Modify `packages/client/ui-conversation/src/client/service.ts`: public `revealMessage(sessionId, seq)` request face.
- Modify `packages/client/ui-conversation/src/client/apply.ts`: bind the reveal registry to Chat view injection and activate the native Chat tab.
- Modify `packages/client/ui-conversation/src/client/contract/slots.ts`: typed reveal subscription/consume props for ChatView.
- Modify `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`: durable message-sequence anchors.
- Modify `packages/client/ui-conversation/src/client/chat/ChatView.tsx`: consume reveal requests, scroll, and temporary highlight.
- Modify `packages/client/ui-conversation/src/client/chat/ChatView.module.css`: reveal highlight animation with reduced-motion handling.
- Modify `packages/client/ui-contextify/src/client/index.ts`: route Locate in Chat to `ctx.conversation.revealMessage`.
- Modify focused tests in `packages/client/ui-contextify/tests/` and `packages/client/ui-conversation/tests/`; update both package README language pairs and an Agent Note after behavior passes.

### Task 1: Prove and implement original canvas selection semantics

**Files:**
- Create: `packages/client/ui-contextify/src/client/canvas-interactions.ts`
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`

- [ ] **Step 1: Write failing interaction tests**

Add tests that render a natural active-path node and a natural off-path node, call the React Flow node-click callback, and expect `setNodeMode(owner, 'exclude')` and `setNodeMode(owner, 'include')` respectively. Add a Selection-mode test that clicks two nodes and expects both IDs in the viewing store without a Context Plan mutation.

```ts
fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
fireEvent.click(screen.getByLabelText('User message: root'))
fireEvent.click(screen.getByLabelText('User message: branch'))
expect(store.store.getSnapshot().selectedNodeIds).toEqual([root.id, branch.id])
expect(actions.setNodeMode).not.toHaveBeenCalled()
```

- [ ] **Step 2: Run the focused tests and observe failure**

Run: `pnpm --filter @deepseek-ai/dsh-client-ui-contextify test -- context-map-panel.client.spec.tsx`

Expected: FAIL because no Selection mode exists and card clicks do not invoke mode changes.

- [ ] **Step 3: Add pure cycle and intersection rules**

Implement these exported functions in `canvas-interactions.ts`:

```ts
export type CanvasPoint = { readonly x: number; readonly y: number }
export type CanvasRect = CanvasPoint & { readonly width: number; readonly height: number }

export function nextNodeMode(active: boolean, mode: ContextNodeMode): ContextNodeMode {
  if (active) return mode === 'exclude' ? 'natural' : 'exclude'
  return mode === 'include' ? 'natural' : 'include'
}

export function intersects(a: CanvasRect, b: CanvasRect): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x
    && a.y <= b.y + b.height && a.y + a.height >= b.y
}
```

- [ ] **Step 4: Add explicit Normal and Selection modes**

Keep `interactionMode` in panel-local state. Pass `onActivate` from the panel to each node. In Normal mode call `setNodeMode(record.owner, nextNodeMode(active, mode))`; in Selection mode toggle only the viewing-store selection. Set React Flow `nodesDraggable={interactionMode === 'normal'}` and make the Selection button expose `aria-pressed`.

- [ ] **Step 5: Run focused tests and commit**

Run the Task 1 focused test command and expect PASS. Commit with `feat: restore Context Map node interactions`.

### Task 2: Restore visible Shift-marquee and batch operations

**Files:**
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`

- [ ] **Step 1: Write a failing marquee test**

Simulate Shift pointer-down, pointer-move, and pointer-up over the canvas with two mocked node rectangles. Expect the marquee element to update before pointer-up and the intersecting node IDs to be toggled after pointer-up.

```ts
fireEvent.pointerDown(canvas, { shiftKey: true, clientX: 10, clientY: 10, pointerId: 1 })
fireEvent.pointerMove(canvas, { shiftKey: true, clientX: 220, clientY: 220, pointerId: 1 })
expect(screen.getByTestId('context-map-marquee')).toHaveStyle({ width: '210px', height: '210px' })
fireEvent.pointerUp(canvas, { shiftKey: true, clientX: 220, clientY: 220, pointerId: 1 })
expect(store.store.getSnapshot().selectedNodeIds).toContain(root.id)
```

- [ ] **Step 2: Run the test and observe failure**

Run the focused Contextify test command. Expected: FAIL because the panel delegates selection to React Flow and renders no custom marquee.

- [ ] **Step 3: Implement the original selection gesture**

When Selection mode and Shift are active, record the pointer origin relative to the React Flow viewport, capture the pointer, render an absolutely positioned marquee, and use `instance.getNodes()` plus `instance.flowToScreenPosition` to test node rectangles with `intersects`. On pointer-up toggle all hit IDs in one viewing-store update and clear the marquee. Ordinary Selection-mode clicks remain additive.

- [ ] **Step 4: Preserve Harness batch mutations**

Keep the existing `setNodeModes` action, but make the floating bar visible only in Selection mode. Include, Exclude, and Natural submit one mutation per selected native message owner. Clear selection remains presentation-only.

- [ ] **Step 5: Run focused tests and commit**

Expect all Context Map panel tests to pass. Commit with `feat: add Context Map marquee selection`.

### Task 3: Restore right-click menu and live dragging

**Files:**
- Create: `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`

- [ ] **Step 1: Write failing menu and drag tests**

Right-click a node and assert menu items for Locate in Chat, Branch from Here, Natural, Include, and Exclude. Invoke each item and assert the existing injected action. Feed one `position` change with `dragging: true` and assert the controlled node position changes immediately while the viewing store does not; feed the final `dragging: false` change and assert persistence.

- [ ] **Step 2: Run tests and observe failure**

Expected failures: no context menu, and the controlled node keeps its layout position until drag end.

- [ ] **Step 3: Implement the menu**

`ContextMapMenu` receives `{ x, y, record, mode, close, actions }`, renders `role="menu"`, and stops propagation. The panel opens it from node `onContextMenu`, closes it on Escape, pane click, move start, and completed action, and clamps it to the panel bounds.

- [ ] **Step 4: Implement transient live positions**

Maintain a transient `Map<string, XYPosition>` in panel state. Apply every React Flow position change to that map. Resolve node position as transient, then persisted override, then layout. On `dragging: false`, persist the final coordinate with `actions.setPosition` and remove the transient entry.

```ts
if (change.type === 'position' && change.position !== undefined) {
  setTransientPositions(current => new Map(current).set(change.id, change.position!))
  if (change.dragging === false) {
    actions.setPosition(change.id, change.position)
    setTransientPositions(current => {
      const next = new Map(current)
      next.delete(change.id)
      return next
    })
  }
}
```

- [ ] **Step 5: Run tests and commit**

Expect menu, dismissal, and live-drag tests to pass. Commit with `feat: restore Context Map canvas menu and drag`.

### Task 4: Add the native Chat message reveal contract

**Files:**
- Create: `packages/client/ui-conversation/src/client/chat/message-reveal.ts`
- Create: `packages/client/ui-conversation/tests/message-reveal.client.spec.tsx`
- Modify: `packages/client/ui-conversation/src/client/service.ts`
- Modify: `packages/client/ui-conversation/src/client/apply.ts`
- Modify: `packages/client/ui-conversation/src/client/contract/slots.ts`
- Modify: `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`
- Modify: `packages/client/ui-conversation/src/client/chat/ChatView.tsx`
- Modify: `packages/client/ui-conversation/src/client/chat/ChatView.module.css`

- [ ] **Step 1: Write failing reveal registry and ChatView tests**

Prove a request made before the target row mounts remains readable, a matching ChatView scrolls the row with `block: 'center'`, the row receives `data-chat-revealed`, and consumption clears only the matching request ID.

```ts
reveal.request(sessionId, 12)
expect(reveal.read(sessionId)?.seq).toBe(12)
renderChat({ reveal: reveal.binding(sessionId), messageSeq: 12 })
expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
```

- [ ] **Step 2: Run tests and observe failure**

Run: `pnpm --filter @deepseek-ai/dsh-client-ui-conversation test -- message-reveal.client.spec.tsx`

Expected: FAIL because the reveal registry, durable message anchors, and ChatView effect do not exist.

- [ ] **Step 3: Implement the one-shot registry**

Create `MessageRevealRegistry` with monotonically increasing request IDs, `request(sessionId, seq)`, `binding(sessionId)`, `read`, `subscribe`, and compare-and-clear `consume`. Keep it browser-memory-only.

- [ ] **Step 4: Expose and bind the conversation service action**

Add `revealMessage(sessionId: SessionId, seq: number): void` to `IConversation`. The controller opens the native Session and publishes the reveal request. `apply.ts` constructs one registry, provides its session binding to ChatView, and switches the target Session store to the native `chat` view before reveal consumption.

- [ ] **Step 5: Anchor and reveal exact messages**

Derive a durable sequence from user message node data and finalized assistant node data in `ChatNodeSeat`, render `data-chat-message-seq`, and let ChatView locate that exact row without interpolating an unsafe selector. Scroll it into view, set temporary reveal state, consume the request, and remove the highlight after 1.5 seconds. Add reduced-motion CSS.

- [ ] **Step 6: Run focused tests and commit**

Expect the registry and ChatView reveal tests plus existing conversation tests to pass. Commit with `feat: add Chat message reveal navigation`.

### Task 5: Wire Context Map Locate to native Chat and verify integration

**Files:**
- Modify: `packages/client/ui-contextify/src/client/index.ts`
- Modify: `packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`
- Modify: `packages/client/ui-contextify/README.md`
- Modify: `packages/client/ui-contextify/README.zh.md`
- Modify: `packages/client/ui-conversation/README.md`
- Modify: `packages/client/ui-conversation/README.zh.md`
- Create: `.agents/notes/implemented/client/2026-08-17-context-map-canvas-interactions.md`

- [ ] **Step 1: Write the failing plugin wiring test**

Invoke the map node's Locate in Chat action and expect `conversation.revealMessage(node.owner.sessionId, node.owner.seq)`, not `controller.focus` or direct DOM access. Keep Chat-to-Map Locate wired to `controller.focus`.

- [ ] **Step 2: Run and observe the wiring failure**

Run the focused Contextify browser-plugin test. Expected: FAIL because current map Locate only focuses the graph.

- [ ] **Step 3: Wire the action through the native conversation service**

Add `conversation` to Contextify injection requirements and implement map `locate` as `ctx.conversation.revealMessage(node.owner.sessionId, node.owner.seq)`. Change the action type from a node ID to the full `ContextFamilyGraphNode`. Remove the redundant Open button from node chrome; Session navigation remains available through Locate and the context menu.

- [ ] **Step 4: Update package contracts and the Agent Note**

Document the original-style canvas gestures, the UI-only viewing state, and the Session-plus-sequence reveal seam in both package README language pairs. Record why Contextify delegates scrolling to conversation and why transient drag state is not persisted per frame.

- [ ] **Step 5: Run the focused package verification**

Run:

```bash
pnpm --filter @deepseek-ai/dsh-client-ui-contextify test
pnpm --filter @deepseek-ai/dsh-client-ui-conversation test
pnpm --filter @deepseek-ai/dsh-client-ui-contextify typecheck
pnpm --filter @deepseek-ai/dsh-client-ui-conversation typecheck
```

Expected: all commands pass.

- [ ] **Step 6: Run assembled GUI verification**

Run `pnpm run test:gui`, then `DSH_SNAPSHOT=replay pnpm run test:web`, and finally the relevant lint, documentation, and production-web build commands required by the package Agent Notes. Expected: all checks pass and the replay scenario proves right-click Locate, multi-selection, batch mode mutation, and live node movement.

- [ ] **Step 7: Commit verified integration**

Commit implementation documentation and any replay fixture changes with `test: verify Context Map canvas workflow`.

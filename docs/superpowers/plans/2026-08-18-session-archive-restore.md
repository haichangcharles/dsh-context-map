# Session Archive Restore Implementation Plan

English | [中文](2026-08-18-session-archive-restore.zh.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native archived-Session list and a conflict-safe restore operation that returns the same Session to its current Workspace tree and complete Context Map family.

**Architecture:** Keep `archivedSessionIds` as the single durable state and add a serialized `unarchiveSession` inverse through the existing Workspace domain, RPC, fixture, runtime, and UI layers. Render archived rows from Session summaries plus current Workspace accounting; Contextify continues to own the complete family graph while the UI separately reconciles visible selection and complete-family position retention.

**Tech Stack:** TypeScript, Cordis services, Typert/RPC contracts, Zod, React, React Flow, Vitest, Testing Library, CSS Modules.

---

## File structure

- `packages/workspace/workspace/src/index.ts` owns atomic archive membership mutation.
- `packages/host/apiproxy/src/api/workspace.ts`, `workspace.schema.ts`, `rpc-map.ts`, `fetch/handler.ts`, `fetch/client.ts`, and `api-proxy.ts` expose and execute the inverse RPC.
- `packages/client/connection/src/client/fixture.ts` mirrors Host behavior for browser fixtures.
- `packages/client/runtime/src/client/workspaces/manager.ts`, `service.ts`, and `contract/workspaces.ts` install the returned full archive set and expose the action.
- `packages/client/ui-workspace/src/client/archived.ts` derives archived groups without mixing them into active-tree derivation.
- `packages/client/ui-workspace/src/client/ArchivedSessionsView.tsx` owns filtering, pending rows, retry errors, and restore actions.
- `packages/client/ui-contextify/src/client/store.ts` distinguishes visible selection retention from complete-family position retention.
- Existing package READMEs and the Session archive Agent Note own the shipped contract and rationale.

### Task 1: Workspace-domain inverse operation

**Files:**
- Modify: `packages/workspace/workspace/tests/workspace.spec.ts`
- Modify: `packages/workspace/workspace/src/index.ts`

- [ ] **Step 1: Write failing durability, idempotence, availability, and ordering tests**

Add tests beside `registry-global session archive` using the existing helpers:

~~~text
it('restores one archived id without touching workspace accounting', async () => {
  const dir = await makeDir('unarchive-home')
  const result = await harness({ sessions: [header('parent', dir, 100), header('child', dir, 200)] })
  const workspace = result.registry.list()[0]!
  const accounting = [...workspace.sessionIds]
  await result.registry.archiveSession(SessionId('parent'))

  await result.registry.unarchiveSession(SessionId('parent'))

  expect(result.registry.archivedSessionIds).toEqual([])
  expect(workspace.sessionIds).toEqual(accounting)
  expect(storedState(result.pool).archivedSessionIds).toEqual([])
})
~~~

Add a repeated-restore assertion that the global-state change count does not increase. Add a case where an archived header disappears from the persistence listing and assert rejection plus unchanged membership. Add two ordered sequences: `unarchive → archive` ends archived; `archive → unarchive` ends restored.

- [ ] **Step 2: Run the focused tests and verify RED**

~~~bash
pnpm exec vitest run packages/workspace/workspace/tests/workspace.spec.ts -t 'restore|unarchive|ordered'
~~~

Expected: FAIL because `WorkspaceRegistry.unarchiveSession` does not exist.

- [ ] **Step 3: Implement the serialized inverse**

~~~text
unarchiveSession(sessionId: SessionId): Promise<void> {
  return this.enqueueOperation(async () => {
    if (!this.requireState().archivedSessionIds.includes(sessionId)) return
    if (!(await this.sessionKnown(sessionId))) {
      throw new WorkspaceUnknownSessionError(sessionId)
    }
    const state = this.requireState()
    await this.setState({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
    })
  })
}
~~~

Document that it changes only visibility, verifies an archived member still exists, and treats a non-member as an idempotent no-op.

- [ ] **Step 4: Run all Workspace package tests and verify GREEN**

~~~bash
pnpm exec vitest run packages/workspace/workspace/tests/workspace.spec.ts packages/workspace/workspace/tests/invariant.spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add packages/workspace/workspace/src/index.ts packages/workspace/workspace/tests/workspace.spec.ts
git commit -m "feat(workspace): restore archived sessions"
~~~

### Task 2: RPC, schemas, Host execution, and stream behavior

**Files:**
- Modify: `packages/host/apiproxy/src/api/workspace.ts`
- Modify: `packages/host/apiproxy/src/api/workspace.schema.ts`
- Modify: `packages/host/apiproxy/src/api/rpc-map.ts`
- Modify: `packages/host/apiproxy/src/fetch/handler.ts`
- Modify: `packages/host/apiproxy/src/fetch/client.ts`
- Modify: `packages/host/apiproxy/src/api-proxy.ts`
- Modify: `packages/host/apiproxy/tests/rpc-schemas.spec.ts`
- Modify: `packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`
- Modify: `packages/host/apiproxy/tests/client-handler.spec.ts`
- Modify: `packages/host/apiproxy/tests/fetch-carrier.spec.ts`

- [ ] **Step 1: Write failing schema and assembled Host tests**

Add request/value parsing assertions for `workspace.unarchiveSession`. Extend the real API archive test to restore the same Session, observe one `host/archived-sessions-changed` full snapshot, verify Workspace accounting is unchanged, repeat restore without a second frame, and verify unavailable archived Sessions fail with `session-not-found` while membership remains.

- [ ] **Step 2: Run Host tests and verify RED**

~~~bash
pnpm exec vitest run packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/api-proxy-workspace.spec.ts -t 'archive|unarchive|restore'
~~~

- [ ] **Step 3: Add the typed method and Zod schemas**

~~~text
unarchiveSession(request: RpcRequest<{ sessionId: SessionId }>):
Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>>
~~~

~~~text
export const workspaceUnarchiveSessionRequestSchema = z.object({
  sessionId: sessionIdSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'workspace.unarchiveSession'>>>

export const workspaceUnarchiveSessionValueSchema = z.object({
  archivedSessionIds: z.array(sessionIdSchema),
}) satisfies z.ZodType<Wire<ResponseValue<'workspace.unarchiveSession'>>>
~~~

- [ ] **Step 4: Wire every closed dispatch table**

Add `workspace.unarchiveSession` to `RpcMethodMap`, the fetch handler, response schema table, `IApiClient.workspace`, the `callUnary` implementation, and every literal `WorkspaceApi` fake in the named tests.

- [ ] **Step 5: Implement Host error mapping and full-set response**

~~~text
async unarchiveSession(request) {
  const { sessionId } = request.payload
  try {
    await ctx.workspaceRegistry.unarchiveSession(sessionId)
  } catch (error: unknown) {
    if (!(error instanceof WorkspaceUnknownSessionError)) throw error
    return err(request, {
      code: 'session-not-found',
      message: error.message,
      details: { sessionId },
    })
  }
  return ok(request, { archivedSessionIds: [...ctx.workspaceRegistry.archivedSessionIds] })
}
~~~

Do not add a new frame type; the existing domain-state comparison already emits the complete archive set for additions and removals.

- [ ] **Step 6: Run Host tests and verify GREEN**

~~~bash
pnpm exec vitest run packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/api-proxy-workspace.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/host/apiproxy/tests/fetch-carrier.spec.ts
~~~

- [ ] **Step 7: Commit**

~~~bash
git add packages/host/apiproxy
git commit -m "feat(host): expose session archive restore"
~~~

### Task 3: Client fixture and Workspace runtime

**Files:**
- Modify: `packages/client/connection/src/client/fixture.ts`
- Modify: `packages/client/connection/tests/fake-api.client.ts`
- Modify: `packages/client/runtime/tests/fake-api.client.ts`
- Modify: `packages/client/runtime/tests/workspaces-service.client.spec.ts`
- Modify: `packages/client/runtime/src/client/contract/workspaces.ts`
- Modify: `packages/client/runtime/src/client/workspaces/manager.ts`
- Modify: `packages/client/runtime/src/client/workspaces/service.ts`

- [ ] **Step 1: Write failing echo, failure, selection, and stale-baseline tests**

Make the fake return an archive set with one ID removed. Assert the exact RPC payload, installed snapshot, and unchanged current Session. Start an in-flight `workspace.list`, install a newer restore echo, resolve the stale list with the old larger set, and assert the restored set survives. A rejected restore must retain the previous set.

- [ ] **Step 2: Run runtime tests and verify RED**

~~~bash
pnpm exec vitest run packages/client/runtime/tests/workspaces-service.client.spec.ts -t 'archive|unarchive|restore|stale'
~~~

- [ ] **Step 3: Implement fixture removal semantics**

~~~text
unarchiveSession: (request) => {
  const { sessionId } = request.payload
  const index = archivedSessionIds.indexOf(sessionId)
  if (index !== -1) {
    archivedSessionIds.splice(index, 1)
    emitHost({ type: 'host/archived-sessions-changed', archivedSessionIds: [...archivedSessionIds] })
  }
  return ok(request, { archivedSessionIds: [...archivedSessionIds] })
},
~~~

Add the dispatch switch case and both typed fake API methods.

- [ ] **Step 4: Implement manager, service, and public contract methods**

~~~text
async unarchiveSession(sessionId: SessionId): Promise<RpcResult<{ archivedSessionIds: SessionId[] }>> {
  const { result } = await this.api.workspace.unarchiveSession({ sessionId })
  if (result.ok) this.installArchived(result.value.archivedSessionIds)
  return result
}
~~~

~~~text
async unarchiveSession(sessionId: SessionId): Promise<void> {
  const result = await this.manager.unarchiveSession(sessionId)
  if (!result.ok) {
    throw new Error(`session restore failed: ${result.error.code}: ${result.error.message}`)
  }
}
~~~

Do not open a Session or mutate Session selection.

- [ ] **Step 5: Run runtime and fixture tests and verify GREEN**

~~~bash
pnpm exec vitest run packages/client/runtime/tests/workspaces-service.client.spec.ts packages/client/connection/tests/fixture.client.spec.ts packages/client/connection/tests/fixture-commands.client.spec.ts
~~~

- [ ] **Step 6: Commit**

~~~bash
git add packages/client/runtime packages/client/connection
git commit -m "feat(client): restore archived session state"
~~~

### Task 4: Pure archived-list projection

**Files:**
- Create: `packages/client/ui-workspace/src/client/archived.ts`
- Create: `packages/client/ui-workspace/tests/archived.client.spec.ts`

- [ ] **Step 1: Write failing projection tests**

Cover newest-archive-first order, current Workspace grouping, deleted-Workspace fallback to Ungrouped, parent title, title filtering, and missing-summary ID fallback.

~~~text
const groups = deriveArchivedGroups(
  list(parent, child),
  [workspace('project', ['parent', 'child'])],
  [sid('parent'), sid('child')],
  '',
)
expect(groups[0]?.rows.map(row => row.id)).toEqual([sid('child'), sid('parent')])
expect(groups[0]?.rows[0]).toMatchObject({ title: 'child', parentTitle: 'parent' })
~~~

- [ ] **Step 2: Run the projection test and verify RED**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/archived.client.spec.ts
~~~

- [ ] **Step 3: Implement focused view types and derivation**

Create `ArchivedSessionRow`, `ArchivedSessionGroup`, and:

~~~text
export function deriveArchivedGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  query: string,
): ArchivedSessionGroup[]
~~~

Build a Workspace-by-Session index, iterate reversed Host archive order, use `displayTitle ?? id`, resolve parent title only from available summaries, filter with a trimmed lowercase query, then group in current Host Workspace order followed by Ungrouped. Do not infer a nested archived tree.

- [ ] **Step 4: Run projection tests and verify GREEN**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/archived.client.spec.ts
~~~

- [ ] **Step 5: Commit**

~~~bash
git add packages/client/ui-workspace/src/client/archived.ts packages/client/ui-workspace/tests/archived.client.spec.ts
git commit -m "feat(ui-workspace): derive archived session groups"
~~~

### Task 5: Archived Sessions sidebar subview

**Files:**
- Create: `packages/client/ui-workspace/src/client/ArchivedSessionsView.tsx`
- Create: `packages/client/ui-workspace/src/client/ArchivedSessionsView.module.css`
- Modify: `packages/client/ui-workspace/src/css-modules.d.ts`
- Modify: `packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`
- Modify: `packages/client/ui-workspace/src/client/WorkspaceBrowser.module.css`
- Modify: `packages/client/ui-workspace/src/client/contract/slots.ts`
- Modify: `packages/client/ui-workspace/src/client/index.ts`
- Modify: `packages/client/ui-workspace/src/client/locales.ts`
- Modify: `packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`
- Modify: `packages/client/ui-workspace/tests/apply.client.spec.ts`

- [ ] **Step 1: Write failing product-flow component tests**

Assert that the count button opens the subview, rows show Workspace and parent context, Restore calls the exact ID, and `open` is not called. Cover local filtering, Back, row-local pending, rejection plus successful retry, removal only after authoritative archive-set rerender, Workspace deletion to Ungrouped, and missing summaries.

- [ ] **Step 2: Run browser tests and verify RED**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx packages/client/ui-workspace/tests/apply.client.spec.ts
~~~

- [ ] **Step 3: Add the injected restore action and localized copy**

Add `restoreSession(sessionId: SessionId): Promise<void>` to the slot contract and bind it to `ctx.workspaces.unarchiveSession`. Add complete Chinese and English keys for the control, heading, Back, filter, empty states, parent label, Restore, pending, and error.

- [ ] **Step 4: Implement `ArchivedSessionsView`**

Use `deriveArchivedGroups`, a controlled query, `Set<SessionId>` pending state, and per-ID error strings. Disable only the pending row. Keep a successful row rendered until the parent supplies a new archive set. Give errors `role="alert"`; never attach an open-row action.

- [ ] **Step 5: Integrate browser navigation and count**

Add `archiveViewOpen` to `WorkspaceBrowser`. In wide mode, render an `IconArchiveOutline20` header control with count. When open, replace ordinary search/tree content with the archived subview. Back must preserve grouping, search, order, and current Session. Keep rail behavior unchanged.

- [ ] **Step 6: Run UI tests and verify GREEN**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/archived.client.spec.ts packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx packages/client/ui-workspace/tests/apply.client.spec.ts packages/client/ui-workspace/tests/browser-styles.client.spec.ts
~~~

- [ ] **Step 7: Commit**

~~~bash
git add packages/client/ui-workspace
git commit -m "feat(ui-workspace): list and restore archived sessions"
~~~

### Task 6: Context Map visibility and position reconciliation

**Files:**
- Modify: `packages/client/ui-contextify/src/client/store.ts`
- Modify: `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- Create: `packages/client/ui-contextify/tests/store.client.spec.ts`
- Modify: `packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **Step 1: Write failing store and reprojection tests**

~~~text
const store = createContextMapStore().create()
store.actions.setNodeSelected('archived:1', true)
store.actions.setPosition('archived:1', { x: 40, y: 80 })
store.actions.reconcileNodeIds(['visible:1'], ['visible:1', 'archived:1'])
expect(store.getSnapshot().selectedNodeIds).toEqual([])
expect(store.getSnapshot().positionOverrides).toEqual({
  'archived:1': { x: 40, y: 80 },
})
~~~

In the panel test, hide an archived root-only node, add descendant messages and a branch to the complete graph, then rerender with an empty archive set. Assert the original owner, edges, later descendants, and saved position return while hidden selection stays cleared.

- [ ] **Step 2: Run Context Map tests and verify RED**

~~~bash
pnpm exec vitest run packages/client/ui-contextify/tests/store.client.spec.ts packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx -t 'archive|restore|position|selection'
~~~

- [ ] **Step 3: Split reconciliation semantics**

Replace `retainNodeIds` with:

~~~text
reconcileNodeIds: (draft, visibleNodeIds, familyNodeIds) => {
  const visible = new Set(visibleNodeIds)
  const family = new Set(familyNodeIds)
  draft.selectedNodeIds = draft.selectedNodeIds.filter(id => visible.has(id))
  draft.positionOverrides = Object.fromEntries(
    Object.entries(draft.positionOverrides).filter(([id]) => family.has(id)),
  )
},
~~~

- [ ] **Step 4: Reconcile the panel against visible and complete graphs**

~~~text
useEffect(() => {
  actions.reconcileNodeIds(
    records.map(node => node.id),
    snapshot.graph?.nodes.map(node => node.id) ?? [],
  )
}, [actions, records, snapshot.graph])
~~~

Keep `projectUnarchivedContextFamily` unchanged; it already preserves stable node IDs and reprojects from the complete graph.

- [ ] **Step 5: Run Context Map tests and verify GREEN**

~~~bash
pnpm exec vitest run packages/client/ui-contextify/tests/store.client.spec.ts packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
~~~

- [ ] **Step 6: Commit**

~~~bash
git add packages/client/ui-contextify
git commit -m "fix(ui-contextify): preserve map layout across archive restore"
~~~

### Task 7: Documentation, assembled regression, and final verification

**Files:**
- Modify: `.agents/notes/implemented/feature/2026-07-31-session-archive-global-set.*`
- Modify: `packages/workspace/workspace/README.*`
- Modify: `packages/host/apiproxy/README.*`
- Modify: `packages/client/runtime/README.*`
- Modify: `packages/client/ui-workspace/README.*`
- Modify: `packages/client/ui-contextify/README.*`
- Modify: `packages/client/connection/tests/fixture.client.spec.ts`

- [ ] **Step 1: Add a keyless assembled regression**

Through real fixture public entry points, create a parent and fork child, archive the parent, add later child state, restore the parent, and assert the archive set removes the parent while the child retains the same `parentId`. Do not mutate runtime stores directly.

- [ ] **Step 2: Run the assembled regression**

~~~bash
pnpm exec vitest run packages/client/connection/tests/fixture.client.spec.ts -t 'archive restore'
~~~

- [ ] **Step 3: Update current-state documentation**

Update the existing Agent Note from future restore to the shipped symmetric operation, list UI, idempotence, current-account placement, and full-set conflict semantics. Record archive-time snapshots as the rejected alternative. Update each owning README in English and Chinese, then re-record every modified pair with `pnpm run verify-translation-pairing --write <english-path>`.

- [ ] **Step 4: Run focused feature verification**

~~~bash
pnpm exec vitest run \
  packages/workspace/workspace/tests/workspace.spec.ts \
  packages/host/apiproxy/tests/rpc-schemas.spec.ts \
  packages/host/apiproxy/tests/api-proxy-workspace.spec.ts \
  packages/client/runtime/tests/workspaces-service.client.spec.ts \
  packages/client/ui-workspace/tests/archived.client.spec.ts \
  packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx \
  packages/client/ui-contextify/tests/store.client.spec.ts \
  packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx \
  packages/client/connection/tests/fixture.client.spec.ts
pnpm run typecheck
pnpm run lint
git diff --check
~~~

- [ ] **Step 5: Run browser verification**

Archive a parent, continue a visible child, create another child branch, restore the parent from Archived Sessions, confirm Chat does not switch, then open the restored parent and verify the Map contains the restored path plus later descendant changes with preserved dragged positions.

- [ ] **Step 6: Commit documentation and final regression**

~~~bash
git add .agents/notes/implemented/feature/2026-07-31-session-archive-global-set* \
  packages/workspace/workspace/README* packages/host/apiproxy/README* \
  packages/client/runtime/README* packages/client/ui-workspace/README* \
  packages/client/ui-contextify/README* packages/client/connection/tests/fixture.client.spec.ts
git commit -m "docs: document session archive restoration"
~~~

## Final acceptance audit

- [ ] Restore changes only `archivedSessionIds` membership.
- [ ] Repeated restore, cross-tab restore, stale baselines, and archive/restore ordering converge on the Host snapshot.
- [ ] Workspace deletion produces Ungrouped placement; current accounting wins over archive-time placement.
- [ ] Parent/child identity and Context Plans survive descendant messages and branches created while archived.
- [ ] Restore never opens a Session or steals current Chat selection.
- [ ] Archived-list errors remain retryable and pending state is row-local.
- [ ] Hidden Map nodes leave batch selection but retain positions until they leave the complete family.
- [ ] Focused tests, typecheck, lint, bilingual pairing, and whitespace checks provide fresh passing evidence before completion is claimed.

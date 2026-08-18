# Session 归档恢复实施计划

[English](2026-08-18-session-archive-restore.md) | 中文

> **面向 agent worker：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项执行本计划。所有步骤使用 checkbox（`- [ ]`）跟踪。

**目标：** 增加原生已归档 Session 列表和冲突安全的恢复操作，让同一个 Session 回到当前 Workspace 树与完整 Context Map family。

**架构：** 继续把 `archivedSessionIds` 作为唯一持久状态，并通过现有 Workspace domain、RPC、fixture、runtime 和 UI 增加串行 `unarchiveSession` 逆操作。归档列表由 Session summary 与当前 Workspace 记账派生；Contextify 继续持有完整 family graph，而 UI 分别按照可见节点清理 selection、按照完整 family 保留位置。

**技术栈：** TypeScript、Cordis service、Typert/RPC contract、Zod、React、React Flow、Vitest、Testing Library、CSS Modules。

---

## 文件结构

- `packages/workspace/workspace/src/index.ts` 负责原子修改归档成员关系。
- `packages/host/apiproxy` 的 Workspace API、schema、dispatch 与 proxy 文件负责逆向 RPC。
- `packages/client/connection/src/client/fixture.ts` 为浏览器 fixture 镜像 Host 行为。
- `packages/client/runtime/src/client/workspaces` 负责安装完整归档集合并暴露恢复操作。
- `packages/client/ui-workspace/src/client/archived.ts` 单独派生归档分组。
- `packages/client/ui-workspace/src/client/ArchivedSessionsView.tsx` 负责过滤、单行 pending、重试错误与恢复。
- `packages/client/ui-contextify/src/client/store.ts` 区分可见 selection 与完整 family 位置保留。
- 现有 package README 与 Session archive Agent Note 记录发布后的 contract 与 rationale。

### 任务 1：Workspace domain 逆操作

**文件：**
- 修改：`packages/workspace/workspace/tests/workspace.spec.ts`
- 修改：`packages/workspace/workspace/src/index.ts`

- [ ] **步骤 1：先写持久性、幂等、可用性和顺序测试**

在 `registry-global session archive` 附近使用现有 helper：

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

再覆盖：重复恢复不增加 global-state change；已归档 header 从 persistence listing 消失时恢复失败且集合不变；`unarchive → archive` 最终归档，`archive → unarchive` 最终恢复。

- [ ] **步骤 2：运行 focused test 并确认 RED**

~~~bash
pnpm exec vitest run packages/workspace/workspace/tests/workspace.spec.ts -t 'restore|unarchive|ordered'
~~~

预期：`WorkspaceRegistry.unarchiveSession` 不存在而失败。

- [ ] **步骤 3：实现串行逆操作**

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

Public JSDoc 明确：只恢复可见性、不改变日志／谱系／Workspace 记账，非成员为幂等 no-op。

- [ ] **步骤 4：运行 Workspace package 测试并确认 GREEN**

~~~bash
pnpm exec vitest run packages/workspace/workspace/tests/workspace.spec.ts packages/workspace/workspace/tests/invariant.spec.ts
~~~

- [ ] **步骤 5：提交**

~~~bash
git add packages/workspace/workspace/src/index.ts packages/workspace/workspace/tests/workspace.spec.ts
git commit -m "feat(workspace): restore archived sessions"
~~~

### 任务 2：RPC、schema、Host 执行与 stream 行为

**文件：**
- 修改：`packages/host/apiproxy/src/api/workspace.ts`
- 修改：`packages/host/apiproxy/src/api/workspace.schema.ts`
- 修改：`packages/host/apiproxy/src/api/rpc-map.ts`
- 修改：`packages/host/apiproxy/src/fetch/handler.ts`
- 修改：`packages/host/apiproxy/src/fetch/client.ts`
- 修改：`packages/host/apiproxy/src/api-proxy.ts`
- 修改：`packages/host/apiproxy/tests/rpc-schemas.spec.ts`
- 修改：`packages/host/apiproxy/tests/api-proxy-workspace.spec.ts`
- 修改：`packages/host/apiproxy/tests/client-handler.spec.ts`
- 修改：`packages/host/apiproxy/tests/fetch-carrier.spec.ts`

- [ ] **步骤 1：先写 schema 与 assembled Host 测试**

加入 `workspace.unarchiveSession` request/value parse 断言；扩展真实 API archive 测试，恢复同一 Session、观察一次完整快照帧、确认 Workspace 记账不变、重复恢复不发第二帧，并验证不可用的已归档 Session 返回 `session-not-found` 且仍保持归档。

- [ ] **步骤 2：运行 Host 测试并确认 RED**

~~~bash
pnpm exec vitest run packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/api-proxy-workspace.spec.ts -t 'archive|unarchive|restore'
~~~

- [ ] **步骤 3：加入 typed method 与 Zod schema**

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

- [ ] **步骤 4：补齐所有 closed dispatch table**

在 `RpcMethodMap`、fetch handler、response schema table、`IApiClient.workspace`、`callUnary` 和测试内所有 literal `WorkspaceApi` fake 中加入 `workspace.unarchiveSession`。

- [ ] **步骤 5：实现 Host 错误映射与完整集合响应**

调用 `ctx.workspaceRegistry.unarchiveSession(sessionId)`；仅把 `WorkspaceUnknownSessionError` 映射为带 `details.sessionId` 的 `session-not-found`，其他持久化错误继续抛出；成功返回当前完整归档集合。不新增帧类型，既有 domain-state comparison 同时覆盖添加与删除。

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

- [ ] **步骤 6：运行 Host 测试并确认 GREEN**

~~~bash
pnpm exec vitest run packages/host/apiproxy/tests/rpc-schemas.spec.ts packages/host/apiproxy/tests/api-proxy-workspace.spec.ts packages/host/apiproxy/tests/client-handler.spec.ts packages/host/apiproxy/tests/fetch-carrier.spec.ts
~~~

- [ ] **步骤 7：提交**

~~~bash
git add packages/host/apiproxy
git commit -m "feat(host): expose session archive restore"
~~~

### 任务 3：Client fixture 与 Workspace runtime

**文件：**
- 修改：`packages/client/connection/src/client/fixture.ts`
- 修改：`packages/client/connection/tests/fake-api.client.ts`
- 修改：`packages/client/runtime/tests/fake-api.client.ts`
- 修改：`packages/client/runtime/tests/workspaces-service.client.spec.ts`
- 修改：`packages/client/runtime/src/client/contract/workspaces.ts`
- 修改：`packages/client/runtime/src/client/workspaces/manager.ts`
- 修改：`packages/client/runtime/src/client/workspaces/service.ts`

- [ ] **步骤 1：先写 echo、错误、selection 与过期 baseline 测试**

Fake API 返回删除一个 ID 后的完整集合，断言 RPC payload、安装后的 snapshot 和当前 Session 不变。启动 in-flight `workspace.list`，安装较新的恢复 echo，再让旧 list 返回较大的旧集合，断言恢复结果不被覆盖；失败响应必须保留旧集合。

- [ ] **步骤 2：运行 runtime 测试并确认 RED**

~~~bash
pnpm exec vitest run packages/client/runtime/tests/workspaces-service.client.spec.ts -t 'archive|unarchive|restore|stale'
~~~

- [ ] **步骤 3：实现 fixture 删除语义**

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

加入 dispatch switch 与两套 typed fake API method。

- [ ] **步骤 4：实现 manager、service 与 public contract**

Manager 调用 `api.workspace.unarchiveSession`，成功时使用既有 `installArchived`；Runtime 把失败包装为 `session restore failed`。不得打开 Session 或改变 selection。

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

- [ ] **步骤 5：运行 runtime 与 fixture 测试并确认 GREEN**

~~~bash
pnpm exec vitest run packages/client/runtime/tests/workspaces-service.client.spec.ts packages/client/connection/tests/fixture.client.spec.ts packages/client/connection/tests/fixture-commands.client.spec.ts
~~~

- [ ] **步骤 6：提交**

~~~bash
git add packages/client/runtime packages/client/connection
git commit -m "feat(client): restore archived session state"
~~~

### 任务 4：纯归档列表 projection

**文件：**
- 创建：`packages/client/ui-workspace/src/client/archived.ts`
- 创建：`packages/client/ui-workspace/tests/archived.client.spec.ts`

- [ ] **步骤 1：先写 projection 测试**

覆盖最近归档优先、当前 Workspace 分组、Workspace 删除后的 Ungrouped、父标题、标题过滤和缺失 summary 的 ID 回退。

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

- [ ] **步骤 2：运行 projection test 并确认 RED**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/archived.client.spec.ts
~~~

- [ ] **步骤 3：实现独立 view type 与 derivation**

创建 `ArchivedSessionRow`、`ArchivedSessionGroup` 与 `deriveArchivedGroups(list, workspaces, archivedSessionIds, query)`。构建 Workspace-by-Session index，反向遍历 Host 归档顺序，以 `displayTitle ?? id` 回退，只从可用 summary 解析父标题，按 trim 后的小写 query 过滤，并按 Host Workspace 顺序加末尾 Ungrouped。不要构造归档树。

~~~text
export function deriveArchivedGroups(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  archivedSessionIds: readonly SessionId[],
  query: string,
): ArchivedSessionGroup[]
~~~

- [ ] **步骤 4：运行 test 并确认 GREEN**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/archived.client.spec.ts
~~~

- [ ] **步骤 5：提交**

~~~bash
git add packages/client/ui-workspace/src/client/archived.ts packages/client/ui-workspace/tests/archived.client.spec.ts
git commit -m "feat(ui-workspace): derive archived session groups"
~~~

### 任务 5：已归档 Session 侧边栏子视图

**文件：**
- 创建：`packages/client/ui-workspace/src/client/ArchivedSessionsView.tsx`
- 创建：`packages/client/ui-workspace/src/client/ArchivedSessionsView.module.css`
- 修改：`packages/client/ui-workspace/src/css-modules.d.ts`
- 修改：`packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`
- 修改：`packages/client/ui-workspace/src/client/WorkspaceBrowser.module.css`
- 修改：`packages/client/ui-workspace/src/client/contract/slots.ts`
- 修改：`packages/client/ui-workspace/src/client/index.ts`
- 修改：`packages/client/ui-workspace/src/client/locales.ts`
- 修改：`packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx`
- 修改：`packages/client/ui-workspace/tests/apply.client.spec.ts`

- [ ] **步骤 1：先写产品流组件测试**

断言带数量的归档按钮打开子视图、行显示 Workspace 与父分支信息、Restore 调用正确 ID 且不调用 `open`。再覆盖本地过滤、Back、单行 pending、失败与成功重试、只有权威集合 rerender 后才移除行、Workspace 删除到 Ungrouped、缺失 summary ID。

- [ ] **步骤 2：运行 browser 测试并确认 RED**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx packages/client/ui-workspace/tests/apply.client.spec.ts
~~~

- [ ] **步骤 3：加入 injected restore action 与双语 copy**

Contract 增加 `restoreSession(sessionId): Promise<void>`，registration 绑定 `ctx.workspaces.unarchiveSession`。中英文 key 覆盖控件、标题、Back、过滤、空状态、父分支、Restore、pending 与错误。

- [ ] **步骤 4：实现 `ArchivedSessionsView`**

使用 `deriveArchivedGroups`、受控 query、`Set<SessionId>` pending 和按 ID 保存的错误。只禁用 pending 行；成功后仍等待父组件提供新集合才删除；错误使用 `role="alert"`；不得绑定 open 行为。

- [ ] **步骤 5：集成 browser 导航与数量**

`WorkspaceBrowser` 增加 `archiveViewOpen`。Wide mode 使用 `IconArchiveOutline20` Header 控件显示数量；打开后以归档子视图替代普通 search/tree；Back 不改变 grouping、search、order 或当前 Session；rail 保持既有行为。

- [ ] **步骤 6：运行 UI 测试并确认 GREEN**

~~~bash
pnpm exec vitest run packages/client/ui-workspace/tests/archived.client.spec.ts packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx packages/client/ui-workspace/tests/apply.client.spec.ts packages/client/ui-workspace/tests/browser-styles.client.spec.ts
~~~

- [ ] **步骤 7：提交**

~~~bash
git add packages/client/ui-workspace
git commit -m "feat(ui-workspace): list and restore archived sessions"
~~~

### 任务 6：Context Map 可见性与位置 reconciliation

**文件：**
- 修改：`packages/client/ui-contextify/src/client/store.ts`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 创建：`packages/client/ui-contextify/tests/store.client.spec.ts`
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **步骤 1：先写 store 与重新投影测试**

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

Panel 测试隐藏 archived root-only 节点，在完整 graph 中加入后代消息与 branch，再用空归档集合 rerender；断言原 owner、edge、后续节点与 position 恢复，隐藏 selection 不恢复。

- [ ] **步骤 2：运行 Context Map 测试并确认 RED**

~~~bash
pnpm exec vitest run packages/client/ui-contextify/tests/store.client.spec.ts packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx -t 'archive|restore|position|selection'
~~~

- [ ] **步骤 3：拆分 reconciliation 语义**

用 `reconcileNodeIds(draft, visibleNodeIds, familyNodeIds)` 替代 `retainNodeIds`：selection 只保留 visible set，position 只要仍在完整 family set 就保留。

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

- [ ] **步骤 4：Panel 同时按照两个 graph 清理**

~~~text
useEffect(() => {
  actions.reconcileNodeIds(
    records.map(node => node.id),
    snapshot.graph?.nodes.map(node => node.id) ?? [],
  )
}, [actions, records, snapshot.graph])
~~~

保留 `projectUnarchivedContextFamily`，因为它已经维持稳定 node ID 并从完整 graph 重投影。

- [ ] **步骤 5：运行 Context Map 测试并确认 GREEN**

~~~bash
pnpm exec vitest run packages/client/ui-contextify/tests/store.client.spec.ts packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
~~~

- [ ] **步骤 6：提交**

~~~bash
git add packages/client/ui-contextify
git commit -m "fix(ui-contextify): preserve map layout across archive restore"
~~~

### 任务 7：文档、assembled regression 与最终验证

**文件：**
- 修改：`.agents/notes/implemented/feature/2026-07-31-session-archive-global-set.*`
- 修改：`packages/workspace/workspace/README.md` 和 `README.zh.md`
- 修改：`packages/host/apiproxy/README.md` 和 `README.zh.md`
- 修改：`packages/client/runtime/README.md` 和 `README.zh.md`
- 修改：`packages/client/ui-workspace/README.md` 和 `README.zh.md`
- 修改：`packages/client/ui-contextify/README.md` 和 `README.zh.md`
- 修改：`packages/client/connection/tests/fixture.client.spec.ts`

- [ ] **步骤 1：加入无密钥 assembled regression**

通过 fixture 真实 public entry 创建 parent 与 fork child，归档 parent，加入后续 child 状态，再恢复 parent；断言归档集合删除 parent，child 仍保留同一个 `parentId`。不得直接修改 runtime store。

- [ ] **步骤 2：运行 assembled regression**

~~~bash
pnpm exec vitest run packages/client/connection/tests/fixture.client.spec.ts -t 'archive restore'
~~~

- [ ] **步骤 3：更新 current-state 文档**

把现有 Agent Note 从 future restore 更新为已发布的对称操作、列表 UI、幂等、当前记账位置和完整集合冲突语义；把归档时 snapshot 记录为 rejected alternative。各 README 只写本层 contract，中英文同步更新，并为每个 pair 重新运行 `verify-translation-pairing --write`。

- [ ] **步骤 4：运行 focused verification**

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

- [ ] **步骤 5：运行本地 App browser verification**

归档 parent，继续可见 child，创建另一个 child branch，从归档列表恢复 parent；确认 Chat 不切换，然后打开恢复的 parent，确认 Map 包含恢复路径、后续后代变化与保存的拖拽位置。

- [ ] **步骤 6：提交文档与最终 regression**

~~~bash
git add .agents/notes/implemented/feature/2026-07-31-session-archive-global-set* \
  packages/workspace/workspace/README.md packages/workspace/workspace/README.zh.md \
  packages/host/apiproxy/README.md packages/host/apiproxy/README.zh.md \
  packages/client/runtime/README.md packages/client/runtime/README.zh.md \
  packages/client/ui-workspace/README.md packages/client/ui-workspace/README.zh.md \
  packages/client/ui-contextify/README.md packages/client/ui-contextify/README.zh.md \
  packages/client/connection/tests/fixture.client.spec.ts
git commit -m "docs: document session archive restoration"
~~~

## 最终验收审计

- [ ] Restore 只改变 `archivedSessionIds` 成员关系。
- [ ] 重复恢复、跨标签页、过期 baseline 与 archive／restore 顺序都收敛到 Host snapshot。
- [ ] Workspace 删除产生 Ungrouped；当前记账优先于归档时位置。
- [ ] 归档期间新增后代消息和分支后，parent／child identity 与 Context Plan 仍保持。
- [ ] Restore 不打开 Session，也不抢占当前 Chat selection。
- [ ] 归档列表错误可重试，pending 为单行状态。
- [ ] 隐藏 Map 节点退出 batch selection，但只要仍在完整 family 中就保留位置。
- [ ] 声明完成前取得 focused tests、typecheck、lint、双语 pairing 与 whitespace 的新鲜通过证据。

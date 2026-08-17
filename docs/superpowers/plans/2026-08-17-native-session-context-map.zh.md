# 本机 Session Context Map 实施计划

[English](2026-08-17-native-session-context-map.md) | 中文

> **对于代理工作人员：** 所需的子技能：使用超级权力：子代理驱动开发（推荐）或超级权力：执行计划来逐个任务地实施该计划。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标：** 将 Contextify 的相同 Session 虚拟分支替换为本机 Session 分叉的真实图，并让 Chat 和 Context Map 控制一个持久消息级 Context Plan。

**架构：** `@deepseek-ai/dsh-contextify` 通过持久性检查投射 Session 系列，并仅在活动 Session 中存储修订后的上下文选择。在 Context Plan 选择跨分支消息之前，跨分支消息将成为本地 `context/compiler-snapshot` 事件。浏览器移植独立的 Context Map 的 React Flow 和 Dagre 交互模型，而本机 Session 服务仍然负责分叉、沿袭和导航。

**技术堆栈：** TypeScript 6、Cordis 服务、Harness 仅附加 Session 事件、Typert Remote、React 18、`@xyflow/react`、Dagre、CSS 模块、Vitest、测试库、Playwright。

---

## 文件结构

- `packages/context/context-compiler/src/index.ts`：通用持久编译器快照事件和验证。
- `packages/context/contextify/src/types.ts`：本机系列、规范消息、Context Plan 和 Remote 结果类型。
- `packages/context/contextify/src/family.ts`：纯谱系和规范消息投影。
- `packages/context/contextify/src/plan.ts`：纯计划折叠、突变历史和编译器选择。
- `packages/context/contextify/src/index.ts`：Cordis 服务、持久性读取、Remote 方法、编译器注册和子级重置。
- `packages/client/ui-workspace/src/client/tree.ts`：递归 Workspace/Session 树投影。
- `packages/client/ui-contextify/src/client/controller.ts`：由图和 Chat 操作共享的应用拥有的可观察缓存。
- `packages/client/ui-contextify/src/client/store.ts`：仅图形查看状态。
- `packages/client/ui-contextify/src/client/ContextMapNode.tsx`：一个消息节点渲染器。
- `packages/client/ui-contextify/src/client/layout.ts`：Dagre 树、思维导图和时间线放置。
- `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`：React Flow 画布和控件。
- `packages/client/ui-contextify/src/client/ContextMessageAction.tsx`：Chat 端 Natural、Include、Exclude 和定位操作。
- `packages/client/ui-conversation/src/client/chat/MessageItem.tsx`：对最终用户消息执行本机 Branch 操作。
- `apps/web/tests/contextify-map.e2e.ts`：重放支持的本机分叉和模型输入证明。

### 任务 1：持久编译器快照事件

**文件：**
- 修改：`packages/context/context-compiler/src/index.ts`
- 修改：`packages/context/context-compiler/tests/registry.spec.ts`
- 修改：`packages/context/context-compiler/README.md`
- 修改：`packages/context/context-compiler/README.zh.md`

- [ ] **第 1 步：编写失败的注册表测试**

添加附加和选择本地快照事件的测试，并拒绝丢失或重复的选定事件序列：

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

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/context/context-compiler/tests/registry.spec.ts`

预期：TypeScript 或运行时失败，因为 `context/compiler-snapshot` 未注册并且注册表拒绝其事件类型。

- [ ] **第 3 步：添加事件和精确解析器**

添加此声明并在三种表面消息类型旁边的 `compile()` 中解析它：

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

在现有编译循环中使用 `selectedMessage(request.session, seq)`。保持 `eventSeqs` 重复项和边界检查不变。

- [ ] **第 4 步：验证 GREEN 和文档**

运行：`pnpm exec vitest run packages/context/context-compiler/tests/registry.spec.ts`

预期：所有注册表测试均通过。更新两个自述文件以声明快照事件仅在日志中显示，仅当编译器选择它们时模型才可见，并且永远不要加入 `Session.surface`。

- [ ] **第 5 步：承诺**

```bash
git add packages/context/context-compiler
git commit -m "feat: add durable context compiler snapshots"
```

### 任务 2：本机 Session 系列投影

**文件：**
- 创建：`packages/context/contextify/src/family.ts`
- 修改：`packages/context/contextify/src/types.ts`
- 创建：`packages/context/contextify/tests/family.spec.ts`

- [ ] **第 1 步：编写失败的投影测试**

为根、两个子代、一个孙子和一个空子代创建固定装置。断言继承的消息共享节点 ID，本地消息由子节点拥有，推理和工具不创建节点，并且两个子边缘留下规范的分叉消息：

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

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/context/contextify/tests/family.spec.ts`

预期：缺少 `family.ts` 投影的导入失败。

- [ ] **步骤 3：定义原生家庭类型**

将 `ContextPath`、`ContextRoute` 和 `pathId` 图形类型替换为：

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

- [ ] **第4步：实现纯投影**

使用以下规则在 `SessionInspection[]` 上实施 `projectSessionFamily({ activeSessionId, sessions })`：

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

按祖先优先的顺序遍历每个族 Session，按 `${owner.sessionId}:${owner.seq}` 合并节点，按源 ID 和目标 ID 合并连续的可见消息边，并记录遍历每个节点或边的每个 Session。冻结返回的数组和记录。

- [ ] **第5步：验证绿色并提交**

运行：`pnpm exec vitest run packages/context/contextify/tests/family.spec.ts`

```bash
git add packages/context/contextify/src/family.ts packages/context/contextify/src/types.ts packages/context/contextify/tests/family.spec.ts
git commit -m "feat: project native Session families"
```

### 任务 3：修订 Context Plan 和编译器

**文件：**
- 创建：`packages/context/contextify/src/plan.ts`
- 修改：`packages/context/contextify/src/types.ts`
- 替换：`packages/context/contextify/tests/compiler.spec.ts`

- [ ] **第 1 步：编写失败计划和编译器测试**

涵盖 Natural 选择、当前路径 Exclude、同级快照 Include、当前轮保护、重置、撤消、重做以及删除每个虚拟路径事件：

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

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/context/contextify/tests/compiler.spec.ts`

预期：失败，因为当前编译器仍派生相同的 Session 虚拟路径并且新计划字段不存在。

- [ ] **步骤 3：定义第二版计划**

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

`createInitialContextPlan()` 返回修订版和状态修订版 `1`、空历史记录和空选择。完全删除 `contextify/route` 事件声明。

- [ ] **步骤 4：实现纯选择和历史转换**

`compileContextify()` 从 `session.surface.nodes` 开始，删除排除的事件序列，按升序 `position` 插入包含的快照序列，然后恢复属于当前回合的每个表面消息。将工具调用和结果作为一组关闭。导出纯 `nextPlan`、`undoPlan`、`redoPlan` 和 `resetPlan` 帮助程序；每个都返回一个新的完整快照并且从不编辑早期的对象。

突变助手使用这个精确的历史更新：

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

撤消和重做从同一 Session 中的早期 `contextify/plan` 事件中解析 `stateRevision`，并附加包含更新的 `past` 和 `future` 数组的复制状态。

- [ ] **第5步：验证绿色并提交**

运行：`pnpm exec vitest run packages/context/contextify/tests/compiler.spec.ts`

```bash
git add packages/context/contextify/src packages/context/contextify/tests/compiler.spec.ts
git commit -m "feat: compile revisioned native context plans"
```

### 任务 4：通过持久性支持的 Session 系列提供 Contextify 服务

**文件：**
- 修改：`packages/context/contextify/src/index.ts`
- 修改：`packages/context/contextify/package.json`
- 修改：`packages/context/contextify/tsconfig.json`
- 替换：`packages/context/contextify/tests/service.spec.ts`
- 修改：`packages/context/contextify/src/invariant.ts`

- [ ] **第 1 步：编写失败的服务测试**

构建真实的 `SessionStore`、Context Compiler 注册表、Agent 注册表以及包含一个根和两个子项的假 `SessionPersistence`。断言 `familyPage()` 返回一个已删除重复的系列，Include 附加快照然后计划，跨系列 Include 不附加任何内容，过时的修订不附加任何内容，并且新的分叉子项会重置 `agent/session-start` 上的继承选择。

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

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/context/contextify/tests/service.spec.ts`

预期：失败，因为当前服务公开虚拟路径 RPC 方法并且无法检查持久同级。

- [ ] **第3步：替换服务API**

使用 `static inject = ['agents', 'sessions', 'sessionPersistence', 'contextCompiler']`。将 `createBranch`、`selectPath` 和 `returnToMainline` 替换为：

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

`familyPage()` 将 `ctx.sessions.list()` 快照与 `ctx.sessionPersistence.list()` 和 `inspect()` 相结合，在持久副本上选择实时 Session 事件，仅投影活动根系列，并按数字偏移量对冻结节点数组进行分页。 `setNodeMode()` 调用相同的投影，验证家庭成员资格和内容哈希，并仅针对有效的路径外 Include 在新计划之前附加 `context/compiler-snapshot`。

- [ ] **第4步：重置继承计划并注册编译器**

在 `agent/session-start` 上，如果不存在，则附加初始版本二计划。对于子项，当最新计划事件位于 `session.header.seedLength` 之前时，附加重置计划。选择 `contextify` 编译器，而不附加任何路由事件或前置步骤侦听器。

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

- [ ] **第5步：添加依赖项、不变式、验证和提交**

将 `@deepseek-ai/dsh-session-persistence` 添加到对等/开发依赖项及其项目引用。更新不变量以证明每个选定的快照序列都命名一个本地 `context/compiler-snapshot` 事件。

运行：`pnpm exec vitest run packages/context/contextify packages/context/context-compiler`

```bash
git add packages/context/contextify packages/context/context-compiler
git commit -m "feat: manage context across native Session families"
```

### 任务 5：递归可折叠 Workspace 和 Session 树

**文件：**
- 修改：`packages/client/ui-workspace/src/client/tree.ts`
- 修改：`packages/client/ui-workspace/src/client/stores.ts`
- 修改：`packages/client/ui-workspace/src/client/WorkspaceBrowser.tsx`
- 修改：`packages/client/ui-workspace/src/client/rows/Rows.tsx`
- 修改：`packages/client/ui-workspace/src/client/rows/Rows.module.css`
- 修改：`packages/client/ui-workspace/tests/tree.client.spec.ts`
- 修改：`packages/client/ui-workspace/tests/rows.client.spec.tsx`

- [ ] **第 1 步：编写失败的树测试**

断言 `root → child → grandchild` 排序、深度值 `0, 1, 2`、Workspace 帐户的同级排序、折叠子项省略以及不相关根的保留：

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

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/client/ui-workspace/tests/tree.client.spec.ts packages/client/ui-workspace/tests/rows.client.spec.tsx`

预期：当前投影返回深度为零处的每个 Session，并且没有 Session 崩溃控制。

- [ ] **第3步：实现递归投影和持久崩溃状态**

使用 `depth`、`hasChildren` 和 `expanded` 扩展 `SessionNode`。使用 `collapsedSessionIds` 扩展 `TreeView` 和 `WorkspaceViewState`。添加 `setSessionExpanded`，在 Session 存在时保留密钥。在每个 Workspace 组中，构建 `byId`、`children` 以及来自 `parentSessionId` 的根列表；递归地发出子级，除非其父级 ID 已折叠。孤儿在根部发射，循环在根部深度发射一次。

- [ ] **第 4 步：渲染和测试 V 形**

将 `toggleSession` 传递到 `SessionNodeItem`。仅为 `hasChildren` 渲染 V 形按钮，按 `depth * 16px` 缩进，并防止 V 形单击打开 Session。添加可访问标签 `Collapse <title>` 和 `Expand <title>`。

运行：`pnpm exec vitest run packages/client/ui-workspace/tests`

- [ ] **第 5 步：承诺**

```bash
git add packages/client/ui-workspace
git commit -m "feat: nest native Session forks in Workspace tree"
```

### 任务 6：通过完成的回合从用户和助理消息中获取 Branch

**文件：**
- 修改：`packages/client/ui-conversation/src/client/chat/MessageItem.tsx`
- 修改：`packages/client/ui-conversation/src/client/chat/TurnTailNodeView.tsx`
- 修改：`packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`
- 修改：`packages/client/ui-conversation/src/client/contract/slots.ts`
- 修改：`packages/client/ui-conversation/tests/chat-view.client.spec.tsx`
- 修改：`packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`

- [ ] **步骤 1：编写失败的用户-Branch 测试**

替换用户气泡没有 Branch 操作的旧断言。单击用户消息上的 Branch 并断言 `forkAt()` 接收完整的 `turn/end` 序列，而助手按钮接收相同的边界。

```text
const buttons = view.getAllByRole('button', { name: '在新对话中分支' })
expect(buttons).toHaveLength(2)
fireEvent.click(buttons[0]!)
fireEvent.click(buttons[1]!)
expect(h.forkAt.mock.calls).toEqual([[3], [3]])
```

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/client/ui-conversation/tests/chat-view.client.spec.tsx -t "completed turn"`

预期：仅存在助手 Branch 按钮，并且它调用助手消息序列。

- [ ] **步骤 3：在回合边界解析 Branch**

传递来自 Chat 节点所有者数据的完整回合结束序列。 `UserMessageNodeView` 使用 `useSession` 来查找包含 `node.data.seq` 的 Turn，并且仅当该 Turn 具有持久结束并且没有后续的 Chat 节点时才公开 Branch。 `TurnTailNodeView` 通过 `turn.end.seq`。保留不完整或已关注内容的不可用行为。

- [ ] **第4步：验证绿色并提交**

运行：`pnpm exec vitest run packages/client/ui-conversation/tests`

```bash
git add packages/client/ui-conversation
git commit -m "feat: branch native Sessions from any completed message"
```

### 任务 7：React Flow Context Map 画布

**文件：**
- 修改：`packages/client/ui-contextify/package.json`
- 修改：`packages/client/ui-contextify/src/css-modules.d.ts`
- 创建：`packages/client/ui-contextify/src/client/layout.ts`
- 创建：`packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- 创建：`packages/client/ui-contextify/src/client/store.ts`
- 替换：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 替换：`packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- 替换：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **第 1 步：添加依赖项并编写失败的组件测试**

添加 `@xyflow/react`、`dagre` 和 `@types/dagre`。在组件测试中模拟 `ResizeObserver`。断言图形节点和边渲染、夹具合约中不存在工具/推理记录、结果之间的搜索前进、布局按钮调用所有三种布局模式、选择批处理操作调用突变，以及 Branch/Navigate/Locate 回调携带规范消息引用。

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

预期：垂直卡片面板没有 React Flow 画布、布局切换器、搜索或批量选择。

- [ ] **第3步：移植三种布局算法**

实施：

```text
export type ContextMapLayout = 'tree' | 'mindmap' | 'timeline'

export function layoutContextMap(
  nodes: readonly ContextGraphRecord[],
  edges: readonly ContextGraphEdge[],
  mode: ContextMapLayout,
): Node<ContextMapNodeData>[]
```

使用 Dagre `rankdir: 'TB'` 作为树，使用 `rankdir: 'LR'` 作为时间线。思维导图使用独立存储库的通道偏移规则，左右交替分配根族子通道。节点大小为`224 × 104`；布局仅更改坐标和手柄位置。

- [ ] **第 4 步：构建图形组件**

将 `<ReactFlow>` 与 `Background`、`Controls`、适合视图、平移/缩放、可拖动节点、多项选择和选取框结合使用。渲染具有角色、预览、Session 标签和 Natural/Included/Excluded 徽章的专用节点组件。添加搜索上一个/下一个、树/思维导图/时间轴选择器、重置、撤消、重做、关闭和批处理操作栏。仅保留 `layout`、面板选择和 `createContextMapStore()` 中的节点位置覆盖。

- [ ] **第5步：验证绿色并提交**

运行：`pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

```bash
git add packages/client/ui-contextify pnpm-lock.yaml
git commit -m "feat: render Context Map as an interactive graph"
```

### 任务 8：共享 Contextify 控制器和 Chat 上下文操作

**文件：**
- 创建：`packages/client/ui-contextify/src/client/controller.ts`
- 创建：`packages/client/ui-contextify/src/client/ContextMessageAction.tsx`
- 修改：`packages/client/ui-contextify/src/client/index.ts`
- 修改：`packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`
- 修改：`packages/client/ui-conversation/src/client/contract/slots.ts`
- 修改：`packages/client/ui-conversation/src/client/chat/MessageItem.tsx`
- 修改：`packages/client/ui-conversation/src/client/chat/TurnTailNodeView.tsx`

- [ ] **第 1 步：编写失败的组装测试**

声明用户和助理操作槽，安装插件，并断言一个控制器刷新会更新固定地图和 Chat 操作。断言图 Branch 调用 `sessions.fork({ sessionId: sourceSessionId, atSeq: turnEndSeq, increaseTitle: true })`，打开子项，并刷新系列。 Assert Navigate 调用 `sessions.open`，而 Locate 仅打开详细信息并聚焦节点。

- [ ] **第 2 步：验证红色**

运行：`pnpm exec vitest run packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

预期：该插件仍调用虚拟 `createBranch/selectPath` RPC 方法，并且不注册任何 Chat 操作贡献。

- [ ] **第 3 步：实现一个应用拥有的可观察控制器**

`ContextifyController` 为每个活动 Session 保留不可变快照，并公开稳定的 `getSnapshot`、`subscribe`、`refresh` 和突变方法。 `refresh()` 加载 `get` 以及每个 `familyPage`，合并并发请求并发布一次。突变方法使用当前计划修订版，等待 Remote 成功，然后刷新。仅当至少有一个订阅者存在时，1.5 秒计时器才会运行。

- [ ] **第4步：通过槽注册图形和消息操作**

通过以下方式扩展对话时段：

```text
'conversation.chat.user-actions': {
  kind: 'list'; scope: 'session'; owner: { seq: number }
}
'conversation.chat.assistant-actions': {
  kind: 'list'; scope: 'session'; owner: { messageId: MessageId; seq: number }
}
```

ui-contextify 插件将共享查看存储注册到固定面板中，并将 `ContextMessageAction` 注册到两个消息操作槽中。将控制器作为保留的 `hooks.contextify` 可观察对象注入。组件仅接收绑定的 `useContextify` 挂钩和普通回调。

- [ ] **第5步：验证绿色并提交**

运行：`pnpm exec vitest run packages/client/ui-contextify packages/client/ui-conversation`

```bash
git add packages/client/ui-contextify packages/client/ui-conversation
git commit -m "feat: synchronize Chat and Context Map controls"
```

### 任务 9：Remote 生成、文档和组装的浏览器证明

**文件：**
- 修改生成的输出：`packages/context/contextify/src/index.ts`
- 修改：`packages/context/contextify/README.md`
- 修改：`packages/context/contextify/README.zh.md`
- 修改：`packages/client/ui-contextify/README.md`
- 修改：`packages/client/ui-contextify/README.zh.md`
- 创建：`.agents/notes/proposed/feature/2026-08-17-native-session-context-map.md`
- 创建：`.agents/notes/proposed/feature/2026-08-17-native-session-context-map.zh.md`
- 创建：`.agents/notes/proposed/feature/2026-08-17-native-session-context-map.i18n.yaml`
- 替换：`apps/web/tests/contextify-map.e2e.ts`

- [ ] **第1步：编写失败的E2E场景**

使用重播脚手架创建根对话，分叉两个本机子 Session，向每个子附加一条子本地消息，打开右侧映射，并断言共享前缀重复数据删除、两个分支边、递归侧边栏行以及无工具/推理图节点。 Exclude 来自 Chat 的 Natural 消息，Include 来自图表的同级消息，重新加载，并断言两种状态都存在。提交子请求并检查模拟提供程序输入以获取确切的包含和排除文本。

- [ ] **第 2 步：验证红色**

运行：`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts`

预期：失败，因为当前 UI 将虚拟路径呈现为卡片，并且无法显示或编译同级 Session 消息。

- [ ] **步骤 3：生成 Remote 和文档工件**

跑步：

```bash
pnpm run gen-cordis-api
pnpm run gen-cordis-catalog
pnpm run gen-persistence-catalog
pnpm run gen-doc-graphs
pnpm run verify-translation-pairing --write packages/context/contextify/README.i18n.yaml
pnpm run verify-translation-pairing --write packages/client/ui-contextify/README.i18n.yaml
```

使用本机 Session 系列语义、模型可见快照效果、无跨映射导入、子计划重置以及编辑/删除/升级的仅附加替换来更新自述文件和 Agent 注释。

- [ ] **第四步：实现端到端绿色**

运行聚焦重播 E2E 直至其通过，然后运行 ​​`pnpm exec vitest run apps/web/tests/details-session-lifecycle.e2e.ts` 以保留固定详细信息生命周期。

- [ ] **第 5 步：承诺**

```bash
git add apps/web/tests packages/context/contextify packages/client/ui-contextify docs .agents/notes packages/api/remotes packages/extensions
git commit -m "test: prove native Session Context Map workflow"
```

### 任务 10：完成审核和完整验证阶梯

**文件：**
- 检查：`docs/superpowers/specs/2026-08-17-native-session-context-map-design.md`
- 检查：自提交以来更改的所有文件 `8c54571b1e`

- [ ] **第1步：证明虚拟分支词汇表的删除**

跑步：

```bash
rg -n "ContextPath|pathId|contextify/route|createBranch|selectPath|returnToMainline" \
  packages/context/contextify packages/client/ui-contextify apps/web/tests/contextify-map.e2e.ts
```

预期：没有生产或活动测试匹配。

- [ ] **第 2 步：运行重点检查和 GUI 检查**

```bash
pnpm exec vitest run packages/context/context-compiler packages/context/contextify
pnpm run test:gui
```

预期：所有测试均通过，没有警告或未处理的错误。

- [ ] **第 3 步：运行静态和文档检查**

```bash
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
git diff --check
```

预期：每个命令都为零。

- [ ] **第 4 步：运行组装的浏览器和生产版本检查**

```bash
DSH_SNAPSHOT=replay pnpm run test:web
pnpm run build:web
```

预期：重放支持的浏览器测试和生产 Web 构建过程。

- [ ] **步骤 5：审核所有十二项验收标准**

对于设计规范中的每个编号标准，记录源文件并进行测试或命令证明它。将任何缺失的证明视为未完成的工作，并添加最窄的测试来演示真正的组装行为。

- [ ] **第 6 步：提交验证修复**

```bash
git add -A
git commit -m "fix: complete native Session Context Map verification"
```

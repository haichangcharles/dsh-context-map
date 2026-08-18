# Context Map 画布交互实施计划

[English](2026-08-17-context-map-canvas-interactions.md) | 中文

> **面向 Agent 工作者：** 必须使用子技能：按任务逐项执行本计划时，使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤用复选框（`- [ ]`）语法跟踪。

**目标：** 恢复独立版 Context Map 的点击、多选、右键菜单、实时拖拽和 Chat 定位交互，同时让 Harness Context Plan 与原生 Session 保持权威。

**架构：** `ui-contextify` 管理临时画布手势，并通过现有注入 action face 委托持久变更。`ui-conversation` 增加一个窄的 Session 加序号 reveal controller，让 Contextify 能请求 Chat 导航，而无需查询其他包的 DOM。React Flow 每帧在本地应用拖拽变化，只将最终位置提交到现有 viewing store。

**技术栈：** React 19、TypeScript、`@xyflow/react`、Cordis 客户端服务与 slot、Vitest、Testing Library、CSS Modules。

---

## 文件结构

- 新建 `packages/client/ui-contextify/src/client/canvas-interactions.ts`：由面板和测试共享的纯模式循环与矩形相交规则。
- 新建 `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`：按指针定位、使用 Harness 后端 action 的右键菜单。
- 修改 `packages/client/ui-contextify/src/client/ContextMapPanel.tsx`：Normal/Selection 模式、自定义框选、批量栏、实时受控节点和右键菜单编排。
- 修改 `packages/client/ui-contextify/src/client/ContextMapNode.tsx`：卡片点击与右键事件上交，同时保留无障碍直接控件。
- 修改 `packages/client/ui-contextify/src/client/ContextMapPanel.module.css`：选择切换、框选、菜单、高亮和浮动操作栏样式。
- 新建 `packages/client/ui-conversation/src/client/chat/message-reveal.ts`：按 Session 隔离的一次性 reveal 请求注册表。
- 修改 `packages/client/ui-conversation/src/client/service.ts`：公开 `revealMessage(sessionId, seq)` 请求接口。
- 修改 `packages/client/ui-conversation/src/client/apply.ts`：把 reveal 注册表绑定到 Chat view 注入，并激活原生 Chat 标签。
- 修改 `packages/client/ui-conversation/src/client/contract/slots.ts`：ChatView 所需的强类型 reveal 订阅/消费属性。
- 修改 `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`：持久消息序号锚点。
- 修改 `packages/client/ui-conversation/src/client/chat/ChatView.tsx`：消费 reveal 请求、滚动和临时高亮。
- 修改 `packages/client/ui-conversation/src/client/chat/ChatView.module.css`：支持 reduced-motion 的 reveal 高亮动画。
- 修改 `packages/client/ui-contextify/src/client/index.ts`：把 Locate in Chat 路由到 `ctx.conversation.revealMessage`。
- 修改 `packages/client/ui-contextify/tests/` 与 `packages/client/ui-conversation/tests/` 中的聚焦测试；行为通过后更新两个包的 README 语言对和一份 Agent Note。

### 任务 1：证明并实现原版画布选择语义

**文件：**
- 新建：`packages/client/ui-contextify/src/client/canvas-interactions.ts`
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapNode.tsx`

- [ ] **步骤 1：编写失败的交互测试**

渲染一个 natural 的活动路径节点和一个 natural 的非路径节点，调用 React Flow 节点点击回调，并分别期望 `setNodeMode(owner, 'exclude')` 与 `setNodeMode(owner, 'include')`。再加入 Selection 模式测试：点击两个节点后，期望 viewing store 包含两个 ID，并且不发生 Context Plan 变更。

```ts ignore-check
fireEvent.click(screen.getByRole('button', { name: 'Selection mode' }))
fireEvent.click(screen.getByLabelText('User message: root'))
fireEvent.click(screen.getByLabelText('User message: branch'))
expect(store.store.getSnapshot().selectedNodeIds).toEqual([root.id, branch.id])
expect(actions.setNodeMode).not.toHaveBeenCalled()
```

- [ ] **步骤 2：运行聚焦测试并观察失败**

运行：`pnpm --filter @deepseek-ai/dsh-client-ui-contextify test -- context-map-panel.client.spec.tsx`

预期：失败，因为不存在 Selection 模式，卡片点击也不会调用模式变更。

- [ ] **步骤 3：增加纯循环与相交规则**

在 `canvas-interactions.ts` 中实现这些导出函数：

```ts
type ContextNodeMode = 'natural' | 'include' | 'exclude'

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

- [ ] **步骤 4：增加明确的 Normal 与 Selection 模式**

在面板本地 state 中保存 `interactionMode`。从面板向每个节点传递 `onActivate`。Normal 模式调用 `setNodeMode(record.owner, nextNodeMode(active, mode))`；Selection 模式只切换 viewing-store 选择。设置 React Flow 的 `nodesDraggable={interactionMode === 'normal'}`，并让 Selection 按钮暴露 `aria-pressed`。

- [ ] **步骤 5：运行聚焦测试并提交**

运行任务 1 的聚焦测试命令并期望通过。使用 `feat: restore Context Map node interactions` 提交。

### 任务 2：恢复可见的 Shift 框选与批量操作

**文件：**
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.module.css`

- [ ] **步骤 1：编写失败的框选测试**

在画布上模拟 Shift 指针按下、移动和抬起，并 mock 两个节点矩形。期望抬起前框选元素已更新，抬起后相交节点 ID 已切换。

```ts ignore-check
fireEvent.pointerDown(canvas, { shiftKey: true, clientX: 10, clientY: 10, pointerId: 1 })
fireEvent.pointerMove(canvas, { shiftKey: true, clientX: 220, clientY: 220, pointerId: 1 })
expect(screen.getByTestId('context-map-marquee')).toHaveStyle({ width: '210px', height: '210px' })
fireEvent.pointerUp(canvas, { shiftKey: true, clientX: 220, clientY: 220, pointerId: 1 })
expect(store.store.getSnapshot().selectedNodeIds).toContain(root.id)
```

- [ ] **步骤 2：运行测试并观察失败**

运行聚焦 Contextify 测试命令。预期：失败，因为面板把选择交给 React Flow，并且没有渲染自定义框选。

- [ ] **步骤 3：实现原版选择手势**

当 Selection 模式且 Shift 激活时，记录相对 React Flow 视口的指针原点，捕获指针，渲染绝对定位的框选，并使用 `instance.getNodes()` 与 `instance.flowToScreenPosition` 配合 `intersects` 检查节点矩形。指针抬起时，在一次 viewing-store 更新中切换所有命中 ID 并清除框选。普通 Selection 模式点击继续保持可累加。

- [ ] **步骤 4：保留 Harness 批量变更**

保留现有 `setNodeModes` action，但只在 Selection 模式显示浮动栏。Include、Exclude 和 Natural 对每个选中的原生消息 owner 提交一次变更。清除选择仍只影响展示。

- [ ] **步骤 5：运行聚焦测试并提交**

期望全部 Context Map 面板测试通过。使用 `feat: add Context Map marquee selection` 提交。

### 任务 3：恢复右键菜单与实时拖拽

**文件：**
- 新建：`packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.module.css`

- [ ] **步骤 1：编写失败的菜单与拖拽测试**

右键点击节点，断言菜单包含 Locate in Chat、Branch from Here、Natural、Include、Exclude。调用每个项目并断言现有注入 action。输入一个带 `dragging: true` 的 `position` 变更，断言受控节点位置立即变化而 viewing store 不变；再输入最终的 `dragging: false` 变更并断言已持久化。

- [ ] **步骤 2：运行测试并观察失败**

预期失败：没有右键菜单，受控节点在拖拽结束前仍保持布局位置。

- [ ] **步骤 3：实现菜单**

`ContextMapMenu` 接收 `{ x, y, record, mode, close, actions }`，渲染 `role="menu"` 并阻止事件冒泡。面板从节点 `onContextMenu` 打开它，在 Escape、画布点击、移动开始和 action 完成时关闭，并把它限制在面板边界内。

- [ ] **步骤 4：实现临时实时位置**

在面板 state 中维护临时 `Map<string, XYPosition>`。将每一次 React Flow 位置变更应用到该 Map。节点位置的解析顺序是：临时位置、持久化覆盖、布局位置。当 `dragging: false` 时，通过 `actions.setPosition` 持久化最终坐标，并删除对应临时条目。

```ts
type XYPosition = { readonly x: number; readonly y: number }
type PositionChange = {
  readonly type: 'position'
  readonly id: string
  readonly position?: XYPosition
  readonly dragging?: boolean
}
declare const change: PositionChange
declare const actions: { setPosition(id: string, position: XYPosition): void }
declare function setTransientPositions(
  update: (current: Map<string, XYPosition>) => Map<string, XYPosition>,
): void

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

- [ ] **步骤 5：运行测试并提交**

期望菜单、关闭和实时拖拽测试通过。使用 `feat: restore Context Map canvas menu and drag` 提交。

### 任务 4：增加原生 Chat 消息 reveal 契约

**文件：**
- 新建：`packages/client/ui-conversation/src/client/chat/message-reveal.ts`
- 修改：`packages/client/ui-conversation/tests/service-orchestration.client.spec.ts`
- 修改：`packages/client/ui-conversation/src/client/service.ts`
- 修改：`packages/client/ui-conversation/src/client/apply.ts`
- 修改：`packages/client/ui-conversation/src/client/contract/slots.ts`
- 修改：`packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`
- 修改：`packages/client/ui-conversation/src/client/chat/ChatView.tsx`
- 修改：`packages/client/ui-conversation/src/client/chat/ChatView.module.css`

- [ ] **步骤 1：编写失败的 reveal 注册表与 ChatView 测试**

证明目标行挂载前发出的请求仍可读取；匹配的 ChatView 使用 `block: 'center'` 滚动该行；该行获得 `data-chat-revealed`；消费只清除匹配的请求 ID。

```ts ignore-check
reveal.request(sessionId, 12)
expect(reveal.read(sessionId)?.seq).toBe(12)
renderChat({ reveal: reveal.binding(sessionId), messageSeq: 12 })
expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
```

- [ ] **步骤 2：运行测试并观察失败**

运行：`pnpm --filter @deepseek-ai/dsh-client-ui-conversation test -- service-orchestration.client.spec.ts`

预期：失败，因为 reveal 注册表、持久消息锚点和 ChatView effect 都不存在。

- [ ] **步骤 3：实现一次性注册表**

创建 `MessageRevealRegistry`，包含单调递增请求 ID、`request(sessionId, seq)`、`binding(sessionId)`、`read`、`subscribe` 和比较后清除的 `consume`。它只保存在浏览器内存中。

- [ ] **步骤 4：公开并绑定 conversation service action**

向 `IConversation` 添加 `revealMessage(sessionId: SessionId, seq: number): void`。controller 打开原生 Session 并发布 reveal 请求。`apply.ts` 构造一个注册表，向 ChatView 提供其 session binding，并在消费 reveal 之前把目标 Session store 切到原生 `chat` view。

- [ ] **步骤 5：锚定并显示精确消息**

在 `ChatNodeSeat` 中从用户消息节点数据和已完成助手节点数据派生持久序号，渲染 `data-chat-message-seq`，让 ChatView 无需拼接不安全 selector 即可定位该行。将其滚入视图、设置临时 reveal 状态、消费请求，并在 1.5 秒后移除高亮。添加 reduced-motion CSS。

- [ ] **步骤 6：运行聚焦测试并提交**

期望注册表与 ChatView reveal 测试以及现有 conversation 测试通过。使用 `feat: add Chat message reveal navigation` 提交。

### 任务 5：把 Context Map Locate 接入原生 Chat 并验证集成

**文件：**
- 修改：`packages/client/ui-contextify/src/client/index.ts`
- 修改：`packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`
- 修改：`packages/client/ui-contextify/README.md`
- 修改：`packages/client/ui-contextify/README.zh.md`
- 修改：`packages/client/ui-conversation/README.md`
- 修改：`packages/client/ui-conversation/README.zh.md`
- 新建：`.agents/notes/implemented/client/2026-08-17-context-map-canvas-interactions.md`

- [ ] **步骤 1：编写失败的插件接线测试**

调用 Map 节点的 Locate in Chat action，期望调用 `conversation.revealMessage(node.owner.sessionId, node.owner.seq)`，而不是 `controller.focus` 或直接访问 DOM。Chat-to-Map Locate 继续接到 `controller.focus`。

- [ ] **步骤 2：运行并观察接线失败**

运行聚焦 Contextify 浏览器插件测试。预期：失败，因为当前 Map Locate 只聚焦图。

- [ ] **步骤 3：通过原生 conversation service 接入 action**

把 `conversation` 加入 Contextify 注入要求，并将 Map 的 `locate` 实现为 `ctx.conversation.revealMessage(node.owner.sessionId, node.owner.seq)`。把 action 类型从节点 ID 改为完整 `ContextFamilyGraphNode`。从节点 chrome 删除冗余 Open 按钮；Session 导航仍可通过 Locate 与右键菜单使用。

- [ ] **步骤 4：更新包契约与 Agent Note**

在两个包的 README 语言对中记录原版画布手势、仅限 UI 的 viewing state 和 Session 加序号 reveal 接缝。记录 Contextify 为何把滚动委托给 conversation，以及为何临时拖拽状态不逐帧持久化。

- [ ] **步骤 5：运行聚焦包验证**

运行：

```bash
pnpm --filter @deepseek-ai/dsh-client-ui-contextify test
pnpm --filter @deepseek-ai/dsh-client-ui-conversation test
pnpm --filter @deepseek-ai/dsh-client-ui-contextify typecheck
pnpm --filter @deepseek-ai/dsh-client-ui-conversation typecheck
```

预期：所有命令通过。

- [ ] **步骤 6：运行装配 GUI 验证**

运行 `pnpm run test:gui`，然后运行 `DSH_SNAPSHOT=replay pnpm run test:web`，最后运行包 Agent Note 要求的相关 lint、文档和生产 Web 构建命令。预期：所有检查通过，replay 场景证明右键 Locate、多选、批量模式变更和实时节点移动。

- [ ] **步骤 7：提交已验证的集成**

使用 `test: verify Context Map canvas workflow` 提交实现文档和所有 replay fixture 变更。

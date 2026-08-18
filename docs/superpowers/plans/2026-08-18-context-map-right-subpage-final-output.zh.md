# Context Map 右栏子页与最终输出实施计划

[English](2026-08-18-context-map-right-subpage-final-output.md) | 中文

> **面向 Agent 工作者：** 必须使用子技能：按任务逐项执行本计划时，使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤用复选框（`- [ ]`）语法跟踪。

**目标：** 将 Context Map 变成原生详情栏中只采用树形布局的子页，并把每个 Session 轮次精简为真实输入和已完成的最终助手输出。

**架构：** `contextify/family.ts` 在 Session family 去重之前执行规范轮次投影。`ui-conversation` 管理通用的内存右栏页面路由，而 Contextify 只请求 pinned 页并保持为附加 slot 占用者。`ui-layout` 不做修改，继续管理原生栏和拖拽手柄。

**技术栈：** TypeScript、React、Cordis 作用域服务、Engine store、React Flow/Dagre、Vitest、Testing Library。

---

### 任务 1：只投影轮次输入与已完成的最终输出

**文件：**
- 修改：`packages/context/contextify/tests/family.spec.ts`
- 修改：`packages/context/contextify/src/family.ts`

- [ ] **步骤 1：编写失败的多步投影测试**

依次追加一个人类输入、一条中间助手文本、一个 Tool 结果、一条最终助手文本，以及 `turn/end { kind: 'completed' }`。断言图中预览仅等于输入和最终文本。在 `turn/end` 之前投影同一批事件，断言只出现输入。再加入一个以错误结束的轮次，断言其部分助手文本不会出现。

- [ ] **步骤 2：运行聚焦测试并确认 RED**

运行：

```bash
pnpm vitest run packages/context/contextify/tests/family.spec.ts
```

预期：失败，因为 `projectSessionFamily` 当前会发出每一个可见助手事件。

- [ ] **步骤 3：实现轮次级筛选**

用返回选定表面事件的辅助函数替代对 `visibleMessage` 的独立扫描。它应立即发出真实的人类输入，只保留当前轮最后一个可见助手候选，并且仅在匹配的 `turn/end` 原因是 `completed` 时提交该候选。选定事件继续进入现有的规范 owner、边、分支边界及去重逻辑。

- [ ] **步骤 4：运行 Contextify 测试并确认 GREEN**

运行：

```bash
pnpm vitest run packages/context/contextify/tests/family.spec.ts packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/compiler.spec.ts
```

预期：全部测试通过。

### 任务 2：从 Context Map 界面移除布局选择

**文件：**
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`

- [ ] **步骤 1：编写失败的仅树形界面测试**

断言不存在 `Context Map layout` 工具栏，也不存在名为 `tree layout`、`mindmap layout` 和 `timeline layout` 的按钮。渲染前把 store 设置为 `mindmap`，并断言图仍采用树形投影。

- [ ] **步骤 2：运行聚焦测试并确认 RED**

运行：

```bash
pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
```

预期：失败，因为当前会渲染三个布局按钮。

- [ ] **步骤 3：强制树形投影并移除模式控件**

停止订阅持久化布局值，调用 `layoutContextMap(..., 'tree')`，移除布局模式按钮组和模式属性/key，并保留 Select、Clear manual changes、Undo、Redo 作为普通图操作。

- [ ] **步骤 4：运行聚焦测试并确认 GREEN**

运行同一个 Vitest 命令，预期全部测试通过。

### 任务 3：把 Context Map 与 Tool 详情路由为原生子页

**文件：**
- 新建：`packages/client/ui-conversation/src/client/details-navigation.ts`
- 修改：`packages/client/ui-conversation/src/client/service.ts`
- 修改：`packages/client/ui-conversation/src/client/apply.ts`
- 修改：`packages/client/ui-conversation/src/client/contract/slots.ts`
- 修改：`packages/client/ui-conversation/src/client/skeleton/DetailsPanel.tsx`
- 修改：`packages/client/ui-conversation/src/client/skeleton/DetailsPanel.module.css`
- 修改：`packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`
- 修改：`packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`
- 修改：`packages/client/ui-contextify/src/client/index.ts`
- 修改：`packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **步骤 1：编写失败的导航和渲染测试**

测试：打开 Tool 详情时选择 Tool 页；`conversation.openPinnedDetails()` 选择 pinned 页但不清除 Tool 选择；DetailsPanel 只渲染被请求的页面；Contextify Locate 在打开原生详情栏之前请求 pinned 页。

- [ ] **步骤 2：运行聚焦测试并确认 RED**

运行：

```bash
pnpm vitest run packages/client/ui-conversation/tests/apply-inject.client.spec.tsx packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

预期：失败，因为还没有详情页注册表或子页标签。

- [ ] **步骤 3：实现按 Session 隔离的页面请求**

增加一个内存注册表，提供稳定快照 `{ page: 'pinned' | 'tool', revision }`、按 Session 隔离的订阅和幂等请求。向 `IConversation` 增加 `openPinnedDetails()`。Tool 检查请求 `tool`；Contextify 消息和图定位操作请求 `pinned`，并调用现有的 `ctx.layout.openDetails()`。

- [ ] **步骤 4：渲染互斥的原生子页**

存在 pinned entry 时，渲染包含 Context Map 和 Details 的双标签页头。没有 Tool 选择时禁用 Details。仅在 pinned 页渲染 `conversation.details.pinned`，仅在 Tool 页渲染现有 Tool drawer。保留原生栏关闭回调，不修改 `AppFrame` 或其手柄 CSS。

- [ ] **步骤 5：运行聚焦测试并确认 GREEN**

运行任务 3 的 Vitest 命令，预期全部测试通过。

### 任务 4：完整验证与文档

**文件：**
- 修改：仓库策略要求的相关包 `README.md`、`README.zh.md` 和 `Agent Note.md` 文件。

- [ ] **步骤 1：运行包回归测试**

```bash
pnpm vitest run packages/context/contextify/tests packages/client/ui-contextify/tests packages/client/ui-conversation/tests packages/client/ui-layout/tests
```

- [ ] **步骤 2：运行类型与 lint 检查**

```bash
pnpm run typecheck:contracts-ready
pnpm run lint:contracts-ready
```

- [ ] **步骤 3：运行真实浏览器验证**

打开 `http://127.0.0.1:3080/`，确认布局标签不存在，Context Map/Details 子页切换时不丢失选择，只出现最终助手输出，并且宽视口下原生详情调整手柄仍存在。

- [ ] **步骤 4：提交已验证的实现**

在 `git status --short` 和验证输出均干净后，仅暂存本次范围内的文件并使用明确的 feature 消息提交。

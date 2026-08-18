# 轨迹 Inspector 右侧栏实施计划

[English](2026-08-18-trajectory-inspector-right-sidebar.md) | 中文

> **面向 Agent 工作者：** 必须使用子技能：逐项执行本计划时，使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在 Harness 最右侧详情页中渲染原封不动的原生 Trajectory Inspector，同时保持 Context Map／详情手动切换。

**架构：** `ui-conversation` 增加通用的 Session 作用域 Inspector slot，并在 Context Map 可见时继续挂载其 host。`ui-trajectory` 为该 slot 注册稳定 host，并把现有 Inspector portal 到其中，从而保留 `TrajectoryTable` 当前 selection 和标签状态，不增加第二套 renderer，也不自动请求页面切换。

**技术栈：** React 18、TypeScript、Cordis scoped slots、Vitest、Testing Library、CSS modules。

---

### 任务 1：在右栏壳层增加原生 Inspector seat

**文件：**
- 修改：`packages/client/ui-conversation/src/client/contract/slots.ts`
- 修改：`packages/client/ui-conversation/src/client/apply.ts`
- 修改：`packages/client/ui-conversation/src/client/skeleton/DetailsPanel.tsx`
- 修改：`packages/client/ui-conversation/src/client/skeleton/DetailsPanel.module.css`
- 测试：`packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`
- 测试：`packages/client/ui-conversation/tests/apply-inject.client.spec.tsx`

- [x] **步骤 1：编写失败的 DetailsPanel 测试**

在 DetailsPanel 切换测试中增加 `conversation.details.inspector` 渲染结果。断言 Context Map 被选中时 Inspector host 保持挂载但隐藏；只有用户点击详情后才可见；点击不会修改 Tool selection。为新的 Session 作用域 single child slot 增加 apply 注册断言。

- [x] **步骤 2：运行聚焦测试并确认 RED**

运行：

```bash
pnpm vitest run packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx packages/client/ui-conversation/tests/apply-inject.client.spec.tsx
```

预期：失败，因为尚未声明或渲染 `conversation.details.inspector`。

- [x] **步骤 3：增加通用 Inspector slot 与稳定页面 host**

声明：

```text
const inspectorSlot = {
  kind: 'single',
  scope: 'session',
  owner: {} as Record<string, never>,
}
```

把它加入 DetailsSlotProps 和 details 注册的 child 声明。DetailsPanel 始终挂载 Inspector drawer，在 `activePage !== 'tool'` 时隐藏；新 slot 无占用者时退回现有 Tool drawer。Context Map 仍按条件渲染，保证同一时刻只有一个可见页面。增加 `.drawer[hidden] { display: none; }`。

- [x] **步骤 4：运行聚焦测试并确认 GREEN**

运行任务 1 的命令。预期：所有聚焦 conversation 测试通过。

### 任务 2：把现有 Trajectory Inspector portal 到 seat

**文件：**
- 新建：`packages/client/ui-trajectory/src/client/TrajectoryInspectorSeat.tsx`
- 新建：`packages/client/ui-trajectory/src/client/TrajectoryInspectorSeat.module.css`
- 修改：`packages/client/ui-trajectory/src/client/index.ts`
- 修改：`packages/client/ui-trajectory/src/client/TrajectoryView.tsx`
- 修改：`packages/client/ui-trajectory/src/client/TrajectoryTable.tsx`
- 修改：`packages/client/ui-trajectory/src/client/TrajectoryTable.module.css`
- 测试：`packages/client/ui-trajectory/tests/table.client.spec.tsx`
- 测试：`packages/client/ui-trajectory/tests/views.client.spec.tsx`

- [x] **步骤 1：编写失败的 portal 与注册测试**

用 Session 派生的 host ID 注册 DOM host，渲染包含一条可选记录的 TrajectoryTable，点击该行，断言：

```text
expect(view.queryByLabelText('Event details')).toBeNull()
expect(within(host).getByLabelText('Event details')).toBeTruthy()
```

同时断言选择前 host 显示空状态，且 `ui-trajectory` 为每个 Session 注册 `conversation.details.inspector`。

- [x] **步骤 2：运行聚焦 Trajectory 测试并确认 RED**

运行：

```bash
pnpm vitest run packages/client/ui-trajectory/tests/table.client.spec.tsx packages/client/ui-trajectory/tests/views.client.spec.tsx
```

预期：失败，因为尚无 Inspector seat 或 portal target。

- [x] **步骤 3：实现稳定的 Session host**

创建纯 host ID helper 与 seat 组件：

```text
export function trajectoryInspectorHostId(sessionId: SessionId): string {
  return `dsh-trajectory-inspector-${sessionId}`
}

export function TrajectoryInspectorSeat({ hostId }: { hostId: string }) {
  return <div id={hostId} className={css.root} data-trajectory-inspector-host="" />
}
```

向 `conversation.details.inspector` 注册该组件。把相同 host ID 注入 TrajectoryView，再传给 TrajectoryTable。

- [x] **步骤 4：不改变 selection 语义地迁移 Inspector**

使用 `useLayoutEffect` 在 commit 后解析 host，从 `react-dom` 导入 `createPortal`，用以下 portal 替换内部 Inspector sibling：

```text
{inspectorHost !== null && createPortal(inspectorContent, inspectorHost)}
```

没有选中项时在 host 中渲染中性空状态。只删除已经多余的内部 Inspector 宽度状态、resize pointer handlers 与内部 resize handle；保留记录／Request selection、标签历史、Hierarchy 导航、清空 selection、时间轴 selection 和 inspect handoff。外部 Inspector 使用 100% 宽高、无 max-width、无重复左边框。

- [x] **步骤 5：运行聚焦 Trajectory 测试并确认 GREEN**

运行任务 2 命令。预期：所有聚焦 Trajectory 测试通过。

### 任务 3：锁定“手动切换”实验不变量

**文件：**
- 测试：`packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`
- 测试：`packages/client/ui-trajectory/tests/table.client.spec.tsx`

- [x] **步骤 1：增加跨行为断言**

断言选择记录只改变 Trajectory selection 与 portal 内容，不调用 `showToolDetails`。断言 Context Map → 详情 → Context Map → 详情的切换会保留同一个 Inspector DOM、所选记录和当前内部标签。

- [x] **步骤 2：如存在隐藏 remount，确认 RED**

运行两组聚焦测试。预期：任何条件卸载或自动导航都会让保留断言失败。

- [x] **步骤 3：实施最小生命周期修正**

把 Inspector slot host 保持挂载在隐藏的详情 drawer 中，并使用稳定的 Session host ID。不得添加 selection 触发的页面导航调用。

- [x] **步骤 4：确认 GREEN**

运行两组聚焦测试。预期：全部通过。

### 任务 4：文档、回归、浏览器验证与提交

**文件：**
- 修改：`packages/client/ui-conversation/README.md`
- 修改：`packages/client/ui-conversation/README.zh.md`
- 修改：`packages/client/ui-conversation/README.i18n.yaml`
- 修改：`packages/client/ui-trajectory/README.md`
- 修改：`packages/client/ui-trajectory/README.zh.md`
- 修改：`packages/client/ui-trajectory/README.i18n.yaml`
- 修改：`docs/superpowers/specs/2026-08-18-trajectory-inspector-right-sidebar-design.md`
- 修改：`docs/superpowers/specs/2026-08-18-trajectory-inspector-right-sidebar-design.zh.md`
- 修改：`docs/superpowers/specs/2026-08-18-trajectory-inspector-right-sidebar-design.i18n.yaml`

- [x] **步骤 1：记录最终所有权和 portal bridge**

记录原生右栏拥有放置位置、Trajectory 拥有 Inspector 行为、selection 不进行页面导航，以及稳定 slot host 维持同一个 Inspector 实例。把设计架构从状态提升修订为更少实验变量的 slot-host portal。

- [x] **步骤 2：运行范围回归**

运行：

```bash
pnpm vitest run packages/client/ui-conversation/tests packages/client/ui-trajectory/tests packages/client/ui-layout/tests packages/client/ui-contextify/tests
pnpm run typecheck:contracts-ready
pnpm run lint:contracts-ready
git diff --check
```

预期：零失败。

- [x] **步骤 3：运行文档门禁**

记录翻译配对并运行 `pnpm run doc-sync`。预期：全部通过。

- [x] **步骤 4：验证真实浏览器流程**

在 `http://127.0.0.1:3080/` 的轨迹中选择 assistant 与 Tool。确认内部 Inspector 不再打开；Context Map 保持可见直到用户手动点击详情；详情显示所选原生 Inspector，内部标签可用，切页后 selection 保留。

- [x] **步骤 5：提交已验证实现**

```bash
git add packages/client/ui-conversation packages/client/ui-trajectory docs/superpowers
git commit -m "feat(trajectory): move inspector to right sidebar"
```

# Context Map 布局稳定性实施计划

[English](2026-08-18-context-map-layout-stability.md) | 中文

> **面向 agentic worker：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐项实施本计划。步骤使用 checkbox（`- [ ]`）追踪。

**目标：** 增加显式的确定性 graph 恢复功能，并阻止普通 Contextify refresh 重置用户的 React Flow viewport。

**架构：** 把自动 framing 拆成一次性的 initial-fit 路径和按 identity 触发的显式 focus 路径。Re-layout 复用持久 view store 的 position reset，清除 transient drag state，并在 React 提交确定性 tree position 后 frame 完整 graph。

**技术栈：** React 18、TypeScript、React Flow、Vitest、Testing Library、CSS modules。

---

### 任务 1：用失败测试固定 viewport 所有权

**文件：**
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [x] **步骤 1：增加 React Flow 测试 seam**

用一个带 imperative `fitView` spy 和 dimension change 触发器的组件 mock React Flow。继续渲染 node card，使测试仍然覆盖 `ContextMapPanel`，而不是单独的 helper。

- [x] **步骤 2：增加 viewport 回归测试**

触发两批 dimension change，并发布一份等价的 refreshed snapshot。断言第一批完成测量的 graph 只调用一次 `fitView`，后续 measurement 或 refresh 不会再次调用。

- [x] **步骤 3：增加 Re-layout 行为测试**

保存一个手动 node position，点击 `Re-layout`，断言 `positionOverrides` 清空，并且在 scheduled layout commit 后 `fitView` 收到完整 graph 请求。

- [x] **步骤 4：运行测试并确认 RED**

运行 `pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`。预期：viewport 回归报告重复 fit，且 Re-layout control 不存在。

### 任务 2：拆分 initial fit、focus 和用户 re-layout

**文件：**
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.module.css`

- [x] **步骤 1：为 initial fit 增加 gate**

用 component-local 的 one-shot gate 替换 measurement-version 驱动的 framing effect。Dimension change 可以宣布第一份 graph 已可测量，但后续 dimension change 不能再安排自动 full-graph fit。

- [x] **步骤 2：让显式 node focus 只按 identity 触发**

把 focused-node 和 active-search framing 移入按 target ID 与 React Flow instance 触发的 effect。轮询重新发布 graph 时，稳定 target 不能再次 refocus。

- [x] **步骤 3：实现 Re-layout**

增加 `Re-layout` toolbar button。激活时清除 transient position，调用 `actions.clearPositions()`，关闭 context menu，并在确定性 position render 后安排完整 graph 的 `fitView({ duration: 220 })`。

- [x] **步骤 4：运行聚焦测试并确认 GREEN**

运行 `pnpm vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`。预期：全部 Context Map panel 测试通过。

### 任务 3：记录延后的 Agent 机会并验证产品

**文件：**
- 新建：`packages/client/ui-contextify/FUTURE_WORK.md`
- 新建：`packages/client/ui-contextify/FUTURE_WORK.zh.md`
- 修改：`packages/client/ui-contextify/README.md`
- 修改：`packages/client/ui-contextify/README.zh.md`

- [x] **步骤 1：编写一份 future-work 清单**

记录三个延后方向及其用户决策、输出和安全边界：推荐 context selection、推荐 pruning，以及推荐 branch 或 main-line promotion。明确 durable mutation 前必须由用户显式 review 推荐结果。

- [x] **步骤 2：更新 package 行为文档**

在两种 package README 中记录 one-shot initial framing、稳定的 user viewport 和显式 Re-layout 行为。

- [x] **步骤 3：运行完整验证**

运行聚焦 Contextify test、client typecheck、client lint、documentation synchronization gate 和 `git diff --check`。

- [x] **步骤 4：在浏览器中验证**

放大一个 node，等待至少四秒，比较 React Flow transform，然后手动移动 node 后执行 Re-layout，确认完整的确定性 tree 恢复。

- [x] **步骤 5：提交已验证修改**

只暂存 Context Map 布局稳定性实现、测试、design、plan 和 future-work 文档。提交信息为 `fix(context-map): preserve viewport across refreshes`。

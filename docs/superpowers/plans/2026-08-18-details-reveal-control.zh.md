# 详情栏重新展开控件实施计划

[English](2026-08-18-details-reveal-control.md) | 中文

> **面向 Agent 工作者：** 必须使用子技能：按任务逐项执行本计划时，使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。步骤用复选框（`- [ ]`）语法跟踪。

**目标：** 在框架右侧边缘增加悬浮左箭头，让用户关闭 Context Map 或 Tool 详情后可以重新打开原生详情栏。

**架构：** `ui-layout/AppFrame` 根据最终栏宽状态渲染该控件，因此不会复制 Contextify 或 conversation 状态。按钮调用现有布局 action；最后选择的 Context Map/Tool 子页及所有功能状态继续保持挂载且不被改动。

**技术栈：** React 19、TypeScript、CSS Modules、Engine store、Vitest、Testing Library。

---

### 任务 1：增加原生详情栏重新展开按钮

**文件：**
- 修改：`packages/client/ui-layout/tests/app-frame.client.spec.tsx`
- 修改：`packages/client/ui-layout/tests/columns.client.spec.ts`
- 修改：`packages/client/ui-layout/src/client/AppFrame.tsx`
- 修改：`packages/client/ui-layout/src/client/AppFrame.module.css`
- 修改：`packages/client/ui-layout/src/client/columns.ts`

- [x] **步骤 1：编写失败的 AppFrame 交互测试**

增加测试：非 blank Session 的详情栏最终宽度为零时找到 `Open details panel`，点击后期望详情栏轨道变成 360px。断言按钮随后消失，详情栏调整尺寸手柄出现。再断言没有 Session 时按钮不存在，并增加 900px 框架用例，证明显式重新展开仍会给详情栏分配 300px 下限。

```tsx
const { frame, getByRole, queryByRole } = mountFrame()
fireEvent.click(getByRole('button', { name: 'Open details panel' }))
expect(tracks(frame)).toEqual([280, 360])
expect(queryByRole('button', { name: 'Open details panel' })).toBeNull()
expect(frame.querySelector('[data-side="details"]')).toBeTruthy()
```

- [x] **步骤 2：运行聚焦测试并确认 RED**

运行：

```bash
pnpm vitest run packages/client/ui-layout/tests/app-frame.client.spec.tsx
```

预期：失败，因为 AppFrame 还没有渲染名为 `Open details panel` 的按钮。

- [x] **步骤 3：实现最小重新展开控件**

在 AppFrame 中，仅当 `detailsSession !== undefined && cols.details === 0` 时渲染真实 button。设置 `aria-label="Open details panel"`，调用 `actions.openDetails`，并在 `aria-hidden` span 中渲染 `‹`。把它设计成右侧边缘垂直居中的悬浮胶囊，包含 hover 与 focus-visible 状态。保持 `DragHandle` 与 Contextify 状态不变。在 `columns.ts` 中，普通让步结束后仍让显式打开的详情栏保持自身宽度下限，并由中心栏吸收剩余缺口；只有极窄框架才会把详情栏压到其下限以下。

- [x] **步骤 4：运行聚焦测试并确认 GREEN**

运行步骤 2 的命令。预期：全部 AppFrame 测试通过。

### 任务 2：验证 Details 子页切换并记录该控件

**文件：**
- 修改：`packages/client/ui-layout/README.md`
- 修改：`packages/client/ui-layout/README.zh.md`
- 验证：`packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx`

- [x] **步骤 1：扩展并运行 Details 切换测试**

运行：

```bash
pnpm vitest run packages/client/ui-conversation/tests/gate-branch-tails.client.spec.tsx -t "switches pinned content and Tool details"
```

预期：通过，证明未选择 Tool 时 Details 也可点击并显示原生空状态；选择后切换页面仍保留 Tool 选择。

- [x] **步骤 2：更新布局 README 语言对**

记录：活动的非 blank Session 关闭原生详情栏后会显示悬浮左箭头；详情栏打开时由调整尺寸手柄取代它。同步更新两种语言并重新记录翻译配对。

- [x] **步骤 3：运行装配验证**

运行：

```bash
pnpm vitest run packages/client/ui-layout/tests packages/client/ui-conversation/tests packages/client/ui-contextify/tests
pnpm run typecheck:contracts-ready
pnpm run lint:contracts-ready
git diff --check
```

预期：所有测试和门禁通过。

- [x] **步骤 4：验证真实浏览器流程**

在 `http://127.0.0.1:3080/` 关闭 Context Map，断言悬浮左箭头出现；点击后断言 Context Map 重新展开。未选择 Tool 时点击 Details 子页，断言原生空状态引导替换 Context Map。

- [x] **步骤 5：提交已验证实现**

```bash
git add packages/client/ui-layout docs/superpowers/plans/2026-08-18-details-reveal-control*
git commit -m "feat(layout): add details reveal control"
```

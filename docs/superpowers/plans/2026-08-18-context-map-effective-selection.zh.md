# Context Map 有效上下文选择实施计划

[English](2026-08-18-context-map-effective-selection.md) | 中文

> **面向 Agent Worker：** 必须使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项执行本计划。步骤使用 checkbox（`- [ ]`）跟踪。

**目标：** 用有效上下文 checkbox 取代 Context Map 中并列的 Natural、Include 和 Exclude UI，同时保留原生 Context Plan 语义。

**架构：** 纯函数根据原生 Session 路径成员关系和存储的覆盖推导自动结果与有效结果。Context Map 只拥有乐观显示状态；所有提交仍调用现有 Contextify controller，回到自动结果时发送 Natural。Checkbox 事件与 React Flow 拖拽和画布选择隔离。

**技术栈：** TypeScript、React 18、React Flow、Vitest、Testing Library、Contextify Remote。

---

### 任务 1：定义有效上下文语义

**文件：**
- 修改：`packages/client/ui-contextify/src/client/canvas-interactions.ts`
- 测试：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **步骤 1：编写失败的 helper 测试**

增加断言：当前路径 Natural 为勾选，其他路径 Natural 为未勾选，手动覆盖反转结果，回到自动结果时解析为 Natural：

```ts
import { expect } from 'vitest'

type ContextNodeMode = 'natural' | 'include' | 'exclude'
declare function effectiveContextIncluded(active: boolean, mode: ContextNodeMode): boolean
declare function modeForEffectiveContext(active: boolean, included: boolean): ContextNodeMode

expect(effectiveContextIncluded(true, 'natural')).toBe(true)
expect(effectiveContextIncluded(false, 'natural')).toBe(false)
expect(effectiveContextIncluded(true, 'exclude')).toBe(false)
expect(effectiveContextIncluded(false, 'include')).toBe(true)
expect(modeForEffectiveContext(true, true)).toBe('natural')
expect(modeForEffectiveContext(true, false)).toBe('exclude')
expect(modeForEffectiveContext(false, false)).toBe('natural')
expect(modeForEffectiveContext(false, true)).toBe('include')
```

- [ ] **步骤 2：运行聚焦测试并确认 RED**

运行：`pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

预期：因为两个 helper 尚不存在而失败。

- [ ] **步骤 3：实现纯 helper**

用显式有效状态 helper 替换 `nextNodeMode`：

```ts
type ContextNodeMode = 'natural' | 'include' | 'exclude'

export function effectiveContextIncluded(active: boolean, mode: ContextNodeMode): boolean {
  if (mode === 'include') return true
  if (mode === 'exclude') return false
  return active
}

export function modeForEffectiveContext(active: boolean, included: boolean): ContextNodeMode {
  if (included === active) return 'natural'
  return included ? 'include' : 'exclude'
}
```

为两个 export 添加完整 `@param` 与 `@returns` JSDoc，同时修复被触及文件中已有的 helper JSDoc 违规。

- [ ] **步骤 4：运行聚焦测试并确认 GREEN**

运行步骤 2 命令，预期通过。

- [ ] **步骤 5：提交语义 helper**

```bash
git add packages/client/ui-contextify/src/client/canvas-interactions.ts packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git commit -m "refactor: derive effective Context Map selection"
```

### 任务 2：用隔离 checkbox 取代节点点击 mutation

**文件：**
- 修改：`packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- 测试：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **步骤 1：编写失败的 checkbox 交互测试**

断言自动勾选和未勾选节点、checkbox 发送 Exclude/Include、快照匹配后再次点击发送 Natural，以及 pointer/click 事件不会调用节点选择或拖拽。使用 deferred `setNodeMode` Promise 断言乐观状态、pending 禁用、失败回滚和可见错误。

```ts ignore-check
const checkbox = screen.getByRole('checkbox', { name: 'Include root requirement in model context' })
expect(checkbox).toBeChecked()
fireEvent.click(checkbox)
expect(h.mapActions.setNodeMode).toHaveBeenCalledWith({ sessionId: root, seq: 1 }, 'exclude')
expect(checkbox).not.toBeChecked()
expect(checkbox).toBeDisabled()
```

- [ ] **步骤 2：运行聚焦测试并确认 RED**

运行：`pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

预期：有效上下文 checkbox 不存在，并且卡片点击仍会修改 Plan。

- [ ] **步骤 3：实现 checkbox 数据与渲染**

为 `ContextMapNodeData` 添加有效 `included`、`pending` 和 `onToggle` 字段。渲染带有 `nodrag nopan` 的受控 checkbox，停止 pointer 和 click 冒泡，并在 `onChange` 中调用 `onToggle(record, event.currentTarget.checked)`。用 `data-in-context` 取代 `data-mode` 的透明度语义；节点主体点击只服务画布 Selection mode。

```tsx
<input
  type="checkbox"
  className={`${css.contextCheckbox} nodrag nopan`}
  aria-label={`${value.included ? 'Remove' : 'Include'} ${preview} ${value.included ? 'from' : 'in'} model context`}
  checked={value.included}
  disabled={value.pending}
  onPointerDown={(event) => { event.stopPropagation() }}
  onClick={(event) => { event.stopPropagation() }}
  onChange={(event) => { value.onToggle(record, event.currentTarget.checked) }}
/>
```

- [ ] **步骤 4：实现乐观 mutation 所有权**

在 `ContextMapPanel` 中保存单个乐观 mode map 和立即生效的本地 mutation lock。每个节点先使用乐观值推导显示 mode，再使用 controller snapshot。成功时在 controller Promise 发布后清除乐观状态；失败时清除并设置 `actionError`。本地或 controller pending 时禁用全部上下文 mutation。

- [ ] **步骤 5：运行聚焦测试并确认 GREEN**

运行步骤 2 命令，预期通过且没有未处理 Promise rejection。

- [ ] **步骤 6：提交 checkbox 交互**

```bash
git add packages/client/ui-contextify/src/client/ContextMapNode.tsx packages/client/ui-contextify/src/client/ContextMapPanel.tsx packages/client/ui-contextify/src/client/ContextMapPanel.module.css packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git commit -m "feat: add effective context checkboxes"
```

### 任务 3：统一菜单、批量操作、Header 与 Reset 语义

**文件：**
- 修改：`packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 测试：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`
- 测试：`packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **步骤 1：编写失败的产品文案测试**

断言 `3 / 3 in context`、`Clear manual changes`、菜单不再显示 Natural/Include/Exclude、仅在需要时显示 Restore Automatic，以及批量有效 mutation 在目标值等于路径成员关系时标准化为 Natural。

```ts ignore-check
expect(screen.getByText('3 / 3 in context')).toBeTruthy()
expect(screen.getByRole('button', { name: 'Clear manual changes' })).toBeTruthy()
expect(within(menu).queryByRole('menuitem', { name: 'Include' })).toBeNull()
expect(within(menu).getByRole('menuitem', { name: 'Restore automatic' })).toBeTruthy()
```

- [ ] **步骤 2：运行两个组件套件并确认 RED**

运行：`pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

预期：旧 selected、Reset 和三态菜单导致失败。

- [ ] **步骤 3：实现简化菜单与工具栏**

保留“在 Chat 中定位”和“从此处创建分支”。仅当 `mode !== 'natural'` 时显示“恢复自动”，并通过面板受保护 mutation runner 执行。重命名 Header 计数和 Reset，保留 Undo/Redo。

- [ ] **步骤 4：实现有效批量操作**

将操作重命名为“进入上下文”“不进入上下文”和“恢复自动”。对每个所选节点推导当前路径成员关系，并调用 `modeForEffectiveContext(active, desired)`；恢复自动为每个节点发送 Natural。Mutation pending 时禁用操作栏并显示失败。

- [ ] **步骤 5：运行两个组件套件并确认 GREEN**

运行步骤 2 命令，预期通过。

- [ ] **步骤 6：提交统一控件**

```bash
git add packages/client/ui-contextify/src/client/ContextMapMenu.tsx packages/client/ui-contextify/src/client/ContextMapPanel.tsx packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
git commit -m "feat: simplify Context Map context controls"
```

### 任务 4：记录并验证组装行为

**文件：**
- 修改：`packages/client/ui-contextify/README.md`
- 修改：`packages/client/ui-contextify/README.zh.md`
- 修改：`packages/client/ui-contextify/README.i18n.yaml`
- 修改：`.agents/notes/implemented/feature/2026-08-17-native-session-context-map.md`
- 修改：`.agents/notes/implemented/feature/2026-08-17-native-session-context-map.zh.md`
- 修改：`.agents/notes/implemented/feature/2026-08-17-native-session-context-map.i18n.yaml`
- 修改：`apps/web/tests/contextify-map.e2e.ts`

- [ ] **步骤 1：先更新 replay E2E**

修改场景以断言 checkbox 状态、一次 checkbox mutation、清除手动修改、条件式恢复自动、右键定位、多选与实时拖拽。运行单个 E2E，并确认旧控件导致失败。

运行：`pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts`

- [ ] **步骤 2：更新当前状态文档**

记录有效 checkbox 语义、持久 Manual override、回到路径推导值时自动删除覆盖，以及清除手动修改。删除整卡 mutation 或并列 Natural/Include/Exclude 菜单的描述，并重新记录两个双语 pair。

- [ ] **步骤 3：运行聚焦和组装验证**

运行：

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
pnpm --filter @deepseek-ai/dsh-client-ui-contextify bundle
pnpm run verify-translation-pairing packages/client/ui-contextify/README.md
git diff --check
```

预期：行为测试、replay E2E、bundle、双语文档和空白检查通过。无关的既有全仓文档或 lint 失败单独报告，不在本功能中修改。

- [ ] **步骤 4：执行浏览器验收**

在 `http://127.0.0.1:3080/` 验证当前路径节点勾选、其他路径节点未勾选、checkbox 即时反馈且不激活拖拽、恢复自动、清除手动修改、Selection mode 描边与 checkbox 状态独立、跨 Session 右键定位，以及没有新增 console error。

- [ ] **步骤 5：提交文档与验证**

```bash
git add packages/client/ui-contextify/README.md packages/client/ui-contextify/README.zh.md packages/client/ui-contextify/README.i18n.yaml .agents/notes/implemented/feature/2026-08-17-native-session-context-map.md .agents/notes/implemented/feature/2026-08-17-native-session-context-map.zh.md .agents/notes/implemented/feature/2026-08-17-native-session-context-map.i18n.yaml apps/web/tests/contextify-map.e2e.ts
git commit -m "test: verify effective Context Map selection"
```

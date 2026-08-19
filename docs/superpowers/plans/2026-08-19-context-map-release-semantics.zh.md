# Context Map 发布语义实施计划

> **给执行 Agent：** 按任务顺序使用 executing-plans 执行；每个任务先写失败测试，再实现、验证并提交。英文版中的逐步代码示例与本文件具有同等约束力。

[English](2026-08-19-context-map-release-semantics.md) | 中文

**目标：** 上线原子 Context 版本替换、单节点 Archive、规范化原生 Branch 层级、Profile prompt 配置、轻量 post-Turn Branch 建议，以及不透明 Context Map 右键菜单。

**架构：** `@deepseek-ai/dsh-contextify` 始终是 Session family graph、Context Plan、隔离 review 与 relocation 的 Host 权威。浏览器只投影 Host proposal，使用既有 placeholder overlay 做 Archive，并把 Profile prompt UI 接入原生 settings。Branch 判断是 completed Turn 后显式开启、禁用工具的辅助模型调用；用户确认后执行幂等原生 fork 和确定性 Q+A 回放。

**技术栈：** TypeScript、Cordis、Typert Remote、Harness Session/Agent/Subagent/Settings、React 18、React Flow、Vitest、Testing Library、Playwright replay。

---

## 文件地图

- `packages/context/contextify/src/recommendation.ts`：不可信 Agent 输出的规范化，以及 Current/Proposed 推导。
- `packages/context/contextify/src/branch-review.ts`：completed Turn 提取、Branch decision 校验、relocation key。
- `packages/context/contextify/src/settings.ts`：默认 prompt、Profile schema、effective prompt。
- `packages/context/contextify/src/types.ts`：Remote-safe recommendation、Archive、Branch suggestion 与 relocation 类型。
- `packages/context/contextify/src/index.ts`：服务生命周期、Remote、原子 plan mutation、review 调度、relocation。
- `packages/context/contextify/src/family.ts`：canonical sibling/child ancestry。
- `packages/client/ui-contextify/src/client/controller.ts`：review state、原子 Apply、Archive、Branch suggestion。
- `packages/client/ui-contextify/src/client/ContextRecommendationReview.tsx`：Current/Proposed diff 与独立 Archive review。
- `packages/client/ui-contextify/src/client/ContextMapMenu.tsx`：Archive/Restore 与不透明 menu。
- `packages/client/ui-contextify/src/client/BranchSuggestionCard.tsx`：非模态 post-answer 建议。
- `packages/client/ui-contextify/src/client/ContextifyPromptSettings.tsx`：默认 prompt、append、显式 override、reset。
- `packages/client/ui-contextify/src/client/index.ts`：Remote adapter 与 slot registration。
- Host/Client spec 与 `apps/web/tests/contextify-map.e2e.ts`：聚焦和组装验收。

## Task 1：把 Context recommendation 规范化为完整版本

**修改：** `types.ts`、`recommendation.ts`；**测试：** `recommendation.spec.ts`。

- [ ] 先写失败测试，证明已 include 的 Include 与已 exclude 的 Exclude 是 no-op；相同重复动作合并；同一节点 Include+Exclude 拒绝；未知节点拒绝。
- [ ] Proposal 必须包含 `currentNodeIds`、`proposedNodeIds`、`addedNodeIds`、`removedNodeIds`、规范化后的 `selection` 与独立 `archive`。
- [ ] 顺序必须来自 family graph，而不是 Agent 输出顺序，从而保证稳定 diff 与重放。
- [ ] 运行 `pnpm vitest run packages/context/contextify/tests/recommendation.spec.ts`。

核心伪代码：

```text
current = orderedSet(effectiveIncludedNodeIds)
actions = normalize(raw.selection)
for action of actions:
  assertKnownNode(action.nodeId)
  rejectContradiction(action)
  if actionWouldChange(current, action): apply(current, action)
proposed = graphOrder(current)
return {
  currentNodeIds: graphOrder(effectiveIncludedNodeIds),
  proposedNodeIds: proposed,
  addedNodeIds: proposed - current,
  removedNodeIds: current - proposed,
  selection: onlyEffectiveActions,
  archive: validateArchive(raw.archive),
}
```

## Task 2：原子应用 Current → Proposed

**修改：** Host `setNodeModes`、Client controller 与 review sheet；**测试：** service 与 client specs。

- [ ] UI 只展示一份版本差异：当前节点数、建议节点数、新增、移除，以及理由。
- [ ] 删除逐条 Apply；按钮只允许 `Apply proposed context`。
- [ ] Client 把 proposal.selection 一次发送给 Host；Host 校验 plan revision、graph revision、active Session 与 Agent idle。
- [ ] 所有动作准备完成后只 append 一个 plan revision；任一校验失败时不写 snapshot 或 plan。
- [ ] 一次 Undo 必须完整恢复旧版本；Dismiss 不产生持久变化。

核心伪代码：

```text
async applyProposal(proposal) {
  assertFresh(proposal.base)
  mutations = proposal.selection.map(toNodeMutation)
  return setNodeModes(currentPlanRef, mutations, proposal.base.graphRevision)
}
```

## Task 3：单条 input/output Archive 与 Restore

**修改：** `index.ts`、controller、node/menu/review；**测试：** Host/Client specs。

- [ ] 右键菜单对每条 user input 或 final assistant output 提供 `Archive node`。
- [ ] Archive 不能改变 Include/Exclude；只增加 replacement overlay。
- [ ] 固定写入 `[Placeholder: intentionally empty]`，不接受 Agent 或 UI authored content。
- [ ] 节点 ID、role、edge、fork boundary 与原始 Session event 保持不变。
- [ ] Archived card 显示 badge；右键提供 Show original 与 Restore node。
- [ ] 推荐中的 Archive 只能逐条 review/确认，禁止批量自动执行。
- [ ] Reset、Undo、Redo 必须覆盖 Archive overlay。

核心伪代码：

```text
archiveNode(ref, node, reason, graphRevision) {
  current = prepareCAS(ref)
  graph = loadAndAssertRevision(graphRevision)
  target = resolveGenuineMessage(node)
  replacement = appendFixedRolePreservingSnapshot(target, PLACEHOLDER)
  commit(nextPlan(current, { replacements: current.replacements + replacement }))
}
```

## Task 4：规范化 Branch 层级

**修改：** `family.ts`；**测试：** `family.spec.ts` 与 Workspace tree spec。

- [ ] 钉住两类测试：在继承 boundary 上再次 fork 是 sibling；在 branch-local boundary 上 fork 是 child。
- [ ] 只规范化投影出来的 `parentSessionId`；原生 Session header 不修改。
- [ ] Graph message ownership、去重与边保持原有逻辑。
- [ ] 左侧 Workspace tree 与 Context Map 使用同一规范化结果。

核心伪代码：

```text
canonicalParent(session) {
  rawParent = session.parentSession
  if (!rawParent) return undefined
  forkBoundary = session.seedLength - 1
  if (forkBoundary <= rawParent.inheritedBoundary)
    return canonicalParent(rawParent)
  return rawParent.id
}
```

## Task 5：Profile-owned Prompt Settings

**修改：** Host `settings.ts`、Contextify service、API Proxy 白名单；**测试：** settings/service specs。

- [ ] 创建 `contextify` namespace，包含 `context`、`archive`、`branch` 三段。
- [ ] 每段只有 `additional` 与 `override`，各自限制 16k 字符。
- [ ] 默认 prompt 属于 package，Profile 只保存用户差异。
- [ ] `override.trim()` 非空时替换 package base；之后仍追加 additional instructions。
- [ ] recommendation 使用 Context+Archive effective prompt；post-Turn review 使用 Branch effective prompt。
- [ ] 三类 Agent 都复用 parent Agent 的 Harness provider/model route 并禁用工具。

核心伪代码：

```text
effectivePrompt(base, settings) =
  (settings.override.trim() || base) +
  (settings.additional.trim() ? "\n\nAdditional profile instructions:\n" + settings.additional : "")
```

## Task 6：原生 Prompt Dashboard

**修改：** `ContextifyPromptSettings.tsx/.module.css`、client registration；**测试：** prompt/browser specs。

- [ ] 在原生 Profile Settings 注册一个 Contextify section。
- [ ] Context、Archive、Branch 三个 card 都显示灰色只读 package prompt。
- [ ] Additional instructions 默认可编辑并按 Profile scope 保存。
- [ ] Override 默认隐藏／禁用，只有显式确认后才可编辑。
- [ ] Restore package prompt 只清空 override，不清除 additional instructions。
- [ ] 覆盖 optimistic concurrency、保存失败、Profile 切换与 unmount。

## Task 7：轻量 post-Turn Branch review

**修改：** `branch-review.ts`、Session events、service lifecycle；**测试：** branch-review/service specs。

- [ ] 只响应 `reason.kind === 'completed'` 的 `turn/end`。
- [ ] 提取本 Turn 第一条真实 user input 与最后一条可见 assistant output；忽略 reasoning、tool、intermediate output。
- [ ] 自动 review 默认关闭；Profile 提供明确 checkbox，因为开启后每 Turn 增加一次模型调用。
- [ ] 等 parent Agent idle 后异步运行一次 text-only 辅助调用，`maxTokens=320`；不创建可见 subagent。
- [ ] 只从有界响应解析 `{ action: keep|suggest_branch, confidence, reason }`。
- [ ] 低于 0.8 confidence 不展示；同一 turnEndSeq 只能写一条 review event。
- [ ] 不阻塞主回复，不进入 Agent loop，也不把 review prompt/reasoning 写入 parent transcript。

## Task 8：幂等原生 Branch relocation

**修改：** Host Remote 与 Session event；**测试：** service spec。

- [ ] 接受建议前检查 Agent idle、suggestion 存在、plan/graph 未过期、建议后没有新 conversation event。
- [ ] 根据 source Session + turnEndSeq 计算 SHA-256 relocation key 与确定性 child Session ID。
- [ ] 在 source plan 的一个 revision 中 Archive input/output。
- [ ] 在 `boundaryBefore` 调用 `sessions.fork`，并把 exact input/output 作为一个 completed Turn 回放到 child。
- [ ] child 写 relocation marker；重试发现 marker 时直接返回同一个 child。
- [ ] fork 失败后的重试可以从 source placeholders 恢复，不重复 Archive。

## Task 9：Branch suggestion card 与导航

**修改：** `BranchSuggestionCard`、`ContextMessageAction`、client adapter；**测试：** client specs。

- [ ] Card 只出现在 suggestion 对应的 final output 旁，不弹模态框。
- [ ] 展示简短理由和两个操作：Keep here、Move to new branch。
- [ ] Keep here 只关闭当前建议；Move 调用 Remote，成功后打开 returned child Session。
- [ ] stale/error 使用普通错误面板，不隐式重试 mutation。

## Task 10：不透明右键菜单与最终文案

- [ ] Menu 使用语义 layer background、`opacity: 1`、无 backdrop transparency，并位于 edge/node 上方。
- [ ] 菜单项依节点状态精确显示，避免 Archive/Restore automatic 混淆。
- [ ] Current/Proposed、Archive、Branch 文案统一，不再出现 cleanup/delete 等旧说法。

## Task 11：文档、类型与生成目录

- [ ] 更新 Contextify Host/Client 中英文 README。
- [ ] 新增 implemented Agent Note 与翻译配对记录。
- [ ] 所有 exported API 补齐 JSDoc param/returns。
- [ ] 运行 `pnpm run gen-client-catalog`、`gen-cordis-catalog`、`gen-persistence-catalog` 与 `doc-sync`。
- [ ] 运行 translation pairing、markdown、package path 与 `git diff --check`。

## Task 12：发布验收

依次运行：

```bash
pnpm run typecheck
pnpm vitest run packages/context/contextify/tests packages/client/ui-contextify/tests packages/client/ui-workspace/tests/tree.client.spec.ts
pnpm run lint
pnpm run test:gui
DSH_SNAPSHOT=replay pnpm run test:web
```

浏览器人工验收：

- [ ] 真实对话只渲染 initial input 与 final output。
- [ ] 长节点按真实 bounding box 分层，不 overlap。
- [ ] 右键菜单完全不透明；Locate、Branch、Archive、Restore 可用。
- [ ] Archive 不改变 checkbox，Restore 恢复原文。
- [ ] Recommend 展示整体 diff；Apply/Undo 是版本级操作。
- [ ] Prompt Dashboard 默认只读、append 可保存、override 需确认。
- [ ] 高置信度 Branch card 可搬迁 Q&A 并打开 child；刷新和重试不重复。
- [ ] 同 inherited boundary 的 branch 在左侧和 Map 中同级，branch-local fork 保持 child。

## 完成定义

所有自动 gate 与浏览器验收通过；没有未经说明的跳过项；工作树只包含本功能及其生成目录；提交信息能独立描述 Context Map release semantics。若 Web replay 依赖外部环境而无法执行，必须在交付中明确记录，不能宣称全量发布就绪。

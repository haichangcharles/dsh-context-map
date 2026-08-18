# Context Map 动态布局与 Agent 建议审阅实施计划

[English](2026-08-18-context-map-measured-layout-and-agent-review.md) | 中文

> **面向执行模型：** 按任务顺序实施；每个任务都先写失败测试，再写最小实现。不要把建议结果直接写入 Context Plan，也不要删除或改写 Harness 原生 Session 事件。

**目标：** 修复长消息节点相互覆盖的问题，并在原生 DeepSeek Harness Agent loop 上增加两类人工审阅能力：Include/Exclude 建议可在用户同意后执行；清理建议只列出候选，用户确认后把节点内容替换为可恢复的占位符，同时保持原生节点、边、分支点和 Session 谱系不变。

**总体架构：** React Flow 先用估算尺寸出首帧，再把真实节点尺寸反馈给 Dagre，后者按真实 bounding box 重新计算树布局。建议由隔离的 one-shot `spawn` subagent 通过 Harness 自己的 provider/model、Agent loop 和 `structured_output` 工具生成；当前聊天 Session 不接收这次分析的消息。所有建议都是临时数据。只有用户接受 Include/Exclude 后才调用已有 `setNodeModes()`；只有用户逐项确认清理后才追加一个本地 `context/compiler-snapshot` 并提交 Context Plan v3 replacement。原始消息永远留在 Session log 中。

**技术栈：** TypeScript 6、Cordis、Harness Agent/Subagent、Typert Remote、append-only Session、Context Compiler、React 18、React Flow、Dagre、Vitest、Testing Library、Playwright。

---

## 一、已经确定的产品约束

1. Map 仍然只显示每个 Turn 的最初 user input 和最终 assistant output；reasoning、tool call、tool result 和中间 assistant step 不进入 Map。
2. Map 仍然映射原生 Session fork family；本功能不建立第二套 branch/session 模型。
3. Include/Exclude 建议在用户点击接受后才执行，可以单项接受，也可以批量接受。
4. 删除/清理建议永不自动执行，也不提供“一键全部删除”。用户必须逐项确认。
5. “删除节点”是语义替换：同一个 `nodeId` 继续存在，入边、出边、分支锚点和 Locate 能力不变；仅送入模型的消息内容换成占位符。
6. 占位符默认保留原消息角色（user/assistant），避免破坏模型消息序列。原文可查看、可恢复，Undo/Redo 和 `Clear manual changes` 都能恢复。
7. replacement、Include、Exclude 都属于当前 Session 的 Context Plan。新 fork Session 延续既有规则：从 Natural 状态开始，不继承父 Session 的手动覆盖。
8. 后台 1.5 秒 graph refresh、尺寸重测和建议状态变化都不得自动改变用户当前 viewport。
9. 手动拖拽位置是用户覆盖项，可以有意造成重叠；自动防重叠只保证没有手动 position override 的确定性布局。`Re-layout` 清除覆盖项并恢复完整自动布局。
10. 本轮不实现自动 branch 路由、自动 main-line promotion、跨 Context Map 推荐或物理删除 Session 历史。

## 二、选定方案与不采用方案

### 动态布局

采用“真实尺寸 + Dagre”而不是增加固定 `ranksep`。固定间距只对某个最长文本暂时有效，下一条更高的消息仍会重叠。也不重写自定义 tree walker，因为 Dagre 已经正确处理多父/多子 family graph；它缺的只是实际宽高。

布局必须满足以下几何不变量：

```text
parentBottom = parent.position.y + parent.height
childTop = child.position.y
childTop - parentBottom >= CONTEXT_MAP_RANK_GAP

leftRightGap(a, b) >= CONTEXT_MAP_NODE_GAP
```

### Agent 建议

采用隔离的 `ctx.subagents.start('spawn', ...)` one-shot run，不复用当前 Agent 的下一轮，也不直接调用某个厂商 SDK。这样可继承当前 Agent 的 provider/model 路由和 Harness loop，同时不把推荐 prompt、reasoning、tool rows 或结果写进当前聊天 Session。

子 Agent 只允许 scoped `structured_output` 工具：传 `toolFilter: { allow: [] }` 会屏蔽所有继承的全局工具，但不会屏蔽 child scope 注册的结构化结果工具。建议分析是只读的，不需要 filesystem、web、bash 或写工具。

### 语义删除

采用“同 nodeId 的 Context Plan replacement overlay”，不物理删除消息，也不创建新的 graph node。独立版 Context Map 的删除预览和影响说明可以复用交互思想，但其重写 parent/branch/mainline 的 store 算法不能直接移植，因为 Harness 的 Session log 和 fork lineage 是事实来源，不能由 UI store 改写。

---

## 三、最终数据流

```text
React Flow 首帧
  -> 224x116 估算 Dagre 布局
  -> onNodesChange(dimensions)
  -> measuredSizes[nodeId]
  -> 真实尺寸 Dagre 布局
  -> 只更新节点坐标，不 fitView

Recommend
  -> Contextify Remote 校验 live + idle + planRevision + graphAsOfSeq
  -> 读取原生 family 和精确消息
  -> 构造有界、只读的 graph snapshot
  -> Harness spawn subagent + structured_output schema
  -> 校验 nodeId/action/重复项
  -> 返回临时 proposal
  -> UI 标注建议，但 Context Plan 不变

Accept Include/Exclude
  -> proposal 映射成 ContextNodeMutation[]
  -> 已有 setNodeModes(ref, mutations)
  -> 一个新 Context Plan revision

Confirm cleanup candidate
  -> replaceNode(ref, owner, placeholderText, reason)
  -> append context/compiler-snapshot
  -> append Context Plan v3 replacement
  -> compileContextify 用 snapshot seq 替换原 event/include snapshot seq
  -> family graph 仍使用原 nodeId 和原边，只改变显示状态
```

---

## 四、核心类型与伪代码

### 4.1 测量尺寸

```text
interface ContextMapNodeSize {
  readonly width: number
  readonly height: number
}

type ContextMapNodeSizes = Readonly<Record<string, ContextMapNodeSize>>

function normalizedSize(change): ContextMapNodeSize | undefined {
  if dimensions missing or width <= 0 or height <= 0: return undefined
  return {
    width: roundToHalfPixel(width),
    height: roundToHalfPixel(height),
  }
}

function reduceMeasuredSizes(current, changes): ContextMapNodeSizes {
  next = current
  for each dimensions change:
    size = normalizedSize(change)
    if size is undefined: continue
    if abs(old.width-size.width) < 1 and abs(old.height-size.height) < 1: continue
    lazily clone current, then next[change.id] = size
  return next
}
```

`layoutContextMap()` 改为接收尺寸表。估算值仅用于尚未测量的节点：

```text
function sizeFor(id, sizes) {
  return sizes[id] ?? { width: 224, height: 116 }
}

for record in records:
  graph.setNode(record.id, sizeFor(record.id, sizes))

dagre.layout(graph)

return records.map(record => {
  size = sizeFor(record.id, sizes)
  center = graph.node(record.id)
  return {
    ...reactFlowNode(record),
    position: {
      x: center.x - size.width / 2,
      y: center.y - size.height / 2,
    },
  }
})
```

### 4.2 建议结果

```text
interface ContextRecommendationBase {
  readonly planRevision: number
  readonly graphAsOfSeq: number
  readonly activeSessionId: SessionId
}

interface ContextSelectionRecommendation {
  readonly nodeId: string
  readonly action: 'include' | 'exclude'
  readonly reason: string
  readonly confidence: 'high' | 'medium' | 'low'
}

interface ContextCleanupCandidate {
  readonly nodeId: string
  readonly category: 'obsolete' | 'conflict' | 'redundant'
  readonly reason: string
  readonly evidenceNodeIds: readonly string[]
  readonly placeholderText: string
}

interface ContextRecommendationProposal {
  readonly base: ContextRecommendationBase
  readonly selection: readonly ContextSelectionRecommendation[]
  readonly cleanup: readonly ContextCleanupCandidate[]
}
```

建议 schema 不允许 `delete: true`、`execute` 或任何 Session mutation 字段。服务端必须再次验证：所有 ID 在同一份 family graph 中；selection 内 nodeId 唯一；cleanup 内 nodeId 唯一；evidence ID 有效；placeholder 非空且有限长；当前 effective state 与建议 action 确实不同。

### 4.3 Context Plan v3 replacement

```text
interface ContextReplacementNode {
  readonly nodeId: string
  readonly snapshotSeq: number
  readonly originalEventSeq: number | null
  readonly role: 'user' | 'assistant'
  readonly kind: 'placeholder'
  readonly reason: string
}

interface ContextPlanStateV3 {
  readonly excluded: readonly ContextExcludedNode[]
  readonly included: readonly ContextIncludedNode[]
  readonly replacements: readonly ContextReplacementNode[]
}
```

编译顺序：先处理 Exclude/tool group，再替换 active path 的原 event seq，再插入 Include；若 Include 的 `nodeId` 有 replacement，则插入 replacement snapshot 而不是旧 imported snapshot。

```text
selected = naturalSurfaceMinusExcludedAndToolGroups()
protectCurrentTurn(selected)

eventSeqs = selected.map(seq => {
  replacement = replacements.find(item => item.originalEventSeq === seq)
  return replacement?.snapshotSeq ?? seq
})

for included ordered by position:
  replacement = replacementByNodeId.get(included.nodeId)
  seq = replacement?.snapshotSeq ?? included.snapshotSeq
  insertAtStablePosition(eventSeqs, seq, included.position)

assert no duplicate seq
messages = eventSeqs.map(selectedMessage)
```

replacement 不改变 included/excluded 模式。用户恢复原文时只移除 replacement，原来的有效选择状态保持不变；`resetPlan()` 同时清空三组手动状态。

---

## 五、可执行任务

### 任务 1：用纯布局测试复现长节点重叠

**文件：**
- 新建：`packages/client/ui-contextify/tests/{layout.client.spec.ts}`
- 修改：`packages/client/ui-contextify/src/client/layout.ts`

- [ ] **步骤 1：写 RED 测试。** 建立三组尺寸：高 parent/普通 child、普通 parent/高 child、不同宽度 siblings。调用计划中的新签名 `layoutContextMap(nodes, edges, 'tree', sizes)`，用真实 bottom/top 断言 gap。
- [ ] **步骤 2：运行 RED。**

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/{layout.client.spec.ts}
```

预期：TypeScript 因第四个参数不存在而失败；若先临时允许参数，则高 parent 测试报告负 gap。

- [ ] **步骤 3：实现 measured Dagre。** 导出 `CONTEXT_MAP_RANK_GAP = 86`、`CONTEXT_MAP_NODE_GAP = 54` 和 `ContextMapNodeSizes`。每个 Dagre node 使用自身尺寸，坐标减去自身半宽/半高。Tree 是发布路径；timeline 也使用尺寸表；已隐藏的 mindmap 实现不得重新暴露到 UI。
- [ ] **步骤 4：运行 GREEN。** 上述三组几何断言全部通过，且同一输入重复调用得到完全相同坐标。
- [ ] **步骤 5：提交。**

```bash
git add packages/client/ui-contextify/src/client/layout.ts packages/client/ui-contextify/tests/{layout.client.spec.ts}
git commit -m "fix(context-map): lay out measured message bounds"
```

### 任务 2：把 React Flow 尺寸反馈接入布局，但保留 viewport 所有权

**文件：**
- 新建：`packages/client/ui-contextify/src/client/{layout-measurements.ts}`
- 新建：`packages/client/ui-contextify/tests/{layout-measurements.client.spec.ts}`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **步骤 1：写 reducer RED 测试。** 覆盖非法/零尺寸、0.5px 归一化、1px epsilon、不相关 change、节点移除后的尺寸清理，以及输入未变化时返回同一 object identity。
- [ ] **步骤 2：扩展 React Flow test seam。** 除 `onNodesChange` 外保存最新 `props.nodes`，以便测试读取重新布局后的坐标。发出 parent `{width:224,height:340}` 和 child `{width:224,height:116}`。
- [ ] **步骤 3：写 panel RED 测试。** 断言尺寸回传后 `child.y >= parent.y + 340 + 86`；再次回传相同尺寸不会产生新的坐标 publication；后台 publish 等价 graph 后不会调用 `fitView`。
- [ ] **步骤 4：实现 component state。** 增加 `measuredSizes`；`onNodesChange` 通过 reducer 更新；graph node 删除时清理对应 key；`flowNodes` 调用 `layoutContextMap(..., measuredSizes)`，最后再应用 transient/persisted position override。
- [ ] **步骤 5：稳定首次 fit。** 用“尺寸 signature 变化后 80ms 无新变化”的 debounce 代替“收到任一 dimensions 就认为完成”。`initialFitCompleted` 仍是 one-shot；普通 measured re-layout 永不 `fitView`。显式 focus 和 `Re-layout` 继续按现有规则工作。
- [ ] **步骤 6：防循环。** reducer 的归一化和 epsilon 必须保证同一真实尺寸不触发 setState；effect 不得依赖每次新建的 sizes object；清理所有 timer。
- [ ] **步骤 7：验证。**

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/{layout-measurements.client.spec.ts} packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
```

预期：动态高度无重叠；首次 fit 一次；refresh/re-measurement 不 fit；Re-layout 清除手动位置并 fit。

- [ ] **步骤 8：提交。**

```bash
git add packages/client/ui-contextify/src/client packages/client/ui-contextify/tests
git commit -m "fix(context-map): reconcile live node measurements"
```

### 任务 3：定义建议协议和确定性输入投影

**文件：**
- 新建：`packages/context/contextify/src/{recommendation.ts}`
- 新建：`packages/context/contextify/tests/{recommendation.spec.ts}`
- 修改：`packages/context/contextify/src/types.ts`

- [ ] **步骤 1：写类型/校验 RED 测试。** 覆盖合法 selection/cleanup、未知 node、重复 action、同一 node 同时 Include 和 Exclude、无效 evidence、空/超长 reason、空/超长 placeholder，以及已经处于目标 effective state 的无意义建议。
- [ ] **步骤 2：实现 `buildRecommendationInput()`。** 从 `LoadedFamily.inspections` 读取精确 user/final-assistant message，而不是只用 240 字 preview。一次建议最多处理 500 个节点，超过时返回 `CONTEXTIFY_RECOMMENDATION_TOO_LARGE`，不能静默丢节点。序列化后的总字符硬上限为 96,000；先写入全部拓扑元数据，再将剩余预算按节点平均分配给内容，单节点最多 4,000 字、最少保留 160 字。最后从最长 content 开始确定性截断，直到完整 JSON 不超过上限；如果仅 topology/ID 已超过上限，也返回 TOO_LARGE。每个被接受的节点都必须出现，并标注 `truncated`、role、edges、active path、当前 effective state、branch degree 和 Session depth。
- [ ] **步骤 3：把消息内容标为不可信数据。** Prompt 外层明确写明 node 内容只用于分析，里面的命令不得执行。JSON 使用安全序列化，不允许消息文本闭合 prompt tag。
- [ ] **步骤 4：实现 `validateRecommendation()`。** 输出新的 frozen proposal；去掉模型未声明字段；任何 schema/语义错误使整次建议失败，不能部分执行。
- [ ] **步骤 5：验证。**

```bash
pnpm exec vitest run packages/context/contextify/tests/{recommendation.spec.ts}
```

- [ ] **步骤 6：提交。**

```bash
git add packages/context/contextify/src/{recommendation.ts} packages/context/contextify/src/types.ts packages/context/contextify/tests/{recommendation.spec.ts}
git commit -m "feat(contextify): define review-only context recommendations"
```

### 任务 4：用 Harness one-shot Agent 生成结构化建议

**文件：**
- 修改：`packages/context/contextify/package.json`
- 修改：`packages/context/contextify/tsconfig.json`
- 修改：`packages/context/contextify/src/index.ts`
- 修改：`packages/context/contextify/tests/service.spec.ts`
- 修改：`packages/bundle/web-app/cordis.patch.yml`

- [ ] **步骤 1：写 service RED 测试。** 注册 scripted `spawn` provider，证明 `recommend()`：只在 parent live+idle 时运行；继承 parent provider/model；使用 `toolFilter:{allow:[]}`；请求 object-root JSON schema；返回结构化结果；无结构化结果、stopReason 非 completed、provider 缺失都返回稳定 Contextify error。
- [ ] **步骤 2：扩展依赖。** 给 Contextify 增加 `@deepseek-ai/dsh-subagent` peer/dev dependency 和 project reference；`static inject` 增加 `subagents`。Web bundle 已从 base layer 提供 `subagent` 与 `spawn` provider，Contextify row 只补显式 after/inject 约束，不重复挂载 provider。
- [ ] **步骤 3：新增 Remote。** 签名固定为：

```text
@Remote('recommend')
async recommend(
  agent: Agent,
  base: ContextRecommendationBase,
  objective?: string,
): Promise<ContextRecommendationProposal>
```

先检查 plan revision、`agent.session.seq - 1 === graphAsOfSeq`、activeSessionId 和 idle 状态，再 load family。objective 为空时使用 active Session 最后一个 user input 的文本作为目标。

- [ ] **步骤 4：启动隔离 child。**

```text
run = await ctx.subagents.start('spawn', {
  label: 'Context Map recommendation',
  parent: agent,
  signal: controller.signal,
  prompt: [{ type: 'text', text: renderRecommendationPrompt(input, objective) }],
  persona: CONTEXT_REVIEW_PERSONA,
  toolFilter: { allow: [] },
  agentOptions: { maxTokens: 4_000 },
  outputSchema: CONTEXT_RECOMMENDATION_SCHEMA,
})

try:
  result = await run.result
  require result.stopReason === 'completed'
  require result.structured exists
  return validateRecommendation(result.structured, graph, plan)
finally:
  await run.dispose()
```

不要把 child output、descriptor 或 proposal append 到 parent Session。并发第二次 recommend 返回 `CONTEXTIFY_RECOMMENDATION_BUSY`；Remote 结束后无论成功失败都释放 guard。

- [ ] **步骤 5：新增错误码。** 至少包括 `CONTEXTIFY_STALE_GRAPH`、`CONTEXTIFY_RECOMMENDATION_BUSY`、`CONTEXTIFY_RECOMMENDATION_UNAVAILABLE`、`CONTEXTIFY_RECOMMENDATION_TOO_LARGE`、`CONTEXTIFY_INVALID_RECOMMENDATION`。
- [ ] **步骤 6：验证。**

```bash
pnpm exec vitest run packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/{recommendation.spec.ts}
pnpm run build:lib:host
```

第二条命令必须成功生成更新后的 Typert host/client Remote contract。

- [ ] **步骤 7：提交。**

```bash
git add packages/context/contextify packages/bundle/web-app/cordis.patch.yml
git commit -m "feat(contextify): run isolated recommendation agents"
```

### 任务 5：在 controller 中实现临时建议状态机

**文件：**
- 修改：`packages/client/ui-contextify/src/client/controller.ts`
- 修改：`packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx`

- [ ] **步骤 1：写 RED 测试。** 状态覆盖 `idle -> running -> ready`、error、clear；普通 polling 在 base 不变时保留 proposal；plan revision、graphAsOfSeq 或 activeSessionId 改变时将 proposal 标为 `stale`，绝不自动重新运行。
- [ ] **步骤 2：扩展 transport。** 加 `recommend(base, objective?)`、`replaceNode(...)`、`restoreNode(...)`。controller 的 proposal 是内存状态，不写 localStorage，不跨 Session controller。
- [ ] **步骤 3：实现接受 selection。** 接受单项或选中项时，从当前 graph 找 owner，映射到 `ContextNodeMutation[]`，一次调用现有 `setNodeModes()`。成功后移除已接受建议并 refresh；stale CAS 时保留 proposal 但标 stale，要求用户重新生成。
- [ ] **步骤 4：实现清理确认边界。** controller 只在用户显式确认某个 candidate 时调用 `replaceNode`；不得提供接受全部 cleanup 的方法。
- [ ] **步骤 5：验证并提交。**

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
git add packages/client/ui-contextify/src/client/controller.ts packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
git commit -m "feat(context-map): manage ephemeral agent proposals"
```

### 任务 6：实现建议审阅 UI，不改变现有 checkbox 语义

**文件：**
- 新建：`packages/client/ui-contextify/src/client/{ContextRecommendationReview.tsx}`
- 新建：`packages/client/ui-contextify/src/client/{ContextRecommendationReview.module.css}`
- 修改：`packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.module.css`
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **步骤 1：写交互 RED 测试。** 覆盖 Recommend loading/disable、selection 建议徽标、理由、单项接受、批量接受 selection、dismiss、不自动执行、stale 提示、cleanup 只有 `Review`/`Keep`/`Replace with placeholder`，且没有 `Apply all cleanup`。
- [ ] **步骤 2：加入 toolbar `Recommend`。** 点击后打开覆盖在 canvas 底部的审阅 sheet，graph 保持可见。关闭 sheet 只清除临时 proposal，不改变 plan。
- [ ] **步骤 3：节点标注。** Include/Exclude 用非交互 badge 标注“建议加入/建议移除”；cleanup 用 warning marker。原 checkbox 仍只表达当前有效上下文，不能因为建议而提前切换 checked 状态。
- [ ] **步骤 4：selection 审阅。** 用户可勾选若干 Include/Exclude 建议并点击 `Apply selected`，也可在单项点击 Apply。按钮文案明确“会修改下一轮上下文”。
- [ ] **步骤 5：cleanup 审阅。** 展示 category、reason、evidence nodes 和确定性 impact：入边数、出边数、是否分支支点、影响 Session 数。placeholder text 可编辑，提交前显示 before/after 文本预览。
- [ ] **步骤 6：可访问性。** 所有 badge、review item 和操作有稳定 accessible name；键盘可进入；错误使用 `role=alert`；焦点关闭后回到 Recommend button。
- [ ] **步骤 7：验证。**

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx packages/client/ui-contextify/tests/browser-plugin.client.spec.tsx
```

- [ ] **步骤 8：提交。**

```bash
git add packages/client/ui-contextify/src/client packages/client/ui-contextify/tests
git commit -m "feat(context-map): review context recommendations in canvas"
```

### 任务 7：升级 Context Plan v3 并实现可恢复 placeholder replacement

**文件：**
- 修改：`packages/context/contextify/src/types.ts`
- 修改：`packages/context/contextify/src/plan.ts`
- 修改：`packages/context/contextify/src/index.ts`
- 修改：`packages/context/contextify/tests/compiler.spec.ts`
- 修改：`packages/context/contextify/tests/service.spec.ts`

- [ ] **步骤 1：写 v2 migration RED 测试。** v2 plan 必须规范化为 v3 且保留 revision、stateRevision、history、included、excluded，新增空 replacements；读取不能为了迁移修改 Session。下一次 mutation append v3。
- [ ] **步骤 2：写编译 RED 测试。** 覆盖 active user replacement、active assistant replacement、off-path included replacement、replacement+exclude、restore、reset、undo/redo、相同 snapshot 去重、当前 turn 保护。
- [ ] **步骤 3：实现 plan normalization。** 定义内部 `ContextPlanSnapshotV2` 和公开 v3。`currentContextPlan()`、`planAtStateRevision()` 都通过 `normalizeContextPlanSnapshot()`；历史中引用旧 v2 revision 仍可 undo/redo。
- [ ] **步骤 4：扩展 state helpers。** `freezePlan`、`assertPlanState`、`nextPlan`、`resetPlan`、undo/redo 全部复制/校验 replacements。唯一性要求：nodeId、snapshotSeq 唯一；同一 node 只有一个 replacement；snapshot event 必须存在且 role 匹配。
- [ ] **步骤 5：实现编译 substitution。** 按 4.3 的顺序替换；Context Compiler registry 仍只接收最终 `eventSeqs`，无需扩大通用 registry API。
- [ ] **步骤 6：实现 `replaceNode` Remote。** 验证 ref、family node、placeholder 长度 1..500、消息角色、idle/live。追加 role-preserving `context/compiler-snapshot`，provenance provider 为 `contextify-placeholder`，再追加含 replacement 的 plan。节点已有 replacement 时创建新 snapshot 并以新 revision 替换旧 entry；旧 snapshot 留在 append-only log 中但不再被选择。
- [ ] **步骤 7：实现 `restoreNode` Remote。** 只移除 replacement，不改变 include/exclude；不存在 replacement 返回 `CONTEXTIFY_INVALID_TRANSITION`。`reset()` 清空全部三类手动状态。
- [ ] **步骤 8：graph 装饰。** `ContextFamilyGraphNode` 增加可选 `replacement` view，包含 placeholder preview、reason、role 和 `originalAvailable:true`。`familyPage()` 根据当前 plan 装饰，不改变 `projectSessionFamily()` 的纯原生拓扑。
- [ ] **步骤 9：验证。**

```bash
pnpm exec vitest run packages/context/contextify/tests/compiler.spec.ts packages/context/contextify/tests/service.spec.ts packages/context/contextify/tests/family.spec.ts
```

- [ ] **步骤 10：提交。**

```bash
git add packages/context/contextify
git commit -m "feat(contextify): replace message semantics with placeholders"
```

### 任务 8：在 Map 中显示 placeholder、恢复原文并保持结构

**文件：**
- 修改：`packages/client/ui-contextify/src/client/ContextMapNode.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapMenu.tsx`
- 修改：`packages/client/ui-contextify/src/client/ContextMapPanel.tsx`
- 修改：`packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx`

- [ ] **步骤 1：写 RED 测试。** replacement node 的 DOM 仍使用同一 `data-context-node-id`；React Flow node/edge 数不变；卡片显示 placeholder 而不是原 preview；checkbox、Branch、Locate 仍可用；右键菜单增加 `Show original` 和 `Restore original`。
- [ ] **步骤 2：实现同 ID 渲染。** 不创建 placeholder graph node，不改 edge。卡片使用 replacement preview，并显示“Original retained”状态。Show original 只打开本地 preview/dialog，不修改 Context Plan。
- [ ] **步骤 3：恢复与历史。** `Restore original` 调 controller Remote；Undo/Redo 后 node 文本和 replacement badge 跟随 plan；`Clear manual changes` 恢复全部原文。
- [ ] **步骤 4：重新测量。** replacement 可能比原文短，React Flow 会报告新尺寸；任务 2 的 measured layout 应无循环地重新排版且不 fit viewport。
- [ ] **步骤 5：验证并提交。**

```bash
pnpm exec vitest run packages/client/ui-contextify/tests/context-map-panel.client.spec.tsx
git add packages/client/ui-contextify
git commit -m "feat(context-map): render reversible cleanup placeholders"
```

### 任务 9：端到端、回归、文档和发布门禁

**文件：**
- 修改：`apps/web/tests/contextify-map.e2e.ts`
- 修改：`packages/context/contextify/README.md`
- 修改：`packages/context/contextify/README.zh.md`
- 修改：`packages/client/ui-contextify/README.md`
- 修改：`packages/client/ui-contextify/README.zh.md`
- 修改：`packages/client/ui-contextify/FUTURE_WORK.md`
- 修改：`packages/client/ui-contextify/FUTURE_WORK.zh.md`

- [ ] **步骤 1：新增 keyless e2e。** Mock LLM 第一响应返回 recommendation structured tool call。证明 proposal 出现前 Context Plan 未变；接受 Include/Exclude 后下一模型 request 的消息集合变化；cleanup 候选未确认时不变；确认后 request 中出现 placeholder 且不含原文；Restore 后原文回来。
- [ ] **步骤 2：新增长节点视觉/几何 e2e。** 构造至少 600 字 assistant final output 和短 user child；读取 `.react-flow__node` bounding boxes，断言纵向 gap 非负且至少接近 86px（允许 1px 浏览器误差）。等待两个 polling 周期后 transform 不变。
- [ ] **步骤 3：分支/归档回归。** replacement 前后 Branch from Here 创建相同 native fork；Locate 仍到原消息；归档一个 Session 后 graph projection/replacement 不产生 dangling edge；新 branch 的 Context Plan 为 Natural、无 replacement。
- [ ] **步骤 4：更新双语 README。** 说明真实尺寸布局、建议为 review-only、child Agent 不污染当前 Session、placeholder 是当前 Session Context Plan overlay、原始日志永不删除，以及 reset/undo/redo 语义。
- [ ] **步骤 5：更新 FUTURE_WORK。** 标记 context selection 和 pruning recommendation 已完成；branch/main-line recommendation 仍延后。
- [ ] **步骤 6：运行聚焦测试。**

```bash
pnpm exec vitest run packages/context/contextify/tests packages/client/ui-contextify/tests
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-map.e2e.ts
```

- [ ] **步骤 7：运行构建与门禁。** 使用 Node 22：

```bash
export PATH="/Users/haichangli/.nvm/versions/node/v22.23.2/bin:$PATH"
hash -r
pnpm run typecheck
pnpm run lint
pnpm run doc-sync
pnpm run verify-translation-pairing --write packages/context/contextify/README.md
pnpm run verify-translation-pairing --write packages/client/ui-contextify/README.md
pnpm run verify-translation-pairing --write packages/client/ui-contextify/FUTURE_WORK.md
git diff --check
```

- [ ] **步骤 8：人工验收。** 在 `http://127.0.0.1:3080/` 验证：长卡片不覆盖；拖拽实时；等待刷新 viewport 不跳；Recommend 不改变 checkbox；接受 selection 后 checkbox 与计数更新；cleanup 必须二次确认；placeholder 节点和所有边位置不变；Show original、Restore、Undo、Redo、Clear manual changes 正常。
- [ ] **步骤 9：最终提交。** 只在全部验证通过后提交剩余 e2e 与文档：

```bash
git add apps/web/tests/contextify-map.e2e.ts packages/context/contextify/{README.md,README.zh.md} packages/client/ui-contextify/{README.md,README.zh.md} packages/client/ui-contextify/{FUTURE_WORK.md,FUTURE_WORK.zh.md}
git commit -m "test(context-map): verify agent-reviewed context editing"
```

---

## 六、必须覆盖的冲突与失败场景

| 场景 | 预期行为 |
|---|---|
| 建议运行中用户继续聊天 | 当前 Agent 已不再 idle 或 graphAsOf 改变；proposal 返回 stale/失败，不执行 |
| 建议完成后 polling 只返回等价 graph | proposal 保留，viewport 保留 |
| 用户先手动改 checkbox 再接受旧建议 | CAS revision 失败，显示 stale，不能覆盖新选择 |
| 模型返回未知 nodeId | 整份 proposal 拒绝，不显示部分建议 |
| 模型建议自动删除 | schema 不接受该字段；无执行路径 |
| 清理 branch pivot | 同 nodeId replacement，所有原边/branchAtSeq 不变；impact UI 提醒它是支点 |
| 清理 off-path node | graph 显示 placeholder；默认不进 context；以后 Include 时插入 placeholder snapshot |
| 清理已 Include node | 保留 Include 状态，但编译选 placeholder snapshot |
| 清理已 Exclude node | 保留 Exclude 状态；恢复原文也仍为 Exclude |
| replacement 后再次 replacement | 新 plan 指向新 snapshot；旧 snapshot 保留但不可见 |
| Reset | Include/Exclude/replacement 全部回 Natural/原文；历史可 Undo |
| 新 fork | 原生 Session fork 正常；child 初始化 Natural，无父 replacement |
| 归档包含 replacement owner 的 Session | 按现有 unarchived family projection 隐藏/重绑；不得出现无法 Locate 的幽灵节点 |
| 节点高度在字体加载后变化 | epsilon reducer 接收新尺寸并重排；不 fit viewport、不循环 |
| 手动拖拽节点与自动节点重叠 | 保留用户 override；Re-layout 才恢复自动防重叠 |

## 七、完成定义

只有同时满足以下条件才可宣布完成：

- 任意已测量的自动布局 parent/child 卡片之间按真实 bottom/top 保留至少 rank gap。
- 尺寸反馈不会形成 render-measure-layout 循环，也不会破坏已经修好的 viewport 稳定性。
- Agent 建议确实通过 Harness one-shot Agent loop 产生，并继承当前 provider/model；当前 Session log 中没有推荐分析 Turn。
- 建议本身不改变模型输入；接受 Include/Exclude 才产生一个原子 Context Plan revision。
- cleanup 没有批量自动执行入口；确认后保持 nodeId、edges、branch 和原生 history。
- placeholder 真正替代下一轮编译消息，且 Restore、Reset、Undo、Redo 都可恢复。
- v2 持久数据可读、历史可回放，新 mutation 写 v3。
- 聚焦 unit/client/e2e、typecheck、lint、doc-sync 和 `git diff --check` 全部通过。

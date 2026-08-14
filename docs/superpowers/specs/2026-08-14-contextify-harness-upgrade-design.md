# Contextify × DeepSeek Harness 升级设计

状态：待用户书面审阅

日期：2026-08-14

适用分支：`codex/contextify-harness`

## 1. 结论

本项目采用“薄 Harness 扩展 + 独立 Contextify 插件”的结构。Harness Fork 只增加两个通用扩展能力：可插拔的 Context Compiler，以及右侧对话面板的增量插槽。Contextify 的分支模型、上下文计划、编译策略、RPC、图缓存和 React UI 全部属于独立社区插件，不进入 DeepSeek Harness 的通用领域模型。

Contextify 不替换 Agent Loop，不直接调用模型，不创建平行聊天后端，也不把 branch 映射成 Session。所有请求仍经过 Harness 原有的 Agent、Session Log、System Prompt、Tool Registry、LLM Provider、Persistence、Compaction、Telemetry 和 Runtime Invariant。

## 2. 目标

升级完成后，用户可以在 Harness Web 对话右侧打开 Context Map，一边聊天一边查看并修改下一次模型请求采用的历史上下文。用户可以从任意对话消息创建轻量 branch、切换 branch、返回父 branch 或 mainline、将 branch 提升为 mainline，并对可控制节点执行 include、exclude 或恢复 natural 状态。

Context Map 的视觉状态必须对应真实后端输入，而不是仅影响 UI。每次 Agent 请求必须由同一个 Context Compiler 结果生成，并由运行时 invariant 从 Session Log 重新计算后验证。

Fork 必须持续吸收 `deepseek-ai/deepseek-harness` 的新版本。为此，Harness Core 改动只提供通用接口和插槽，不包含 Contextify 类型、名称、图算法或产品文案。

## 3. 非目标

- 不把 branch 实现成 Harness Session fork。
- 不复制或重写 `ReactLoopAgent`。
- 不通过 `agent/request` 或 `llm/stream` 修改已冻结的 messages。
- 不把 Contextify 当前的 Zustand store、Express 后端、Gemini 直连代码或 2,000 行 `ContextMap.tsx` 原样移入 Harness。
- 不在第一版实现自动 branch 建议、自动 SOP 提取、模式库、节点删除、节点内容编辑或 LLM 自动摘要。
- 不保证 Fork 与未来 upstream 永远零冲突；目标是把冲突限制在两个明确的通用扩展位置。
- 不向官方仓库提交 Contextify 专用代码；官方暂不接受外部 PR，通用能力通过 Discussion/RFC 沟通。

## 4. 已确认的产品语义

### 4.1 Branch 不是 Session

一个 Harness Session 仍然对应一个 Agent 生命周期和一份 append-only Session Log。Contextify branch 只是该 Session 内的路径元数据：它记录从哪个消息节点分出、当前路径指向哪里，以及下一次 turn 应接在哪个路径 tip 上。

创建、选择、返回或提升 branch 都不创建 Agent、不复制 Session Log、不启动模型请求。只有用户发送下一条聊天消息时，Harness 才开始正常 turn。

### 4.2 Path 是内部模型，Branch 是用户语言

实现内部统一使用 `ContextPath`。每条 path 都有稳定 `pathId`、父 path、anchor 节点、名称和归档状态。`mainlinePathId` 指定哪条 path 当前被称为 mainline，`activePathId` 指定下一次 turn 接续的 path。

初始 path 的保留 id 为 `root`。创建 branch 会产生新 path。提升 branch 只改变 `mainlinePathId`，不会重写旧消息或移动 Session Event；旧 mainline path 仍保留并可作为普通 branch 访问。

### 4.3 Context View

一次上下文选择由三层组成：active path 的 natural ancestor chain、显式 include、显式 exclude。节点状态为 `natural`、`include` 或 `exclude`，但 durable plan 只保存偏离 natural 的 include/exclude override。

编译顺序固定为：计算 active path 的 natural 节点；应用 include/exclude；固定当前 open turn；闭包工具调用组；应用 compaction 替换；按照逻辑原始位置排序；交给 Harness 生成 messages。

### 4.4 控制范围

普通用户消息、模型 assistant 消息和 tool-result 消息可进入 Context Map。`source.kind` 不是 `user`、`model` 或 `tool` 的注入上下文仍可显示，但第一版不可手工排除；它们随所属 path 进入或离开，防止用户意外删除 AGENTS、skill、goal 或运行时提醒等必要输入。

系统提示词和工具 schema 不属于历史 message 图，始终由 Harness 原有 System Prompt 和 Tool Registry 组装，Contextify 不控制它们。

### 4.5 编辑时机

当 `agent.status === 'running'` 时，所有改变 Context Plan 的 RPC 必须拒绝，UI 同时禁用编辑控件。用户仍可浏览、缩放、搜索和定位节点。这样一个 turn 内的所有 tool steps 使用同一路径和同一计划，不会出现流式响应过程中上下文被改写。

## 5. 方案比较

### 5.1 替换整个 Agent Loop

外部插件可以提供另一个 Agent Factory，但它必须复制请求准备、工具执行、取消、重试、持久化和 invariant 逻辑。该方案与 upstream 演进高度耦合，因此拒绝。

### 5.2 用 `surfaceOp: replace` 模拟所有选择

Session surface replacement 适合 compaction，不适合非连续 include/exclude、多个 branch 和可逆浏览。它还会改变全局 canonical surface，使 UI transcript、fork 和 compaction 共同受到影响，因此拒绝。

### 5.3 Context Compiler Registry + Contextify Provider

Harness 增加一个纯同步 registry。Provider 只返回有序 Session Event seq，不返回任意 Message。Registry 验证 seq、从已冻结 Session Event 还原 Message、生成 request，并由 invariant 重新计算。默认 provider 完全等价于 `session.deriveMessages()`。Contextify 作为外部 provider 注册自己的选择算法。该方案被采用。

## 6. 仓库边界

### 6.1 Harness Fork

仓库：`haichangcharles/deepseek-harness`

本地路径：`/Users/haichangli/Documents/ChatGPT/harness/deepseek-harness`

Harness Fork 只拥有：

- `@deepseek-ai/dsh-context-compiler` 通用 capability。
- Agent Loop 对 `ctx.contextCompiler.compile()` 的消费。
- 请求 header 和 invariant 对 compiler descriptor 的记录与校验。
- `conversation.details.pinned` 通用右侧面板插槽。
- 上述能力的文档、Agent Note、单元测试、真实 composition 测试和 keyless snapshots。

### 6.2 Contextify 插件仓库

计划仓库：`haichangcharles/dsh-plugin-contextify`

计划本地路径：`/Users/haichangli/Documents/ChatGPT/harness/dsh-plugin-contextify`

插件仓库拥有：

- Context Plan 和 Context Route durable event。
- Context graph fold、branch/path 语义和编译算法。
- `ctx.contextify` Host service 与 Typert Remote API。
- `contextify` session projection。
- 浏览器端 graph runtime 和 Context Map panel。
- Contextify bundle/profile overlay。
- 从旧 Context Map Demo 提取的、经过重写的布局算法与交互。

### 6.3 旧 Context Map 仓库

参考仓库：`haichangcharles/context_map`

本地路径：`/Users/haichangli/Documents/ChatGPT/harness/context_map`

该仓库作为产品语义和视觉参考保留。禁止让 Harness 插件运行时依赖其 Zustand store、Express API 或 Gemini service。可复用的纯算法必须复制到新插件仓库、改写为无应用状态依赖的函数，并保留 Apache-2.0 归属信息。

## 7. Harness Core：Context Compiler Capability

### 7.1 文件结构

新增 package：

```text
packages/context/context-compiler/
  package.json
  tsconfig.json
  tsdown.config.ts
  README.md
  src/index.ts
  src/invariant.ts
  tests/registry.spec.ts
  tests/invariant.spec.ts
```

需要修改：

```text
packages/core/agent-loop/src/agent.ts
packages/core/agent-loop/src/invariant.ts
packages/core/agent-loop/package.json
packages/core/agent-loop/tsconfig.json
packages/core/agent-loop/README.md
packages/core/agent-loop/tests/request-reconstruction.spec.ts
packages/core/agent-loop/tests/invariant.spec.ts
packages/core/session/src/types.ts
packages/core/session/src/request-header.ts
packages/core/session/tests/request-header.spec.ts
packages/bundle/base/cordis.patch.yml
packages/bundle/base/package.json
tsconfig.host.json
docs/architecture.md
docs/architecture.zh.md
docs/subsystems/core.md
docs/subsystems/core.zh.md
```

实际实施时还必须更新由依赖图、配置目录和文档生成器识别出的派生文件；禁止手工编辑 generated catalog。

### 7.2 公共类型

`packages/context/context-compiler/src/index.ts` 定义以下精确概念：

```ts
export interface ContextCompilerDescriptor {
  readonly id: string
  readonly version: number
}

export interface ContextCompileRequest {
  readonly session: Session
  readonly turn: number
  readonly step: number
}

export interface ContextSelection {
  readonly eventSeqs: readonly number[]
}

export interface ContextCompilation extends ContextCompilerDescriptor {
  readonly eventSeqs: readonly number[]
  readonly messages: readonly Message[]
}

export interface ContextCompilerDefinition extends ContextCompilerDescriptor {
  select(request: ContextCompileRequest): ContextSelection
}
```

`ContextCompilerRegistry` 作为 `ctx.contextCompiler` Service 提供：

```ts
register(definition: ContextCompilerDefinition): () => void
select(session: Session, id: string): ContextCompilerDescriptor
descriptor(session: Session): ContextCompilerDescriptor
compile(request: ContextCompileRequest): ContextCompilation
```

所有方法同步。Compiler 只能选择已存在的 event seq，不能发起网络请求、调用模型、写 Session、读时钟或修改外部状态。需要摘要时，另一个插件先生成并记录 summary message；Compiler 之后才能选择该 durable event。

### 7.3 默认 provider

Registry 内建保留 provider `{ id: 'surface', version: 1 }`。当 Session 没有 `context/compiler` event 时，默认 provider 返回当前 `session.surface.nodes` 中能够通过 `deriveEventMessage()` 生成消息的 seq。

默认编译结果必须与 `session.deriveMessages()` 在顺序、对象内容和省略空 assistant message 的行为上完全相同。该等价性使用 property test 和现有 request reconstruction fixture 固定。

`surface` id 不允许被外部注册覆盖。重复 provider id、空 id、非正 safe-integer version 或已 dispose registration 的使用必须立即失败。

### 7.4 Provider 选择事件

Context Compiler package 通过 declaration merge 增加 required Session Event：

```ts
'context/compiler': {
  readonly id: string
  readonly version: number
}
```

`select(session, id)` 先解析当前 registration，再 append 完整 descriptor。重复选择同一 descriptor 不写新 event。所选 provider 缺失或 event version 与 registration version 不一致时，`compile()` 失败，不得静默退回 `surface`。

### 7.5 Registry 验证

Provider 返回 seq 后，Registry 必须逐项执行以下验证：

1. seq 是非负 safe integer。
2. seq 不重复。
3. seq 小于 `session.seq` 且对应真实 event。
4. event 是 `user/message`、`assistant/message` 或 `tool/result`。
5. `deriveEventMessage(event)` 非 null。
6. 结果顺序完全采用 provider 返回顺序。
7. 返回数组和 descriptor 冻结，Message 复用 Session 中已冻结对象。

任何违反返回 `ContextCompilerError`，code 分别使用 `INVALID_SELECTION`、`COMPILER_NOT_FOUND`、`COMPILER_VERSION_MISMATCH` 或 `DUPLICATE_COMPILER`。错误在模型 I/O 前结束 step，并由现有 Agent turn error 路径记录。

### 7.6 Agent Loop 接入

`ReactLoopAgent.step()` 不再直接把 `this.session.deriveMessages()` 传给 `buildRequest()`。每次 while retry attempt 外先执行一次：

```ts
const compilation = this.loopCtx.contextCompiler.compile({
  session: this.session,
  turn,
  step,
})
```

同一个 step 的 provider retry 必须复用同一个 compilation，不允许 retry 时重新读取被改变的计划。`buildRequest()` 接收 compilation，并把 `compilation.messages` 放入冻结 request。

Agent Loop 的静态 `inject` 增加 `contextCompiler`。Base bundle 在 Agent Loop 之前插入 `@deepseek-ai/dsh-context-compiler` row；激活仍由 Cordis service dependency 决定，不依赖 YAML 顺序。

### 7.7 Request Header

`packages/core/session/src/types.ts` 自己声明不依赖 Context Compiler package 的结构类型，避免 `dsh-session -> dsh-context-compiler -> dsh-session` 循环：

```ts
export interface RequestContextCompilerDescriptor {
  readonly id: string
  readonly version: number
}

export interface EpochHeader {
  // existing fields stay unchanged
  readonly contextCompiler?: RequestContextCompilerDescriptor
}
```

`ContextCompilerDescriptor` 必须在编译期满足 `RequestContextCompilerDescriptor`，但 Session package 不反向 import Context Compiler。

Agent Loop 创建的 request header 必须总是写入 active compilation descriptor。`canonicalHeader()` 和 `headerEquals()` 必须处理该字段。普通辅助 LLM 调用或现有纯 Session 测试仍可省略它，避免把 Agent Loop 规则扩大到独立调用。

首次请求、resume 或 compiler id/version 变化时，现有 `request/header` 机制自然记录完整 snapshot。Compiler descriptor 改变必须使 header equality 返回 false。

### 7.8 Invariant

Agent Loop invariant 增加 `contextCompiler` injection。对 loop-built request，它必须：

1. 从当前 session 和 request 的 turn/step 重新调用 compiler。
2. 比较 request.messages 与重新编译 messages。
3. 比较 folded request header 的 `contextCompiler` 与重新编译 descriptor。
4. 保留现有 frozen、session id、system、tools、model config 检查。

旧的 `session.deriveMessages()` 直接比较被删除，其他 invariant 不变。默认 provider 测试必须证明新 invariant 仍能捕获任何消息篡改。

## 8. Contextify Host Plugin

### 8.1 Package 结构

新插件仓库使用一个 npm package，同时提供 Host root entry、invariant 和 browser client entry：

```text
dsh-plugin-contextify/
  package.json
  tsconfig.json
  tsconfig.client.json
  tsdown.config.ts
  cordis.patch.yml
  README.md
  LICENSE
  NOTICE
  src/index.ts
  src/invariant.ts
  src/types.ts
  src/runtime.ts
  src/fold.ts
  src/graph.ts
  src/compiler.ts
  src/projection.ts
  src/client/index.ts
  src/client/runtime.ts
  src/client/store.ts
  src/client/ContextMapPanel.tsx
  src/client/ContextMapPanel.module.css
  src/client/ContextNode.tsx
  src/client/ContextNode.module.css
  src/client/locales.ts
  tests/fold.spec.ts
  tests/compiler.spec.ts
  tests/service.spec.ts
  tests/invariant.spec.ts
  tests/browser-plugin.client.spec.tsx
  tests/context-map-panel.client.spec.tsx
  tests/loader-composition.spec.ts
  examples/contextify-web/cordis.yml
  examples/contextify-web/tests/contextify.snapshot.ts
```

package 名为 `dsh-plugin-contextify`，repository topic 使用 `dsh-plugin`。License 使用 Apache-2.0，以便合法复用原 Context Map 中的 Apache-2.0 代码；NOTICE 明确引用 `haichangcharles/context_map`。

### 8.2 Durable 类型

`src/types.ts` 是 Host 和 Client 共用的纯类型出口，不导入 Node API、Cordis Service 或 React。

```ts
export type ContextPathId = Branded<'ContextPathId'>

export interface ContextPath {
  readonly id: ContextPathId
  readonly parentPathId: ContextPathId | null
  readonly anchorSeq: number | null
  readonly label: string
  readonly status: 'active' | 'archived'
}

export interface ContextNodeOverride {
  readonly seq: number
  readonly mode: 'include' | 'exclude'
}

export interface ContextPlanSnapshot {
  readonly kind: 'contextify/plan'
  readonly version: 1
  readonly revision: number
  readonly mainlinePathId: ContextPathId
  readonly activePathId: ContextPathId
  readonly paths: readonly ContextPath[]
  readonly overrides: readonly ContextNodeOverride[]
}

export interface ContextRoute {
  readonly kind: 'contextify/route'
  readonly version: 1
  readonly turn: number
  readonly pathId: ContextPathId
  readonly parentSeq: number | null
  readonly planRevision: number
}
```

Session Event keys为 `contextify/plan` 和 `contextify/route`。两者都是 required events，不设置 `ignorable: true`，因为遗漏它们会改变模型请求重建。

初始 plan revision 为 1，包含唯一 `root` path，并令 `mainlinePathId === activePathId === root`。每次成功 mutation revision 加一。Plan event 携带完整 post-change snapshot；route event 是每个 turn 的不可变归属事实，不是可变状态 delta。

### 8.3 Contextify Service

`ContextifyService` 扩展 `TypertRemoteService` 并注册为 `ctx.contextify`。公开 Remote 方法：

```ts
get(agent: Agent): ContextifyView
createBranch(agent: Agent, ref: ContextPlanRef, anchorSeq: number, label?: string): ContextifyView
selectPath(agent: Agent, ref: ContextPlanRef, pathId: ContextPathId): ContextifyView
returnToParent(agent: Agent, ref: ContextPlanRef): ContextifyView
returnToMainline(agent: Agent, ref: ContextPlanRef): ContextifyView
promoteToMainline(agent: Agent, ref: ContextPlanRef, pathId: ContextPathId): ContextifyView
renamePath(agent: Agent, ref: ContextPlanRef, pathId: ContextPathId, label: string): ContextifyView
archivePath(agent: Agent, ref: ContextPlanRef, pathId: ContextPathId): ContextifyView
setNodeMode(agent: Agent, ref: ContextPlanRef, seq: number, mode: 'natural' | 'include' | 'exclude'): ContextifyView
reset(agent: Agent, ref: ContextPlanRef): ContextifyView
graphPage(agent: Agent, request: ContextGraphPageRequest): ContextGraphPage
```

所有 mutation 使用 `{revision}` compare-and-set。稳定错误 code：`CONTEXTIFY_AGENT_NOT_LIVE`、`CONTEXTIFY_AGENT_BUSY`、`CONTEXTIFY_STALE_REVISION`、`CONTEXTIFY_PATH_NOT_FOUND`、`CONTEXTIFY_INVALID_ANCHOR`、`CONTEXTIFY_INVALID_NODE`、`CONTEXTIFY_LOCKED_NODE`、`CONTEXTIFY_INVALID_TRANSITION`、`CONTEXTIFY_INVALID_LABEL`。

Service 在 mutation 入口检查 exact live Agent、`agent.status === 'idle'`、ref revision、目标存在性和状态转换。校验完成后 append 一个完整 plan event，再发布 live notification。任何失败都不能写部分状态。

`archivePath` 拒绝 root、current mainline、active path 和仍有 active child 的 path。`reset` 创建新 revision，将 mainline 和 active 恢复 root、清空 overrides、保留 path 历史但全部非 root path 标为 archived；它不删除消息。

### 8.4 自动启用

Host root entry 在 apply 时调用 `ctx.contextCompiler.register({id: 'contextify', version: 1, select})`，registration disposer 由插件 fiber 所有。插件随后在 `agent/session-start` 上执行两项幂等初始化：没有 Context Plan 时 append revision 1；没有 `context/compiler=contextify` 选择时调用 `ctx.contextCompiler.select(session, 'contextify')`。

已有 Session 在安装插件后 resume 时，旧消息全部归入 root mainline。卸载插件后，已选择 contextify 的 Session 在下一次请求明确失败，不允许静默改变历史语义。

### 8.5 Turn Route

插件监听 `agent/pre-step` waterfall。监听器先 `await next()`，只有结果为 `enter` 且该 turn 尚无 route 时才 append `contextify/route`，然后原样返回 decision。

Route 的 `pathId` 来自当时 plan.activePathId，`parentSeq` 来自该 path 当前 tip 或其 anchor，`planRevision` 来自当时 plan。Route append 发生在 `step/start` 和 `user/message` 之前，因此后续同一 turn 的 user、assistant 和 tool-result message 都能稳定归属到该 route。

同一 turn 后续 tool step 不写第二个 route。Rejected pre-step 不写 route。已经写 route 后发生 abort 会留下一个未使用 route，fold 必须允许它且不得产生虚假节点。

## 9. Graph Fold 与 Compiler 算法

### 9.1 Graph Node

Graph fold 为每个可产生 Message 的 Session Event 建立内部节点：

```ts
export interface ContextGraphNode {
  readonly seq: number
  readonly messageId: MessageId
  readonly parentSeq: number | null
  readonly pathId: ContextPathId
  readonly role: 'user' | 'assistant'
  readonly sourceKind: string
  readonly locked: boolean
  readonly toolCallIds: readonly CallId[]
  readonly toolResultCallId?: CallId
  readonly shadowedBy?: number
}
```

`locked` 对所有非 `user`、`model`、`tool` source 为 true。UI 可以显示 locked 节点，但 Service 拒绝对其写 override。

### 9.2 Replay 规则

Fold 按 Session Event seq 顺序运行。没有 plan/route 的历史使用 root path。读到 route 后，该 turn 的 append-origin message 依次接在 route.parentSeq 后，并更新对应 path tip。Assistant 和 tool-result 使用 payload turn；user message 使用当前 open turn。

`surfaceOp: replace` 不删除原图节点。Fold 记录 replacement event 及其 shadowed seq，并在原节点上设置 `shadowedBy`。这样 UI 可以展开被 compaction 隐藏的原始内容，Compiler 仍能在安全条件下选择 summary 或原文。

Plan decoder必须验证版本、revision 单调递增、id 唯一、root 存在、父 path 无环、anchor 存在、active/mainline 指向 active path、override seq 唯一。Route decoder必须验证 turn、plan revision、path 和 parent tip；持久化损坏必须 fail loud。

### 9.3 自然路径

Compiler 从 active path tip 开始沿 `parentSeq` 回溯到 null，反转后得到 natural event seq。若 active path 尚无消息，tip 使用 path.anchorSeq。显式 include 加入节点；显式 exclude 删除节点。

Override 不改变 graph parent，不移动节点，不修改 transcript，只影响下一次编译。

### 9.4 当前 Turn 固定

当前 open turn 的全部 message events 无条件加入。由于编辑 API 在 running 状态拒绝，通常不会存在针对未来节点的 override；固定规则仍作为防御性保证，防止导入日志或未来调用路径删除本次请求刚进入的 prompt/tool result。

### 9.5 Tool Exchange 闭包

包含 assistant message 中任意 `tool-call` block 时，必须包含该 assistant message 发出的全部 call 以及每个已记录 matching tool-result。包含任一 tool-result 时，也必须包含发出同批 calls 的 assistant message和同批 results。

Exclude 命中 tool exchange 任一可编辑节点时，整组排除；include 命中任一节点时，整组包含。当前 turn 固定优先级最高。缺少 result 的未完成 group 只允许出现在 current open turn，已结束 turn 中的 dangling group 由 compiler invariant 拒绝。

### 9.6 Compaction

对每个 replacement 按 event 顺序处理：如果选中集合完整包含其所有 shadowed nodes，并且这些节点没有显式 include，则删除 shadowed nodes并加入 replacement summary event。若只选中了 shadowed range 的一部分，或用户显式 include 其中任一原始节点，则保留选中的原文，不加入可能混入其他 branch 内容的 summary。

Replacement 的排序位置使用最小 shadowed seq，而不是 replacement 自身较晚的 event seq。普通节点使用自身 seq。相同逻辑位置再以 event seq 排序，确保结果确定。

### 9.7 输出

Contextify provider 最终只返回 `eventSeqs`。它不创建、克隆或改写 Message。Harness ContextCompilerRegistry 负责验证和调用 `deriveEventMessage()`。

当 Session 只有 root plan、没有 override、没有 branch 且没有部分 compaction selection 时，Contextify 编译结果必须与默认 surface compiler 完全一致。这是迁移和默认体验的核心 compatibility test。

## 10. Session Projection 与 Graph 分页

### 10.1 小型 projection

插件注册 `contextify` SessionProjectionMap key，值只包含：

```ts
export interface ContextifyProjection {
  readonly plan: ContextPlanSnapshot
  readonly graphAsOfSeq: number
  readonly activeTipSeq: number | null
  readonly selectedCount: number
  readonly totalNodeCount: number
}
```

Projection 不携带全部 nodes，避免每个 history tail page 和每次 plan change 重发整张长对话图。

### 10.2 Graph page

`graphPage` 返回最多 250 条有序 `ContextGraphRecord`，请求字段为 `{afterSeq?: number, limit?: number}`。limit 缺省 250，范围 1–500。响应包含 `{asOfSeq, records, nextAfterSeq}`，没有更多记录时 `nextAfterSeq` 省略。

Record 包含 node 添加、replacement 关系和 path route 所需的稳定字段；文本 preview 最多 240 Unicode code points，完整聊天内容仍由 Conversation UI 所有。分页 cursor 是已处理的 Session Event seq，不是数组 offset。

Host 使用 WeakMap 缓存每个 live Session 的 graph fold watermark；新 event 只做增量 fold。读取旧持久化 Session 时从 log 构建一次。返回值在 Remote 边界 detached，不泄漏可变 cache。

### 10.3 Browser graph runtime

Browser 插件在 apply world 创建 React-free `ContextifyClientRuntime`。它按 sessionId 管理 observable graph source，首次订阅时分页读取全图；`contextify` projection 的 `graphAsOfSeq` 增长时，从当前 cursor 增量 catch up；断线或 cursor 不连续时清空并重新分页。

React 组件只通过 framework 绑定的 `useContextGraph` 和 `useProjection('contextify')` 读取数据。组件中禁止手写 `useSyncExternalStore`、直接 RPC、直接 Cordis ctx 或把 graph business state复制到 Zustand store。

## 11. Harness Web 右侧面板扩展

### 11.1 Core 修改

在 `packages/client/ui-conversation/src/client/contract/slots.ts` 增加：

```ts
'conversation.details.pinned': {
  kind: 'list'
  scope: 'session'
  owner: Record<string, never>
}
```

`packages/client/ui-conversation/src/client/apply.ts` 的 `details` registration 声明该 child slot。`DetailsPanel.tsx` 的 props 由四个 share 自动推导，加入该 slot 的 render authority。

该插槽是通用“常驻右侧会话面板”，不命名 Contextify。没有 registrant 时，DetailsPanel 的工具详情行为和截图必须保持完全一致。

### 11.2 布局行为

有 pinned panel 时，右栏分为上部 pinned area 和下部 tool drawer。无工具 selection 时 pinned area占满高度；有 selection 时 tool drawer 最大占 45%，可滚动并保留原 tool renderer。关闭 tool drawer只清除 chat selection，不关闭整个右栏。Pinned panel 自己提供关闭按钮，调用 `ctx.layout.closeDetails()`。

没有 pinned panel 时，tool details 占满右栏，原 close button 继续关闭右栏。选择工具仍调用 `layout.openDetails()`。

Contextify browser plugin 注册 pinned entry，并在首次拥有 current session 时调用 `layout.openDetails()`。用户关闭后不自动反复打开；客户端 viewing store 记录本次应用生命周期中的手工关闭状态，切换 session 不重置该选择。

### 11.3 Context Map Panel

Panel 使用 `@xyflow/react` 和 `dagre`，但必须按照 Harness client 规则使用 CSS Modules、`--dsw-*` semantic tokens 和中文产品文案。禁止 Tailwind、全局 body class、独立 React Context、组件内 Cordis import和原 Context Map 的全局 Zustand store。

第一版布局固定提供 tree、fit view、zoom、搜索、节点点击、创建 branch、三态 inclusion、return parent、return mainline、promote 和 path selector。Mindmap、timeline、多选删除、undo/redo、pattern extraction 和自动 suggestion 不进入第一版。

节点视觉状态固定：natural active、explicit include、inactive visible、explicit exclude、locked、compacted。颜色同时配合 icon/label，不只依靠颜色表达状态。键盘 Tab 可到达所有操作，Escape 关闭菜单，缩放不拦截页面普通滚动直到 pointer 位于 canvas。

点击图节点只定位/高亮 Chat 中对应消息，不改变 Context Plan。改变 Context Plan 必须通过明确按钮或菜单动作，并显示 pending/error。Agent running 时按钮 disabled 且 tooltip 说明“当前回复结束后可修改上下文”。

## 12. 数据流

一次普通发送的完整链路如下：

```text
用户在 Context Map 修改计划
  -> browser remote.contextify.*(sessionId, revision, ...)
  -> ContextifyService 校验 idle + CAS
  -> session.append('contextify/plan', fullSnapshot)
  -> session projection 推送新 plan

用户发送消息
  -> Harness ConversationController
  -> Agent inbox
  -> turn/start
  -> agent/pre-step
  -> Contextify route listener append contextify/route
  -> step/start + user/message
  -> ctx.contextCompiler.compile(session, turn, step)
  -> Contextify provider 返回 eventSeqs
  -> Registry 验证并 derive Message[]
  -> request/header 记录 compiler id/version
  -> 原 Harness llm.stream/tool loop
  -> assistant/message + tool/result 继续写同一 Session Log
  -> projection/graph runtime 增量更新右侧图
```

## 13. 故障与恢复

- Provider 未安装：请求在模型 I/O 前以 `COMPILER_NOT_FOUND` 失败。
- Provider version 不匹配：请求以 `COMPILER_VERSION_MISMATCH` 失败，提示安装匹配插件版本；不 fallback。
- Plan 或 Route 损坏：resume/fold 失败并指出 event seq；不忽略 required event。
- stale UI mutation：RPC 返回 `CONTEXTIFY_STALE_REVISION`，客户端读取最新 projection 并保留用户未提交意图供重新操作。
- running mutation：RPC 返回 `CONTEXTIFY_AGENT_BUSY`，不写 log。
- graph page 中断：Browser runtime 保留最后一致 snapshot，显示 reconnect 状态，恢复后从 cursor catch up；cursor gap 触发 full reload。
- Context Map UI 崩溃：slot error boundary只隔离 pinned entry，Conversation 和 Agent 继续工作。
- Contextify Host plugin 卸载：已选 Contextify compiler 的 Session 不能继续请求，但日志和普通 transcript仍可读取；重新加载插件后恢复。
- Upstream 修改 Agent Loop：rebase 冲突只允许集中在 compiler call site、header descriptor 和 invariant；如果冲突扩散到 Contextify领域文件，说明仓库边界被破坏，必须停止合并并修正架构。

## 14. 安全与一致性约束

- 所有模型可见输入必须来自 durable Session Event。
- Context Compiler Provider 不得合成 Message 或读取未记录的外部数据。
- 所有 plan mutation 必须 CAS，并在 Agent idle 时执行。
- 所有 branch/path id 使用 branded opaque id；客户端不得自行推断 id 语义。
- Graph page 只允许读取传入 Agent 对应 Session，不接受任意文件路径或其他 session id。
- UI 文本 preview 必须来自已授权 session history；不写 localStorage 持久副本。
- Tool call/result 始终按 exchange group闭包，不能向模型发送孤立 tool result。
- System prompt、tool schema、provider route 和权限策略完全由 Harness 原服务所有。

## 15. 测试策略

### 15.1 Harness Core 单元测试

- 默认 compiler 与 `deriveMessages()` 对任意合法 surface history 等价。
- register/dispose/HMR、重复 id、非法 version 和缺失 provider。
- 非法、重复、越界、log-only 和 null-deriving seq 被拒绝。
- provider 返回顺序被保留。
- Agent Loop 每 step 编译一次，retry 复用结果。
- request header 在 compiler 变化时写 change snapshot。
- invariant 对 messages 或 descriptor 篡改失败。

### 15.2 Contextify 纯算法测试

- 旧 Session 自动归 root。
- mainline、单层 branch、nested branch、return parent、return mainline、promotion。
- include/exclude/natural 三态。
- current turn 固定。
- 多 tool-call assistant 与 results 全组闭包。
- compaction 全范围使用 summary，部分 branch 使用原文，explicit include 恢复原文。
- plan revision、循环 path、错误 anchor、重复 route 和损坏 log拒绝。
- 编译确定性：同一 log 多次结果完全一致。

### 15.3 Service 与 RPC 测试

- 每个 mutation 的成功 snapshot、stale ref、busy Agent、非法 transition。
- session-start 初始化幂等。
- pre-step route 只写一次，reject 不写。
- graph page limit、cursor、增量和 detached ownership。
- Remote generated client 的全部方法和 error mapping。

### 15.4 GUI 测试

- 无 pinned plugin 时原 tool details DOM 和交互不变。
- pinned + 无 tool、pinned + running tool、pinned + settled tool 三种布局。
- agent running 时编辑 disabled。
- 点击 include/exclude 发出带当前 revision 的 RPC。
- stale/busy/network error 可见且不伪造成功状态。
- graph runtime 初次分页、增量 catch-up、gap full reload、dispose 后停止更新。
- keyboard、aria label、非颜色状态标识。

### 15.5 Real composition 与 snapshots

Harness Fork 必须提供 Loader 启动的 test-only composition，证明 external-style compiler registration 能改变真实 Agent request，同时 Agent Loop、tool execution 和 persistence仍使用官方实现。

Contextify 插件必须提供 `examples/contextify-web/cordis.yml`，使用 scripted model执行：mainline 两轮、从第一轮创建 branch、branch 一轮、返回 mainline再发送。Snapshot 必须同时固定模型收到的 event seq、Session Log 的 plan/route events和 Web Context Map 的可见状态。

可见 GUI 改动运行 `pnpm run test:gui` 和 `DSH_SNAPSHOT=replay pnpm run test:web`。Core capability运行相关 unit、typecheck、lint、build、hygiene 和 doc-sync。真实 provider smoke 在有 `DEEPSEEK_API_KEY` 时执行一轮 branch follow-up，缺 key 时 self-skip。

## 16. 分阶段交付

### 阶段 A：Harness Context Compiler

只增加 registry、默认 provider、Agent Loop consumer、header和 invariant。没有 Contextify 代码。完成标准是默认行为 snapshots 零意外变化，test-only provider 能选择 history 子集。

### 阶段 B：Harness Pinned Details Slot

只增加通用 slot 和工具 drawer共存布局。没有 Contextify 名称或依赖。完成标准是空 slot 完全保持旧 UI，测试插件能常驻右栏且工具详情仍可查看。

### 阶段 C：Contextify Domain 与 Compiler

创建外部插件 Host package，完成 plan、route、graph fold、compiler、service、projection和 RPC。先用 headless真实 composition验证，不写复杂 UI。

### 阶段 D：Contextify Browser Runtime

完成 graph paging、client observable runtime、projection追赶和错误恢复。用简单 JSON/debug panel验证数据，不开始视觉迁移。

### 阶段 E：Context Map UI

实现右侧 graph panel、branch/navigation/context controls，并接入 Chat 定位。只迁移第一版明确功能，删除所有 Demo-only 依赖。

### 阶段 F：完整验证与发布

运行 snapshots、build、hygiene、doc-sync、real API smoke；写安装说明、兼容矩阵和 upstream Discussion草稿；给插件仓库添加 `dsh-plugin` topic并发布 prerelease。

每个阶段使用独立 branch/commit序列。禁止把六个阶段压成一个 commit或一个不可单独回退的 PR。

## 17. Upstream 同步策略

Fork 的 `master` 永远只 fast-forward 官方 `upstream/master`，不直接开发。功能分支从 fork master rebase：

```bash
git fetch upstream --tags
git switch master
git merge --ff-only upstream/master
git push origin master
git switch codex/contextify-harness
git rebase master
```

Harness Core 的两个阶段分别保持可独立 cherry-pick。Contextify 插件仓库通过 peer dependency 声明支持的 Harness version range，并在 CI 中测试最低支持版本和最新 fork master。

当 upstream 原生提供等价 Context Compiler 或 pinned panel slot 时，先写 adapter使插件同时兼容旧 fork接口和 upstream接口，再删除对应 Fork patch。禁止长期同时维护两套 Agent Loop。

## 18. Agent Note 与文档

阶段 A 新增 proposed architecture Agent Note，记录可插拔历史选择、事件 seq输出限制和默认等价性。实现完成时移动到 implemented并改写为当前事实。

阶段 B 新增或更新 GUI slot architecture Agent Note，记录 pinned area 与 tool drawer 的所有权。每个新增 Harness package 更新 README、Model Experience、KV Cache effect、Known Limitations和 invariant companion。

Contextify 插件 README 必须包含安装、profile overlay、数据语义、卸载后行为、版本兼容、隐私和已知限制。Upstream Discussion 只提通用 capability，不要求官方接受 Contextify 产品逻辑。

## 19. 验收标准

全部条件同时满足才算完成：

1. 未安装 Contextify 时，Harness 的模型 messages、工具行为、CLI、Web 和 snapshots 与 upstream默认语义一致。
2. 安装 Contextify 后，所有 Agent 请求仍由官方 Agent Loop执行。
3. Context Map 显示的 selected seq 与 Context Compiler 实际 eventSeqs一致。
4. branch 创建不产生新 Session 或 Agent。
5. include/exclude 真实改变下一次模型请求，并在 log replay 后得到相同结果。
6. 工具调用组不会出现孤立 call/result。
7. compaction、resume、fork seed、retry、cancel和多 step tool turn有覆盖。
8. Context Map 与 Chat 同屏，工具 details 仍可访问。
9. 长对话 graph 使用分页和增量更新，不把全图塞入 session projection。
10. Fork 能在一次演练中同步最新 upstream master，冲突仅出现在预期薄扩展文件或完全无冲突。
11. 所有相关 unit、coverage、GUI、snapshot、typecheck、lint、build、hygiene和 doc-sync检查通过。
12. 插件有独立仓库、Apache-2.0 LICENSE/NOTICE、`dsh-plugin` topic和可复现安装说明。

## 20. 明确延期

以下能力在基础验收后另开规格，不允许执行模型自行加入：AI branch suggestion、自动 summary、pattern/SOP extraction、节点删除、编辑历史消息、多人协作、跨 Session context、语义搜索、向量数据库、移动端专用布局和多选批处理。

延期不影响核心架构：自动摘要必须先写 durable message event，跨 Session context必须先写带来源的 recall event，之后同样通过 Context Compiler选择 event seq。

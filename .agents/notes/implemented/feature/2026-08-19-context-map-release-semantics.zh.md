# Agent Note: Context Map 发布语义

Status: implemented

[English](2026-08-19-context-map-release-semantics.md) | 中文

## 问题

Context Map 已经可以投影原生 Session fork 并控制模型 context，但仍有四个上线关键边界不清楚：Agent recommendation 会因为无害动作整体失败，也更像逐项修改而不是审核完整版本；删除消息语义可能破坏 graph structure；重复 fork 的 Session 可能呈现出虚假的嵌套；Branch routing 建议及其 prompt 缺少持久、可由用户控制的产品合同。

## 决策

Context selection recommendation 现在是一份 Current → Proposed 替换。隔离 Agent 可以分两阶段思考——先移除 included 集合中无关的节点，再加入 off-path 的相关节点——但 validator 会把结果与当前有效集合比较并返回一份规范化 diff。重复 no-op 会消失，未知节点和冲突动作会失败。Apply 只写一个 plan revision，一次 Undo 就能恢复此前版本。

Archive 是独立、可恢复的单消息操作。它只接受真实 user input 或 completed Turn 的最终 assistant output，保留 node、role、edge、原生 fork boundary 与 append-only 原事件，只把模型可见内容替换为服务端拥有的固定标记 `[Placeholder: intentionally empty]`。Recommendation Agent 可以谨慎建议 Archive，但只有用户逐项确认才会执行。

Family projection 按真实 fork boundary 规范化 Session 祖先关系。在继承自 parent 的 boundary 上再次 fork，会与此前 branch 并列显示；在 branch 自己新增的 boundary 上 fork，仍是它的 child。该规则只改变导航层级，不引入第二套 branch store。

自动 Branch review 默认关闭，因为开启后每个 completed Turn 会增加一次模型调用。开启时，一次有界、禁用工具的辅助调用会在 parent Agent idle 后运行，不创建可见 subagent，也不进入 Agent loop。只有高置信度的离题或平行 Q&A 才会在最终 output 旁产生持久建议。用户接受后，服务会拒绝过期 source、归档源端两条消息、在前一个 completed boundary fork 确定性的原生 child、精确回放 Q&A，并记录幂等 marker。重试会返回同一个 child，不会重复搬迁。

Profile Settings 分别拥有 Context、Archive 与 Branch 三类 prompt。Package prompt 默认可见但只读；Additional instructions 是常规扩展入口。完整替换需要 UI 显式确认，恢复 package baseline 时保留追加规则。所有 review 都复用已有 Harness spawn provider 与 parent route，不建立第二套 Agent runtime。

Web surface 把 Archive 和 context selection 作为独立控制，使用一份不透明右键菜单，原子应用推荐版本，并保持 Branch suggestion 非模态。搬迁后 source graph pivot 仍然可见，因为归档消息是结构性 placeholder。

## 验证

Host 测试覆盖规范化、冲突拒绝、no-op 过滤、原子 Apply/Undo、Archive/Restore、规范化 sibling/child 祖先关系、one-shot Branch decision、过期拒绝、精确 Q&A 回放与幂等重试。Client 测试覆盖 Current/Proposed sheet、Archive 确认与菜单操作、Prompt Dashboard 解锁和持久化，以及 Branch suggestion 接受。仓库 typecheck、Contextify/Workspace 聚焦测试、GUI replay、Web replay 与浏览器验收共同构成上线 gate。

## 曾考虑的替代方案

**逐条应用 recommendation action。** 拒绝，因为用户实际上是在两个 context 版本之间选择。部分接受会让 proposal 更难理解，也会破坏一步回滚。

**删除 archived node，或让 Agent 编写替换文本。** 拒绝，因为删除可能切断 branch pivot，而生成文本会引入新语义。固定、保持 role 的 placeholder 更确定，也可恢复。

**为 Branch routing 运行完整或可见的 subagent loop。** 拒绝，因为它只是 successful Turn 后的有界分类。显式开启、禁用工具的辅助调用不会延迟主对话、污染 subagent 列表，也不会默认改变普通 Harness 的模型调用行为。

**保存第二套 Context Map branch hierarchy。** 拒绝，因为原生 Session 已经拥有祖先关系和持久化。规范化 projection 可以解决视觉歧义，无需复制 branch state。

## 后果

用户可以比较完整 context 版本，不会因为节点已选中而承受可靠性惩罚；破坏性的语义清理仍然显式且可恢复。Branch 导航遵循原生 Session 事实，自动 routing 保持轻量，每类 Agent policy 都能按 Profile 调整。跨 Map import、自动执行 Archive 与多步 Branch loop 仍明确不在范围内。

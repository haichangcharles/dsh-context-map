# Agent Note: Context Map 双模式 recommendation

Status: proposed

[English](2026-08-20-context-map-dual-mode-recommendations.md) | 中文

## 问题

Context Map 审阅需要服务两类不同需求。多数审阅应依据当前对话目标和少量相关 branch 快速返回；有些审阅则需要检查庞大的原生 Session family、沿拓扑查找、比较远处的替代路径，并在提出 context 替换版本前识别已被取代的消息。使用一次直接模型请求读取完整 graph，会让常用途径变慢、消耗大量提示词，并在模型未返回有效 JSON 时产生明显失败。

自动 Branch 审阅存在一个相关但范围更窄的问题。已完成 Turn 可能是局部延续、可拆分的旁路调查或平行话题，但当前分类器只看到最近四条消息预览和已完成的 Q&A。它缺少当前 branch 目标、祖先目标、branch 深度与 branch 负载，因而无法区分有用的 branch 和不必要的打扰。

产品需要为 Context recommendation 提供显式的 Fast／Deep 选择，同时让 Branch recommendation 保持轻量。两种 Context 模式必须生成同一种只供审阅的提案，维持原生 Session 和 Context Plan 的职责归属，并且在用户确认前绝不改变 selection 或 archive 状态。

## 提案

Context Map 提供两种由用户手动选择的 Context recommendation 模式。Fast 是默认模式，使用一次有界、无工具的模型请求。Deep 是显式用户操作，会基于冻结的 Context Tree 文件启动临时 Harness agent（智能体）。系统绝不自动把 Fast 升级成 Deep，也绝不把 Deep 用于 Branch recommendation。

两种模式返回相同的 selection 和 archive 决策字段：

```json
{
  "exclude": [{ "nodeId": "...", "reason": "..." }],
  "include": [{ "nodeId": "...", "reason": "..." }],
  "archive": [{ "nodeId": "...", "reason": "..." }]
}
```

Contextify 验证每个节点都属于被审阅的 graph，拒绝冲突动作，移除无害 no-op，计算完整的 Current 和 Proposed 节点集合，并且在用户应用提案前不记录 Context Plan 事件。Apply 仍然是一次原子 selection 替换，并保留现有 Undo 行为。Archive 项仍只供建议，且需要逐项确认。

## Fast recommendation

Fast recommendation 采用 topic routing 设计，而不是序列化完整 graph。Contextify 根据最新目标、active branch 目标、祖先 branch 概述、active path 上最近三个已完成 Turn、所有显式 Include／Exclude override，以及按词法相关性和 graph 距离排序的少量 off-path 候选，构造有界审阅数据包。数据包为其中的节点保留 node ID、role、有效 inclusion、active-path membership 和 parent／child reference。

一次无工具模型请求接收该数据包和有效的 Context recommendation 提示词。该模式使用 temperature zero、路由可用的最低 reasoning effort、严格输出 schema 和有界输出预算。它只能推荐数据包中存在的节点。格式错误或不可用的响应保持当前 context 不变，并显示不会遮盖画布的简洁失败信息。

用户显式 selection 优先于自动审阅。显式 Include 作为 pin，显式 Exclude 作为 block。Fast recommendation 不会反转这两种状态。Reset 会移除这些 override，并让节点恢复到自然 active-path 行为。

## Deep recommendation

Deep recommendation 在一个 graph revision 和一个 Context Plan revision 上冻结完整的可见 Context Tree。快照只包含已经符合 Context Map 展示条件的用户 input 和最终 assistant output 节点；reasoning、tool call、tool result、system injection 与 runtime-only event 继续排除。每条节点记录包含稳定 node ID、role、完整文本、原生 Session ownership、active-path membership、有效 inclusion、显式 override、archive 状态，以及 incoming 和 outgoing graph reference。

Contextify 在用户 Workspace 之外创建进程临时目录，把快照写成一份私有 JSONL 文件，并启动一个 one-shot in-process Harness child，其 Session cwd 指向该目录。在平台支持 POSIX 权限时，目录使用 `0700`，文件使用 `0600`。JSONL 只是内部实现选择；系统不引入持久或公开文件格式。

child 只获得原生 `read`、`grep` 工具，以及 subagent runtime 自动附加的 structured-output tool。child-scoped pre-execution policy 会解析每个请求路径，并拒绝访问确切临时快照文件之外的位置。child 使用 read-only sandbox 和 approval 设置，不能调用 Bash、写入或编辑文件、访问 Web 工具、启动 subagent、检查用户 Workspace，也不能改变实时 Context Map。

Deep 提示词要求 child 先检查当前 included 集合中显著无关或冲突的节点，再在其余 tree 中搜索缺失的相关节点，并且只为明显过时或已被反驳的内容建议 archive。agent 可以执行多次有界 `grep` 和 `read` 调用，随后必须提交与 Fast 相同的结构化结果。可配置 timeout 和 step budget 会限制延迟与成本。

Contextify 使用同一个由 `finally` 负责的生命周期，在成功、无效输出、取消、超时、stale 状态和基础设施失败时 dispose child 并删除临时目录。应用启动时还会删除超过有界保留期限的 Contextify 临时目录，避免进程崩溃后无限期留下快照。

## 共享提示词与验证

Prompt Dashboard 保留一份由 Fast 和 Deep 共用的 Context recommendation policy。只读 package prompt 定义 selection 含义；普通可编辑字段追加 profile instruction；现有显式 override 供高级用户替换 package policy。模式专属说明、工具限制、不可信节点处理和输出 schema 仍由 package 拥有，profile 文本无法删除它们。

完整 Proposed 版本由 validator 而不是模型构造。在 Include 中返回已经 included 的节点，或在 Exclude 中返回已经 excluded 的节点，都属于无害 no-op。未知 ID、重复 archive 项，以及同一节点上的相反 selection action 仍然无效。提案会携带模式和被审阅的 revision，用于展示和 stale 拒绝，但模式不会改变 Apply 语义。

## Branch recommendation

Branch recommendation 保持为一次轻量、无工具的分类器。它在用户 input 被接纳后与主响应并行启动，并先把 input 与当前局部目标比较，再考虑祖先或 mainline 目标。它的有界输入包含当前 branch 目标、祖先概述、最近已完成 Turn、branch 深度、active branch 数量和近期 sibling branch intent。

默认决策是 Keep。分类器只会为有意义的局部 topic change、可拆分 subtask、平行替代方案，或可能产生后续 Turn 的临时 detour 建议 Branch。更高的 branch 深度和 branch 负载会提高展示阈值。失败、无效输出、取消、主 Turn 未成功，或 Session 已变化时，会静默解析为 Keep。

最终 assistant output 持久化后，仍然有效的 Branch 决策可以渲染一条附着于该 Q&A 的 inline suggestion。接受会通过原生 Session fork 和 relocation 路径移动确切 input 与最终 output。拒绝和过期不会改变对话；相应反馈可供 profile-owned Branch policy 使用，但不会启动更深的 agent 审阅。

## 客户端交互

Context Map recommendation control 提供 Fast 和 Deep 操作。每次调用时 Fast 在视觉上都是默认项；客户端不持久化上一次选择，也不会自动升级。同一个 Session family 同时只能运行一项 recommendation。Deep 提供 Cancel 和简洁进度状态，说明 agent 正在检查 tree，但不会在画布上渲染其内部工具 transcript（文本记录）。

Fast 和 Deep 打开同一个 Current／Proposed 审阅 sheet。该 sheet 标出模式，把新增和移除节点展示为一个替换版本，把 Archive suggestion 单独展示，并保留 Apply、dismiss 和 Undo 行为。Recommendation 失败使用非阻塞 notice；只有此前 ready proposal 所审阅的 revision 仍然有效时才保留它。

## 错误处理与验证

每种模式都在分析前捕获 graph 和 plan revision，并在分析后重新检查。原生 Session family 中任何位置发生变化都会使结果 stale。Deep 工具访问快照之外的位置、结构化结果无效或模型路由缺失时都会安全失败，不应用任何动作。

Package 测试覆盖 Fast candidate bound 和排序、显式 pin 和 block 保留、共享 no-op 和冲突验证、Deep snapshot 完整性、路径拒绝、结构化完成、取消、超时、每条 cleanup 路径和 stale-family 拒绝。Client 测试覆盖模式选择、Fast 默认、Deep 取消、进度、非阻塞失败、一致的审阅渲染、Apply 和 Undo。无密钥的 assembled Web replay 会通过真实 Context Map control 执行两种模式，并确认 recommendation 本身不改变状态。

## 考虑过的替代方案

**使用一次完整 graph 模型请求。** 这种方式只有一条代码路径，但会在模型提示词中重复完整 graph，使延迟随 tree 文本总量增长，并保留促成本次变更的格式错误响应问题。

**提供永久 Context Tree query tool。** 稳定的工具 API 可以避免临时文件，但它会为内部审阅任务新增公开能力和维护约定。临时文件让 child 使用已有 Harness 工具，并随运行一同消失。

**从 Fast 自动升级到 Deep。** 自动升级可以处理不确定的 Fast 决策，但会让延迟、成本和工具使用不可预测。因此 Deep 始终由用户显式选择。

## 验收标准

- Fast 是默认的手动 Context recommendation，绝不启动使用工具的 agent。
- Deep 使用一份冻结的临时 Context Tree 文件、原生 `read` 和 `grep`、结构化输出、严格路径限制和完整 cleanup。
- 两种模式都生成一份经过验证的 Current／Proposed selection 版本和独立的 advisory Archive 项，并且在 Apply 前不改变状态。
- 显式 Include 和 Exclude override 会在 recommendation 中保留，直到用户 reset 或修改。
- Branch recommendation 使用轻量 topic classifier，与主响应并行运行，并在失败时静默返回 Keep。
- 聚焦 package、client 和无密钥 assembled replay 覆盖会固定用户可见行为与生命周期行为。

## 风险

Fast candidate selection 可能遗漏远处的相关节点；Deep 是显式的 full-tree 替代方案。Deep 会消耗更多时间与 token，并且仍可能作出不佳的语义判断，所以结果继续只供审阅。临时快照包含对话文本；严格权限、确切路径工具策略、有界保留期 cleanup 和非持久放置可以降低暴露，但无法消除进程内存或存活 child 的全部风险。保守的 Branch 阈值会以遗漏建议为代价减少打扰。

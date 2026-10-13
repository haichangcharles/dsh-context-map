# Agent Note: Context Steward 策略记忆

Status: implemented

[English](2026-10-12-context-steward-policy-memory.md) | 中文

## Problem

长对话需要反复决定 Include、Exclude 和 Branch。通用 Context 推荐器无法区分用户对 Web 导入和旧聊天消息的不同偏好；没有依据的 persona 摘要还可能把模型建议或用户忽略的卡片误当成用户选择。

## Decision

Contextify 从同一 DSH Profile 下多个原生 Session 家族的已确认 Context 管理事件投影出紧凑的策略记忆。继承的事件前缀不会重复计数。一次多项审阅的总权重为一；确实改变状态的直接节点选择、已确认的 Branch Keep/Move 与路由卡选择，以及成功的 Context Map 手动 fork 都形成明确观测。手动 fork 在草稿成功转移后记录有界草稿；草稿中的任务类型线索用于归类 Branch 观测，空草稿或旧事件不归类。Undo 会从当前投影中移除对应的 Plan 选择。仅展示卡片和未标记的 Remote 调用不会训练策略。发生变化的家族从事件日志重建，未变化的家族复用缓存。

投影采用平滑的动作估计。当活动、来源类型或邻近分支深度的分组少于四次有效观测时，退回 Profile 总体估计。同一动作的重复选择只有在有效观测达到四次后才形成有类型的偏好或回避规则。原生事件日志仍是证据记录；摘要报告证据量，不能授权修改 Session 或 Context Plan。`stewardProfile` Remote 提供可检查的投影。Navigate 和 Return 只从明确的路由卡选择获得证据。[关闭时明确拒绝的条目](2026-10-10-selective-context-review.zh.md) 形成分数权重的拒绝证据，即使历史家族中没有已应用编辑也会读取；Later 和未决定的条目不提供标签。拒绝用于校准被建议的动作，不会变成相反动作的正向风格案例。

Fast Include/Exclude 建议也使用同一 Profile 中最近 32 条已确认且未被 Undo 撤销的编辑。带类型的来源、工具动作与路径偏好，加上强收缩的相关性残差，可以在新的 Session 家族中排序跨分支来源及活动路径上的较早来源，并校准待审建议。模型可见的 Fast 案例及成组计划仍只来自当前家族，因此其他无关 Session 的原文不会作为偏好案例发给模型。Host 从事件日志重建这个派生视图，不额外持久化第二份 persona 文档。

这里把 [Generative Agents](https://arxiv.org/abs/2304.03442) 的观测、反思、检索模式和 [Mem0](https://arxiv.org/abs/2504.19413) 的整合思想用于 Context 管理策略。系统不存储一般个人事实，也不声称这些借鉴机制本身是新方法。

## Alternatives considered

**把全部对话文本总结为一段 persona。** 任务内容不是 Context 管理偏好的证据，自由文本摘要也会掩盖证据量与反向选择，因此没有采用。

**把每次展示的建议都当作反馈。** 展示和沉默不能证明用户关注或拒绝；确定性展示也没有已知曝光概率，因此没有采用。

**对全部来源只用一个全局偏好。** Web 证据、聊天历史和 worker 报告可能得到不同选择，因此没有采用。

**根据下一次发送的消息推断手动 Branch 的目的。** 之后的消息可能不同于转移时的草稿，也会在按时间顺序回放策略时泄漏未来信息，因此没有采用。

## Consequences

Host 无需模型调用即可跨 Session 检查反复确认的偏好，审阅阈值能够保守地适应用户。稀疏或未观测动作保持先验。明确触发的发送前路由卡与 Navigate/Return 反馈已经接入。记录手动 Branch 的未发送目标会把敏感草稿写入原生 Session 日志，和其他 Context 建议一样最多保留 4,000 个字符；用户可检查由此得出的动作规则。Persona2Web 的独立家族回放检查了工程迁移链路，但未证明优于简单条件表、改善下游 Web 任务成功率或获得无偏离线 bandit 估计。

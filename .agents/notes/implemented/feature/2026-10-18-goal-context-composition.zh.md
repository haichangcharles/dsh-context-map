# Agent Note: 目标归属与 Context 组合

Status: implemented

[English](2026-10-18-goal-context-composition.md) | 中文

## Problem

独立任务适配分数可能在所有 Branch 门槛上，都把任务内回复排在真正的新任务之上。调整共享阈值无法修复这种倒序。研究脚本覆盖私有评分器，也不能证明发布的 Host、偏好投影与 Web 审核能协同工作。

## Decision

可选设置 `goal-model-jev` 将类别式任务归属与 Context 成员判断分开。当前聊天模型接收有界原生任务证据、精确草稿、组织策略和已确认管理案例，仅返回简短目标、new/existing/unknown 归属及已提供的 Session ID。Host 保留证据，校验完整 JSON 对象、任务库存和模型正常结束。不确定时不调用 Jev，也跳过推断式 Context 校准；用户明确命令仍沿用普通原生解释。已知归属作为引用的任务数据进入现有 Jev 请求。消息归属、证据与替代问题以该目标为依据；其中的当前任务证据来自已分配的已有任务，新任务则为空。新任务归属指向父节点，不意味着整体继承该任务。目标本身不授予来源归属；明确的整任务策略、手动选择与原生校验仍具有权威性。已知归属与独立校验的 Jev 成员及替代证据组合。单位路由分数表示选中的类别，不是校准置信度。

该设计迁移 [IntentGPT](https://arxiv.org/html/2411.10670v1) 的已知／新意图复用、[Schema-Guided Dialogue](https://ojs.aaai.org/index.php/AAAI/article/view/6394) 的动态自然语言任务库存，以及 [SayCan](https://arxiv.org/abs/2204.01691) 中语义提议与执行约束分离的思路。不复现其完整算法或声称其基准结果。原生任务卡对应意图库存，已确认用户操作提供示例。用户模型仍使用现有事件投影及关闭、重置、Undo 语义，不另建不透明的人格库。

Host 在消耗目标调用前检查必需的 Jev 凭据；凭据解析参与取消。每份草稿在整体 45 秒内使用一次当前模型及至多一次 Jev 请求，不重试或回退。非草稿 Fast 检查只使用 Jev。默认 Local 与默认 parent-model Fast 不变。[Context Steward 指南](../../../../docs/user/guide/context-steward.zh.md) 和双语设置说明选项及费用。

此决定部分替代[审核操作记录](2026-10-13-context-steward-reviewed-actions.zh.md)中对额外路由模型的否决。旧记录对 Local、普通 Fast、Deep、生命周期和审核归属仍有效。[个人决策案例](2026-10-15-personal-context-decision-cases.zh.md)与[范围交接](2026-10-16-context-scope-route-handoff.zh.md)继续约束来源、手动固定、替代、原生操作 DAG、修订和明确确认。不改变持久 Session 格式。

## Alternatives considered

**只调 Branch 阈值。** 已观察到排序倒置，无法用共享阈值区分正例和在各分数上占优的负对照，因此否决。

**始终增加模型或强制类别答案。** 额外费用需要主动选择，证据不确定时应弃权。默认路径和非草稿 Jev 路径保持原有请求数。

**让生成文字拥有来源 ID 或绕过原生策略。** 模型只提议任务归属；图成员、手动约束、来源及确认仍由 Host 负责，因此否决。

## Consequences

额外目标调用增加费用和延迟。既有缓存案例仅证明组件集成，不是新提示词、弃权或个性化效果的全新验证。原生运行测试覆盖父节点 Branch 范围、返回／重新激活、案例关闭／重置、畸形及截断输出、取消，以及存在匹配历史选择时的弃权。组合 Web 测试使用明确合成的提供商响应，覆盖真实 Loader、传输、草稿转移与已批准范围。Fixture 和缓存回放均不证明泛化或回答质量。

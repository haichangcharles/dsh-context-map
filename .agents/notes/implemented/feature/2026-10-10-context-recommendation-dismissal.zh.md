# Agent Note：Context 建议的呈现与关闭反馈

Status: implemented

[English](2026-10-10-context-recommendation-dismissal.md) | 中文

## 问题

此前关闭 Context 审核面板只会清除临时建议，不产生 Session 事件。个人 Context 策略能看见接受编辑，却无法区分建议已渲染、明确关闭、沉默、取消、错误，或建议根本没有到达 Client。

## 决策

未过期面板在可见 Client 文档中渲染时，把准确的待审建议交给 `presentRecommendation`；Host 对仍有效的每份建议只记录一次 `contextify/recommendation-presented`。关闭按钮调用 `dismissRecommendation`；Host 拒绝不存在或不匹配的建议，记录包含模式、修订范围基准与节点动作的 `contextify/recommendation-dismissed`，随后消耗待审建议。两个事件都不修改 Context Plan 或图版本。Client 声明 `uiOrigin: contextify-client`；它标识客户端路径，不代表已认证的用户。清除错误与取消正在运行的审核仍只清除临时状态。[逐项审核](2026-10-10-selective-context-review.zh.md) 保留明确拒绝项的 ID 与有界目标，供策略学习使用；单纯关闭不提供偏好标签。

每次通过准入检查的 Host 建议持有一个不透明的 `recommendationTraceId`。既有辅助请求、呈现、审核、关闭和路由选择事件携带此标识；Goal 与 Jev 阶段共用一个值，Carry 跨来源和目标 Session 保留同一值。该值由既有 proposal 元数据持有，私有函数显式接收它，取消不会把旧请求挂到下一次操作。它不进入模型提示或公开 proposal，不改变图/Plan 版本和学习权重，也不授予新权限。旧记录可缺省；Local/Deep 操作可能没有辅助请求记录。

此标识表示 Host 实际消费的待审建议，不代表原始 Client 点击。连续两份 proposal 可能深度相等，延迟到达的等值 Client 参数仍可按既有校验消费当前建议。这类回调记录当前 Host 标识；原始呈现或点击属于哪次请求仍未知。原生日志关联不认证人的身份、注意力或完整跨 Session 输入快照。

## 考虑过的替代方案

**从建议生成推断呈现。** 建议可能根本没有到达可见的 Client 面板，生成不能证明呈现。

**把关闭视为拒绝全部动作。** 用户可能只是暂缓审核，这会制造错误的逐项负标签。

## 后果

Client 声明的面板呈现和明确关闭是两种独立的持久事件；原建议仍须审核。呈现事件存节点 ID 和动作；只有明确拒绝了某项时，关闭事件才额外保留审核草稿。过期或丢失的建议不会形成呈现或关闭事件，需要重新审核。可见文档中的渲染不证明人实际看过或读过面板；关闭可能表示稍后再看，不能当成每个节点的负标签。学习既不能只从“建议已生成”推断曝光，也不能只从“面板已关闭”推断每项都被拒绝。

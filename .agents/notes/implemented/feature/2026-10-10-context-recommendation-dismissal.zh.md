# Agent Note：Context 建议的呈现与关闭反馈

Status: implemented

[English](2026-10-10-context-recommendation-dismissal.md) | 中文

## 问题

此前关闭 Context 审核面板只会清除临时建议，不产生 Session 事件。个人 Context 策略能看见接受编辑，却无法区分建议已渲染、明确关闭、沉默、取消、错误，或建议根本没有到达 Client。

## 决策

未过期面板在可见 Client 文档中渲染时，把准确的待审建议交给 `presentRecommendation`；Host 对仍有效的每份建议只记录一次 `contextify/recommendation-presented`。关闭按钮调用 `dismissRecommendation`；Host 拒绝不存在或不匹配的建议，记录包含模式、修订范围基准与节点动作的 `contextify/recommendation-dismissed`，随后消耗待审建议。两个事件都不修改 Context Plan 或图版本。Client 声明 `uiOrigin: contextify-client`；它标识客户端路径，不代表已认证的用户。清除错误与取消正在运行的审核仍只清除临时状态。现有个人策略暂不把关闭当成负训练样本。

## 考虑过的替代方案

**从建议生成推断呈现。** 建议可能根本没有到达可见的 Client 面板，生成不能证明呈现。

**把关闭视为拒绝全部动作。** 用户可能只是暂缓审核，这会制造错误的逐项负标签。

## 后果

Client 声明的面板呈现和明确关闭现在是两种独立的持久事件；原建议仍须审核。事件只存节点 ID 和动作，不存消息正文。过期或丢失的建议不会形成呈现或关闭事件，需要重新审核。可见文档中的渲染不证明人实际看过或读过面板；关闭可能表示稍后再看或否决整张面板，也不能当成每个节点的负标签。后续学习既不能从“建议已生成”推断曝光，也不能从“面板已关闭”推断每项都被拒绝。

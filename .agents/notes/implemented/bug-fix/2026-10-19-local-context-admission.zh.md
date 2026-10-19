# Agent Note: Local Context 审核的候选准入

Status: implemented

English | [中文](2026-10-19-local-context-admission.md)

## Problem

反复手动排除 Context 可能超过 Fast 分类器的32个必选节点预算。零模型 Local 审核与它共用模型数据包准入路径，会使原生图和 Plan 仍然有效时的 Branch/Return 无法使用。

## Decision

[Contextify](../../../../packages/context/contextify/README.zh.md)直接从原生图元数据、有效选材和已有词法特征派生 Local 校准候选。它不把来源文本复制到数据包中，也没有推理候选数量上限。在自动纳入候选排序前保护直接 Exclude；已审核的临时 Exclude 仍可作为恢复候选。现有校准仍最多提出两个纳入和两个按风格排除的建议，原生验证保留手动约束。Local 保留有界任务卡、偏好规则、弃权和明确路由批准；不调用模型，也不构造 Fast 请求。Fast 保留既有32节点上限及派发前失败行为。

## Alternatives considered

**提高或静默截断 Fast 必选候选预算。** 拒绝，因为 Local 不进行推理，不能据此改变模型协议或隐藏手动固定约束。

**跳过 Local 偏好校准，或只修改失败测试。** 拒绝，因为大量手动操作后，产品仍须保留学到的管理行为。独立的免模型候选特征移除了错误耦合。

## Consequences

长期手动 Context 历史仍可使用 Local 路由和校准。标量投影的工作量随图大小线性增长，不克隆完整来源内容。所属回归覆盖33个直接 Exclude、保持不变的 Fast 拒绝、Local Branch/Return 携带已批准的编译后消息，以及零模型请求。真实 Loader 验收覆盖具有大量设置的原生 Plan。这些是工程检查，不是新的自动 Branch 准确率证据。

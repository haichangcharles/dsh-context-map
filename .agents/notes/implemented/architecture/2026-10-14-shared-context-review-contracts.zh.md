# Agent Note: 共用 Context 审核契约

Status: implemented

[English](2026-10-14-shared-context-review-contracts.md) | 中文

## Problem

不同 Context 审核模式重复实现原生图邻接关系、来源内容字段和分类器 JSON 提取。Session 家族修订以及 Branch、摘录审核也重复相同校验。Prompt Dashboard 还单独复制了 Host 的不可变默认值。CI 发现十一处重复，独立实现可能随上下文行为演进而分歧。

## Decision

Local、Fast 和 Deep 共用纯拓扑及来源内容投影；选择与可选语义路由共用 JSON 外层提取，但保留各自严格的 schema 校验。自有策略时间线保留原生事件位置和 Undo 来源。Service 共用仅审核事件谓词、Branch 来源检查和活动摘录节点检查，不改变修改顺序或错误。

Client 从现有浏览器安全的 Contextify types 子路径重新导出不可变默认值及有效提示词纯函数。浏览器纯度检查只允许这个精确子路径；Host 根入口、嵌套 types 路径和 Branch 工具仍被拒绝。共用契约的类型导入不会加载 Host 服务。重复代码阈值及例外保持不变。

## Alternatives considered

- **忽略重复范围。** 这会保留独立维护的策略副本并削弱 CI。
- **在 Client 导入 Host 服务。** 这会违反浏览器边界并打包无关运行时状态。
- **共用完整的模式数据包。** 不同候选预算与 Deep 全树行为必须保持区别。

## Consequences

默认提示词有唯一来源，共用审核纯函数保留相同数据包值和失败语义。各模式的路由、预算、公开校验、用户确认与原生 Session 修改仍分开。这次整理不增加模型调用或自动行为。

## Testing

未修改的重复配置扫描 packages 和 scripts，结果为零重复。Contextify 领域回归保留修改源码逐文件完整覆盖。提示词设置测试验证共用默认值和预览行为；Client 纯度回归允许精确的纯契约入口，并拒绝相邻 Host 入口。

## Related

- [Contextify](../../../../packages/context/contextify/README.zh.md)
- [Client bundle 纯度测试](../../../../scripts/client-bundle-purity.spec.ts)

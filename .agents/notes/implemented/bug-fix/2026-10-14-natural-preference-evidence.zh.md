# Agent Note: Natural 上下文选择提供偏好证据

Status: implemented

[English](2026-10-14-natural-preference-evidence.md) | 中文

## Problem

长对话可以借用其他分支的证据，通过 Natural 撤回，再在之后借用。Context Plan 和个人 Context 排序器正确记录了这些变化，但 Profile 投影遗漏了所有 Natural 选择。因此，Recent choices 和 Include/Release 证据量隐藏了排序器已经学习的明确操作。

## Decision

对于目标已知、确实改变状态且经 Client 确认的单节点直接编辑，Profile 按原生 Session 成员关系解释 Natural：恢复活动路径材料提供 Include 证据，移除跨分支导入提供 Release 证据。观测保留拥有它的 Session、事件水位、目标节点和来源类型。未知目标不产生 Natural 标签。无变化的操作、未标记的调用和批量编辑继续排除；Undo 保留审计观测但移除有效证据量，Redo 恢复它。

## Alternatives considered

- **不把 Natural 放入策略记忆。** 这会让偏好检查与实际上下文变化不一致。
- **总把 Natural 标为 Include。** 这会颠倒撤回借用分支材料的含义。
- **推测缺失目标的成员关系。** 父会话恢复可能改变规范节点 ID；缺少图证据时必须弃权。

## Consequences

Profile 证据和 Context 偏好案例对明确恢复操作的效果保持一致。Fast 选择包中的 Context 案例仍有数量上限；独立的语义路由包继续只携带路由和生命周期案例。不增加自动选择、图修改、模型请求或人格判断。

## Testing

原生公开 service 回归覆盖 Include 后恢复跨分支 Natural，以及 Exclude 后恢复活动路径 Natural。测试验证 Profile 观测、自有事件来源、有界 Context 案例包、Undo/Redo 和无变化的恢复。真实缺失父会话恢复测试验证目标获得不同规范拥有者后弃权。既有策略边界继续验证批量和未标记操作的过滤。

## Related

- [Contextify](../../../../packages/context/contextify/README.zh.md)
- [原生 service 回归](../../../../packages/context/contextify/tests/service.spec.ts)

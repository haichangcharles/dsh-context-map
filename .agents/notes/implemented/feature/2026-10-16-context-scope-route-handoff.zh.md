# Agent Note: 已审核 Context 范围的路由交接

Status: implemented

[English](2026-10-16-context-scope-route-handoff.md) | 中文

## Problem

用户在导航前检查过建议 Context 后，仍可能需要在目标任务中重新检查一次。第二次模型检查会改变来源集合，也增加推理成本。直接复制源 Plan 不安全，因为事件序号、自然成员关系和手动选择属于原 Session。

## Decision

[Contextify](../../../../packages/context/contextify/README.zh.md) 允许用户明确批准完整建议 Context，并与 Navigate 或 Return 一起执行。Host 重新校验原路由和家族修订，根据规范来源 ID 重建目标集合，再使用目标分支已有的建议校验器和原子 Plan 操作。来源缺失、任一 Plan 中选中来源被替换、目标 Include/Exclude 冲突、Agent 忙碌或不可用、目标已有待审建议、并发修订变化都会阻止范围修改。最后一次存储读取后，操作会同步检查双方 Agent、Plan 修订、来源批准所有权及实时家族变化，再提交修改。新建 Branch 建议保留独立的创建与检查路径。

[Client](../../../../packages/client/ui-contextify/README.zh.md) 保留只移动草稿的操作，并提供单独的携带 Context 按钮。存在部分 Keep-current 选择时，不能携带完整集合。目标批准日志记录 `sourceBase`，指向原始决策，而不是声称进行了另一次推理。标准审核选择的所有权与 Undo 保留在目标分支。历史案例仍是管理输入，不进入回答 Context。

Jev 的具体位置选择和经过原生校验的建议 Context 可以共同支持一个既有目标。Host 确认来自联合 Choice、位置分数一致且可见的目标自有来源出现在建议 Context 中时，使用已有 Profile 目标阈值控制审核建议。其他推断意图保留通用阈值，New-task 保留更强的意图检查。这是一致性检查，不是将独立概率相乘。原生可见性、替代关系、目标竞争、修订和人工审核约束仍然生效。[个人决策案例说明](2026-10-15-personal-context-decision-cases.zh.md) 定义历史证据提取。

## Alternatives considered

**每次导航后再执行一次模型检查。** 只移动草稿时仍可使用；但用户已经批准未变化的来源集合时，再推理会增加选择漂移和成本。

**复制源 Plan，或在移动之前先修改它。** 事件序号和自然成员关系在 Session 之间不同，提前编辑源 Plan 也会使审核过的路由修订失效。因此在目标分支重新校验需要的来源 ID 集合。

**覆盖目标固定设置，或每次路由都静默携带 Context。** 源分支审核不能撤销目标的明确选择，也不代表批准 Context 编辑。冲突会阻止范围修改，携带需要独立的明确操作。

## Consequences

携带已批准范围可以避免既有目标上的第二次推理，同时也会保留原集合已有的错误。它不直接证明语义回答质量或个性化收益。只有目标 Plan 修改是原子的：发生范围冲突时，编辑器可能已经移动了未发送的草稿；Client 会打开目标并保留草稿。既有目标的携带不扩展到新建子分支。原生与 Client 测试覆盖范围保持、来源追踪、幂等、冲突、并发变化、清理和明确批准；组装 Web 回放通过实际按钮与 Remote 操作验证，不调用模型 API。

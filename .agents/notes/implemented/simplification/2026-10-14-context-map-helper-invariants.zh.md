# Agent Note: 将 Context Map 辅助检查保留在可达输入上

Status: implemented

[English](2026-10-14-context-map-helper-invariants.md) | 中文

## Problem

布局与归档投影会接收异常的公开图输入，但部分可选查找还在防守自身构造已排除的状态。混淆两种情况容易导致测试修改私有算法或制造稀疏类型数组，同时仍未验证真实的环、缺失端点与尺寸异常。

## Decision

保留公开图检查，直接推导内部已保证的值。[Dagre 定位](../../../../packages/client/ui-contextify/src/client/layout.ts) 只在插入全部记录并完成布局后读取坐标。对于满足准入条件的链，N−1 个不同的已知目标留下一个根；每个节点最多一个前驱，因此从该根可达的路径不可能成环。后继保存已解析的记录和输入索引。不连通环无法通过最终访问数量检查，仍使用 Dagre fallback。

思维导图遍历返回已缓存或刚赋值的点。赋值先于递归，因此环与共享后代按相同顺序终止，后续遍历不能改变先前的点。记录输出顺序与坐标保持不变。归档别名过滤得到稠密列表；只在非空检查后，以归约选择活跃别名或第一个可见别名。[线性定位决策](../bug-fix/2026-10-14-linear-context-map-layout.zh.md) 继续负责性能与几何等价。

## Alternatives considered

**在测试中强行制造不可能的查找失败。** mock 私有 Dagre 状态，或在类型化过滤数组中制造空洞，都不能证明公开校验或正常算法行为。

**忽略未覆盖检查。** 这会隐藏有效异常输入拒绝与内部构造不变式之间的区别。

## Consequences

未知端点、重复标识与边、异常尺寸、不连通环、归档路径，以及循环父级元数据保留现有处理。没有改变几何、性能预算、依赖或覆盖率阈值。内部推导替代重复 fallback 状态，没有增加第二个图权威来源。

## Testing

[布局套件](../../../../packages/client/ui-contextify/tests/layout.client.spec.ts) 保留精确 Dagre 比较与独立思维导图参考坐标。[归档场景](../../../../packages/client/ui-contextify/tests/archived-family.client.spec.ts) 覆盖活跃路径移除、可见别名、不可用边，以及循环或缺失父级。[画布操作](../../../../packages/client/ui-contextify/tests/canvas-interactions.client.spec.ts) 覆盖上下文覆盖模式、相接与分离矩形，以及独立拖动提交。与尺寸测量测试一起，36 个场景使全部四个辅助模块的语句、分支、函数和行覆盖率达到 100%。

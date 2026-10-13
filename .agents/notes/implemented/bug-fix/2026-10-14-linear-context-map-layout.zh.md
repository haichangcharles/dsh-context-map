# Agent Note: 无分支 Context Map 的精确线性定位

Status: implemented

[English](2026-10-14-linear-context-map-layout.md) | 中文

## Problem

长原生对话通常是一条单链，但通用图排序会分别处理估计卡片尺寸和渲染器实测尺寸。在 240 轮浏览器负载中，打开默认的 480 节点 Map 会同步执行两次 Dagre 布局。性能分析将约 318–326ms 的本地浏览器 CPU 时间归于这两次调用。托管环境的打开中位耗时为 1653.62ms，超过保持不变的 1125ms 预算，而翻页、Trajectory、首次响应、流式输出和输入仍在各自预算内。

## Decision

[Context Map 布局](../../../../packages/client/ui-contextify/src/client/layout.ts) 以线性时间直接定位单条连通链。它保留全部节点、输入记录顺序、层级间距、实测尺寸、横轴居中与连接点方向。树和时间线模式的坐标都与 Dagre 一致。图必须满足节点标识唯一、边数恰好比节点数少一、端点已知、每个节点最多一个前驱和后继、只有一个根，并且遍历覆盖全部节点。异常尺寸、分支、汇合、重复边和不连通环仍使用通用 Dagre 定位。思维导图定位保持不变。

这补充了 [Context Steward 已确认操作](../feature/2026-10-13-context-steward-reviewed-actions.zh.md) 中的图身份与布局缓存决策。缓存消除未变化快照的重复工作；直接链定位减少首次打开时两次必要布局的成本。

## Alternatives considered

**隐藏或延迟初始 Map。** 这会改变已选定的默认交互，并测量另一个产品路径。benchmark 期间 Map 保持开启且包含节点。

**提高打开预算。** 这会保留可避免的同步计算，并削弱现有托管环境验收门禁。

**对所有图替换 Dagre。** 分支和汇合需要更通用的定位。优化具有结构性准入检查，其他图保留现有算法。

## Consequences

常见的无分支对话需要线性遍历，不再需要通用排序。任意记录顺序和渲染器实测尺寸仍受支持。没有移除节点、预览、边、刷新或浏览器断言。托管环境预算仍是验收依据；本地性能分析能定位计算成本，但不能证明托管环境验收通过。

## Testing

[布局测试](../../../../packages/client/ui-contextify/tests/layout.client.spec.ts) 在两个方向上，将打乱输入顺序、不同卡片尺寸和小数实测尺寸的坐标与独立 Dagre 基准精确比较。480 条消息的链保留全部节点，且不调用通用优化。分支、汇合、环、缺失端点和重复边场景保留 Dagre。布局、尺寸测量和 Map 面板套件共 68 个测试通过。[原始浏览器 benchmark](../../../../benchmarks/long-session-browser/long-session.bench.ts) 保留全部三次采样、240 轮负载和所有现有端点预算。

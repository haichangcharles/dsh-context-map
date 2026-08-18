# Context Map 布局恢复与视口稳定性

[English](2026-08-18-context-map-layout-stability-design.md) | 中文

**状态：** 用户已通过直接实施请求批准本设计。

## 目标

为用户提供一个明确的 Context Map 混乱布局恢复入口，同时保证后台 graph refresh 永远不会覆盖用户正在查看的 zoom 和 pan 位置。

## 根因

Contextify controller 每 1.5 秒轮询一次并发布新的 graph projection。React Flow 可能在这些 publication 后重新发出 dimension change。`ContextMapPanel` 当前会为每个 dimension change 增加 `measurementVersion`，另一个 effect 又会在这个版本每次变化时调用 `fitView()`。因此，即使 graph topology 没有变化，数据刷新也可能间接重置用户拥有的 viewport。

## 交互设计

- Context Map 挂载后，第一批完成测量的 graph 自动 fit 一次。
- 搜索结果变化和显式 Map focus 请求可以聚焦目标节点。
- 轮询、plan mutation、checkbox 更新、selection change 和节点重新测量都不会改变当前 viewport。
- 显示一个 `Re-layout` 操作：清除全部持久化的手动节点位置，恢复确定性的 tree layout，并在新位置渲染后 fit 完整 graph。
- Re-layout 不改变 context inclusion、selection、plan history、branch 或 message。
- 保留已有 React Flow zoom 与 pan control。

## 状态所有权

React Flow 继续以非受控 canvas state 拥有实时 viewport。Context Map view store 只继续拥有节点 selection 和手动 position override。刻意不持久化 viewport：graph topology 改变后旧 viewport 可能误导用户，而受控 viewport 会引入不必要的 render feedback loop。

首次 fit gate 是 component-local 状态，在另一个 Session panel 挂载时重置。显式 focus 按请求的 node identity 触发，而不是按节点 measurement 触发。Re-layout 使用已有 `clearPositions` store action，并先清除 transient drag position，再为已提交的新布局安排 `fitView()`。

## 延后的 Agent 工作

三个 Agent 想法本轮不进入 runtime，而是统一记录在 `packages/client/ui-contextify/FUTURE_WORK.md`：context selection 推荐、pruning 推荐，以及 branch/main-line promotion 推荐。

## 验证

自动测试必须证明：重复 dimension change 只触发一次初始 fit；普通 graph refresh 保持 viewport；Re-layout 会清除保存的位置并显式 fit graph。浏览器验证必须放大一个节点，等待多个轮询周期并确认 viewport 不变，然后拖乱节点并确认 Re-layout 恢复可读 tree 和完整 graph framing。

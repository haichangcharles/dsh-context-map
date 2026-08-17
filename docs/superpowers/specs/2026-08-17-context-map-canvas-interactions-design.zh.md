# Context Map 画布交互设计

[English](2026-08-17-context-map-canvas-interactions-design.md) | 中文

**状态：** 已批准实施

**范围：** 在 Harness 右侧面板恢复独立版 Context Map 的画布交互，但不引入第二套上下文、分支或消息定位后端。

## 产品结果

右侧 Context Map 保持独立版画布的交互体验，所有持久化操作仍然映射 Harness 原生状态。用户可以直接在画布上控制上下文、多选消息节点、实时调整图布局，并从图中定位 Chat 消息。画布不拥有 Session 谱系、消息内容或 Context Plan 决策。

## 交互模式

画布包含普通模式和选择模式。

普通模式下，点击节点会循环切换该节点有意义的 Context Plan 覆盖状态。当前 Session 路径上的 Natural 节点在 Excluded 和 Natural 之间切换；当前路径之外的 Natural 节点在 Included 和 Natural 之间切换。该模式允许拖动节点。

选择模式下，点击节点会增减多选，按住 Shift 拖动会显示框选区域并选中相交节点。该模式禁用节点拖动，避免选择手势移动画布节点。浮动操作条可以对已选节点批量执行 Include、Exclude 或 Natural，也可以清空选择。无效的节点状态组合继续由现有 Contextify 服务归一化。

## 右键菜单

右键点击消息节点会在指针位置打开画布菜单。菜单包含 Locate in Chat、Branch from Here、Natural、Include 和 Exclude。执行操作、点击菜单外部、按 Escape、移动视口或关闭面板时，菜单都会关闭。

Locate in Chat 会在需要时打开节点所属的原生 Session，等待对话视图渲染，然后滚动到对应的持久化消息序号并短暂高亮。Branch from Here 调用现有原生 Session fork 操作；上下文状态操作调用现有 Context Plan mutation。

菜单不提供 Delete、自定义主线和模式提取，因为 Harness 没有对应语义的原生操作。

## 实时画布操作

React Flow 在每次指针移动时把位置变化应用到临时客户端节点，因此被拖动的节点会持续跟随指针。拖动结束时，最终坐标才写入现有 Contextify viewing store。Context Plan 和 Session 数据不会进入临时拖动状态。

切换布局或重置画布时，通过现有 viewing-store action 清除或替换适用的位置覆盖。Undo 和 Redo 继续处理 Context Plan 历史，而不是节点坐标。

## Chat 定位契约

从图到 Chat 的定位使用以原生 Session ID 和持久化消息序号为键的窄对话 UI 契约。Contextify 发起 reveal 请求；conversation 包负责 DOM 锚点、滚动和高亮时序。Contextify 不直接查询 conversation 的 DOM 结构。

每条渲染出的 user 消息和最终 assistant 消息都暴露对应持久化序号的稳定锚点。如果 reveal 请求发生在 Session 切换或消息渲染之前，请求会保持待处理状态，直到匹配锚点挂载；成功定位或到达有限超时后，请求失效。无法找到已删除或不可用的消息时，当前视图保持可用，并显示现有非阻塞错误提示。

## 状态归属

- 原生 Session API 负责 Branch 和 Session 激活。
- Contextify 服务负责 Natural、Include 和 Exclude 决策。
- conversation UI 负责消息锚点和滚动。
- Contextify viewing store 负责布局、选择和持久化位置覆盖。
- React 画布局部状态负责拖动中的位置、框选几何信息和已打开的右键菜单。

## 无障碍与输入

Selection 切换和批量操作支持键盘访问，并暴露按下或禁用状态。Escape 会关闭右键菜单或清除当前框选。每个节点的操作控件也提供右键菜单中的操作，供键盘和触摸用户使用。选择和上下文状态除颜色外还使用文字或图标表达。

## 测试

组件测试会驱动真实画布回调，并先对缺失行为产生失败。覆盖普通模式点击循环、选择模式增减多选、Shift 框选、批量 mutation、右键菜单操作与关闭、拖动结束前的实时位置更新、拖动结束后的坐标持久化，以及选择模式禁用拖动。

conversation 集成测试证明 Locate in Chat 会打开所属 Session、等待消息锚点、滚动到该消息并施加临时高亮。现有 projection 测试继续证明图中只显示 user 和最终 assistant 消息，并且所有操作修改 Harness Context Plan 与原生 Session 状态。

可见集成通过聚焦包测试、`pnpm run test:gui` 和 replay-backed Web 场景验证。该场景会右键点击图节点、定位对应 Chat 消息、多选节点、批量应用上下文状态，并验证节点拖动过程中的中间视觉移动。

## 验收标准

1. 普通模式点击节点只循环切换有意义的 Harness Context Plan 覆盖状态。
2. 选择模式支持增减点击和可见的 Shift 框选多选。
3. 已选节点可以从画布操作条批量改为 Include、Exclude 或 Natural。
4. 右键菜单提供 Locate in Chat、Branch from Here、Natural、Include 和 Exclude。
5. Locate in Chat 可以显示并高亮准确的原生 user 或 assistant 消息，包括需要切换 Session 的情况。
6. 节点拖动持续实时更新，并且只持久化最终坐标。
7. 选择模式阻止节点拖动，并且在执行批量操作前不修改上下文。
8. 画布 UI 状态不复制 Session 谱系、消息内容或 Context Plan 的权威数据。

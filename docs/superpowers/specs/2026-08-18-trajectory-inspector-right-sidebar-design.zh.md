# 将轨迹 Inspector 移入原生右侧栏

[English](2026-08-18-trajectory-inspector-right-sidebar-design.md) | 中文

**状态：** 交互设计已确认，尚未实施。

## 目标

把现有 Trajectory Inspector 从“轨迹”页面内部的分栏移到 Harness 原生右侧详情栏。此改动服务于受控对照实验：只改变 Inspector 的渲染位置，不改变记录何时被选中，也不改变用户何时在 Context Map 与详情之间切换。

## 实验不变量

- 选择轨迹行、Request 标记、时间轴片段或经键盘聚焦的记录时，Inspector selection 与当前行为完全一致。
- 选中记录绝不自动把原生右侧栏从 Context Map 切换到详情。
- 用户只通过现有页签，显式地在 Context Map 与详情之间切换。
- 切换页面时保留最近的轨迹 selection、当前 Inspector 标签，以及适用的滚动状态。
- Inspector 保留现有 Summary、Preview、Raw、Source、Payload、Result、Schema、Timing、Hierarchy、Request、compaction 和父级导航行为。
- “轨迹”ledger 内部不再保留重复的 Inspector。

## 架构

### 所有权边界

`ui-layout` 继续拥有右栏几何尺寸、折叠／恢复行为和 resize handle。`ui-conversation` 继续拥有右栏壳层，以及 Context Map／详情页面导航。`ui-trajectory` 继续拥有轨迹记录身份、选择语义、详情标签和 Inspector 渲染。

`ui-conversation` 声明一个 Session 作用域的单实例原生 Inspector 页面 slot。存在占用者时，详情页渲染该 slot；没有 Inspector provider 时，保留当前 Tool drawer 作为 fallback。`ui-trajectory` 向该 slot 注册由 Session 派生的稳定 host，不让 `ui-conversation` 理解任何轨迹记录。

### 稳定 slot-host portal

原生 Inspector 仍是 `TrajectoryTable` 拥有的同一个 React 实例。由 Session 派生的 host ID 通过 `createPortal` 把它连接到右栏 Inspector seat。Context Map 可见时，详情 host 仍保持挂载，只隐藏而不销毁。因此所选记录／Request 身份、当前详情标签、最近标签偏好、Hierarchy 导航、流式更新和外部 inspect 确认继续使用现有 Trajectory 状态机，不复制 store，也不增加第二套 renderer。

没有提供原生 host 的独立 `TrajectoryTable` 消费者继续使用既有局部 Inspector fallback。组装后的 Harness 始终提供 Session host，因此其 ledger 内部不会出现重复 Inspector。

### 渲染

现有 Inspector body 从 `TrajectoryTable` portal 到原生详情页，并使用原生右栏的宽度和滚动边界。在组装 host 中，它不渲染内部 resize handle，也不应用局部宽度样式，因为 resize 归 `ui-layout` 所有。独立 fallback 为兼容性继续保留这些能力。

Inspector 的关闭操作保留原生语义：清空当前轨迹 selection。它不会切换到 Context Map，也不会折叠整个右栏。没有 selection 时，详情页仍可进入，并显示中性的轨迹空状态。

## 数据流

1. 用户在 ledger 或时间轴中选择记录。
2. Trajectory Inspector controller 保存稳定的 selection 身份。
3. ledger 与当前一样更新选择轨和滚动位置。
4. 当前右栏页面保持不变。
5. 用户手动打开详情后，Trajectory Inspector 根据实时 Session projection 解析所选身份，并渲染现有详情体验。
6. 用户切回 Context Map 时只隐藏 Inspector，不重置其状态。

## 兼容性与失败行为

- 没有 `ui-trajectory` 时，详情页退回现有 conversation Tool drawer。
- 所选记录不再位于已加载历史窗口时，详情页显示受控的不可用／空状态，而不是保留过期内容。
- 切换 Session 时使用独立 controller，不允许 selection 跨 Session 泄漏。
- 折叠再恢复原生右栏时，保留所选页面和轨迹 selection，与当前 Context Map 的保留行为一致。
- 归档、恢复、分支和 Context Map projection 逻辑完全不变。

## 验证

自动化测试必须证明：

- 选择 ledger 行后，不再在轨迹内部渲染 `Event details` aside；
- selection 不会请求切换到详情页；
- 手动选择详情后，会渲染同一条所选消息、Tool、context 和 Request 的 Inspector 内容；
- Summary／Preview／Raw 和 Tool 专属标签仍可正确切换；
- selection 与当前标签可跨 Context Map／详情切换及右栏折叠／恢复保留；
- 清空 selection 后显示空状态，但不改变当前页面；
- Session 切换隔离 selection；
- 键盘、时间轴、Hierarchy 和跨视图 inspect 路径仍会选中并聚焦正确记录。

浏览器验证会对照迁移前后的既有轨迹流程：唯一可见的行为变化应是 Inspector 从轨迹 ledger 内部分栏移动到原生最右栏。

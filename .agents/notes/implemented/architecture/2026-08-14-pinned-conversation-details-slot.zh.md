# Agent Note: 常驻会话详情与工具栏共享右侧列

Status: implemented

[English](2026-08-14-pinned-conversation-details-slot.md) | 中文

## 问题

上下文图等会话作用域界面需要在用户阅读和编写 Chat 时持续可见。替换 `details` 占用者会接管完整右侧列并移除已有工具结果 renderer；把该界面放进另一个 view 又无法同时控制上下文和对话。因此，详情列需要一个跟随会话壳层生命周期的增量区域，同时保留临时工具检查能力。

## 决策

`ui-conversation` 中的 `details` 注册在已有单实例 `conversation.details.tool` slot 旁声明会话作用域列表 slot `conversation.details.pinned`。可选插件通过 slot declaration injection（slot 声明注入）贡献一个自包含的常驻面板，因此激活顺序和重载跟随 slot 声明，而不依赖特定包的服务依赖关系。

`DetailsPanel` 通过由框架绑定、以 slot 账本为后端的 observable hook 观察常驻 slot 是否被占用。没有贡献时，它渲染原有工具详情树并保留原关闭行为。有贡献时，如果未选择工具调用，常驻区域占满可用高度；选择工具调用后，底部会打开一个最高占该列 45% 的抽屉。关闭抽屉只会清除共享 Chat selection，不会关闭详情列或常驻面板。常驻贡献拥有自己的 header，并可通过该插件的 `ctx.layout` inject face 关闭整个列。

工具 selection 继续存放在共享的逐会话 Chat store 中。常驻业务状态属于贡献插件的会话数据、observable source 或已声明 store；`ui-conversation` 只拥有放置位置和共存行为。

## 备选方案

**替换顶层 `details` slot。** 这样上下文插件能取得整个列，但会折叠 `conversation.details.tool`，导致上下文控制与工具检查无法共存。

**在 layout 包中增加 Contextify 专属 slot。** Layout 拥有几何，而非会话领域组合。以功能命名的 slot 会让核心壳层耦合到单个插件，并让其他持久会话面板再次需要修改 layout。

**把上下文图放进会话 tab 或 modal。** 两种放置都会在编辑时隐藏 Chat 或上下文图，无法满足同时控制的要求。

**在组件中轮询 `slots.entries()`。** 普通读取不会把晚注册、dispose 或崩溃让位发布给 React。slot 账本 observable 使用框架唯一的 hook 绑定路径，并跟随这些生命周期。

## 影响

会话插件获得一个通用的持久右侧列 seat，且无需导入 Contextify。没有常驻贡献的组合会保留工具详情原有的全高度行为；存在一个或多个常驻条目的组合则以部分列高换取同步检查能力。

详情壳层需要维护占用订阅和双区域布局。常驻条目必须提供自己的标题、关闭动作、滚动和错误呈现；壳层无法协调特定功能的状态。组件与组装测试固定空 slot 兼容性、晚到占用变化、抽屉共存和关闭语义。

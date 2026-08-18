# Context Map 右栏子页与最终输出设计

[English](2026-08-18-context-map-right-subpage-final-output-design.md) | 中文

**日期：** 2026-08-18

**范围：** 将 Context Map 变成 Harness 原生详情栏中只采用树形布局的子页，并且每轮只投影真实用户输入和一个已完成的最终助手输出。

## 产品行为

原生右侧详情栏仍是唯一的右侧容器。安装 Context Map 后，该栏提供两个互斥子页：Context Map 和当前选中 Tool 的详情。打开 Tool 会选择 Tool 页；Context Map 的定位操作会选择 Context Map 页。切换页面时保留 Tool 选择以及 Context Map 的视口与状态。原生栏的边框、拖拽手柄、宽度让渡规则和关闭行为继续由 `client-ui-layout` 管理，不在此重新实现。

Context Map 始终采用自上而下的树形布局。不显示布局选择器、模式名称或替代布局入口。产品界面会忽略已持久化的 `mindmap` 或 `timeline` 值，因此每次打开都呈现树形布局。

## 规范消息节点

图由原生 Session 的轮次边界投影，而不是由单个可见消息事件直接生成：

- 真实的 `user/message` 且 `source.kind === "user"` 时，保留为输入节点。
- 一轮尚未结束时，可以立即显示输入，但助手事件不会出现在 Map 中。
- 到达 `turn/end` 时，仅当该轮成功完成，才保留该轮最后一条可见的 `assistant/message` 作为唯一助手节点。
- 更早的助手步骤、Tool 调用叙述、中间提问、仅推理消息、Tool 结果、插件/系统注入以及未完成、取消或错误轮次的输出，都不会成为图节点。
- 被保留的最终助手节点与输入使用同一个已完成 `turn/end` 序号作为分支边界。

这只是一条投影规则。上下文编译仍使用原生 Session log 和 Context Plan；Map 不删除或改写 Harness 事件。

## 原生详情导航

`ui-conversation` 管理一个按 Session 隔离、仅存内存的小型详情页注册表，接受 `pinned` 和 `tool` 请求。Tool 检查请求 `tool`；Contextify 请求 `pinned`。`DetailsPanel` 只渲染当前页，但底层状态仍保存在原有 store/controller 中。未选择 Tool 时，Tool 标签禁用并选择 pinned 页。该注册表属于视图状态，不做持久化。

## 测试

- Contextify family 投影测试证明：多步助手文本会折叠为最终的已完成输出，开放或失败轮次不会泄露部分输出。
- Context Map 组件测试证明：即使 store 中存在旧的替代布局值，也不显示布局控件和布局模式标签。
- Conversation 装配测试证明：pinned 页与 Tool 页切换时不会清除 Tool 选择。
- Contextify 浏览器插件测试证明：Map 操作请求 pinned 页，Tool 操作请求 Tool 页。
- Layout 测试继续证明原生详情拖拽手柄及宽度归属；Contextify 代码不会修改这些文件。

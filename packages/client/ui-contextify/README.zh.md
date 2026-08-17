# @deepseek-ai/dsh-client-ui-contextify

[English](README.md) | 中文

`dsh-client-ui-contextify` 把可交互 Context Map 固定在 Chat 右侧的 details column。Map 与消息旁的 Chat control 共用同一个 Session-scoped controller，因此操作的是同一份持久 Context Plan。

## 用户体验

右侧 panel 使用 React Flow 渲染相互连接的原生 Session family。每条可见 user 或 assistant 消息对应一个 card；复制的 Session 前缀会去重，reasoning 与 tool event 不进入图。Panel 支持缩放、平移、拖动位置、多选、搜索，以及 tree、mind-map、timeline 三种布局。布局、选择和拖动位置仅属于 viewing state，不会改变模型输入。

每个节点在合法时提供 Natural、Include、Exclude、Open、Locate 和 Branch。Branch 会在消息对应的 completed Turn boundary 调用 Harness 原生 `sessions.fork`，并打开新的 child Session。Open 跳转到消息所属 Session，Locate 聚焦对应 graph node。Batch mode 会在一个 plan revision 中修改多个选中节点；Reset、Undo、Redo 操作持久 plan history。

普通 Chat user 消息与已完成 assistant 消息旁提供紧凑的 Auto/Use/Skip/Map control。它们和 graph 使用同一个 controller，所以 Chat 侧修改会同步到 map，并在 reload 后保留。Steering、reasoning、tool 与仅 runtime 可见的 row 不会获得 Context Map control。

Workspace 左侧栏会另外用递归可折叠 tree 展示原生 Session 祖先关系。在 branch family 很密集时，Map 是信息更完整的导航入口。

## 模型体验

通过这些控件修改的 Host-owned Contextify plan 与 compiler 间接影响模型体验。

#### KV Cache 影响

UI 不添加提示词文本。Auto 跟随 active Session 历史，Skip 排除一条历史消息，Use 引入同 family 的 off-path 消息；改变更早的已选消息可能从该消息开始降低前缀复用。

## 已知限制与暂缓事项

- Chat 或 Map 存在订阅者时，family update 使用有界的 1.5 秒 polling。
- Include/exclude recommendation 目前完全手动，自动推进暂缓。
- 暂不提供跨 Map import。
- Graph 暂不能展开 compaction replacement relationship。

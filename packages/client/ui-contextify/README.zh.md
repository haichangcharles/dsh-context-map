# @deepseek-ai/dsh-client-ui-contextify

[English](README.md) | 中文

`dsh-client-ui-contextify` 把 Context Map 放在对话右侧固定的 details column 中。Web client 启动时会打开该栏，通过 `ctx.remote.contextify` 加载当前 Session 的持久 Contextify view 和有界 graph page，并在挂载期间持续刷新，因此新追加的聊天消息无需离开当前对话即可显示。

每个节点展示 event sequence、role、path 和有界 preview。用户可以保留 natural selection、强制 include、强制 exclude，或从该节点创建轻量 branch。Path chip 用于切换 active branch；mainline control 可以返回主线，而不会创建新 Session。每次 mutation 都携带界面所显示的 plan revision；过期修改会安全失败，panel 会显示 Remote error。

## 模型体验

通过 control 调用的 `contextify/*` Remote method 间接影响模型：每次被接受的修改都会更新持久 Contextify plan，下一次获准进入模型的 request 将包含 active causal path 和显式 inclusion，并移除显式 exclusion。Tool exchange 始终保持为闭合 group。Panel 本身不会添加提示词文本。

#### KV Cache 影响

在后续模型 request 使用变更后的 plan 前没有影响。保持相同的选中前缀可保留其可复用 cache 前缀；切换 path 或修改更早的 override，可能从第一条变化 message 开始使 cache 复用失效。

## 已知限制与暂缓事项

- 首个版本使用紧凑 card graph，尚未提供自由缩放和平移。
- Live update 暂时采用有界的 1.5 秒刷新，后续可改为专用 projection channel。
- Graph 尚不能展开 compaction replacement relationship。

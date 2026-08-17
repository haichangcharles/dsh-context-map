# @deepseek-ai/dsh-contextify

[English](README.md) | 中文

`dsh-contextify` 把一组由 Harness 原生 Session fork 连接起来的对话投影成消息级 Context Map，并注册 `contextify@2` Context Compiler。它不再创造第二套 branch 概念：每条 branch 都是普通 Session，`parentSession` 与 `seedLength` 完全由 Harness 管理。

## 当前行为

在 `agent/session-start` 时，插件会选择 Contextify compiler；若计划不存在，则创建 Natural plan。新 fork 的 child 会继承 parent 的事件前缀，但拥有自己的 Natural plan，因此 context 修改不会被静默继承。

Family projector 从原生 root Session 遍历全部后代，并按最早拥有它的 Session 对复制前缀消息去重。每条可见、append 的 `user/message`，以及含文本或图片的 `assistant/message`，各自成为一个节点。纯 reasoning assistant event、tool call、tool result、context injection 和其他 runtime event 都不会进入图。User 与 assistant 节点都会解析到所在 completed `turn/end`，Branch 因而使用 Harness 原生 Session fork 接受的边界。

持久计划包含三种模式：

- **Natural**：消息属于当前 Session 的继承或本地历史时，保持默认输入。
- **Exclude**：从下一次 compilation 中移除一条 Natural 历史消息。
- **Include**：把同一原生 family 内其他 Session 的消息复制到本地 `context/compiler-snapshot` 事件，并按稳定位置插入。

每次 plan mutation 都按 revision 做 compare-and-set，并记录完整 undo/redo 状态；Reset 回到 Natural。跨 family 引用、不可用消息、旧 revision、不支持的状态变化以及非 idle Agent 都会失败，不会产生部分更新。跨 Map import 暂不在范围内。

`contextify` Remote namespace 提供 `get`、分页 `familyPage`、`setNodeMode`、批量 `setNodeModes`、`reset`、`undo` 和 `redo`。

## Context Compiler 契约

Harness 原始 transcript 仍然是 append-only。Contextify 只改变后续模型请求所编译出的 message list：

- 当前 family 的消息保持已有顺序；
- 显式 exclude 的消息被移除；
- sibling include 从持久 compiler snapshot 读取；
- 当前 turn 的消息会被恢复，因此旧 plan 无法隐藏正在回答的请求。

Compiler 不添加任何提示词文本。Exclude 可以减少 input token；引入 sibling 会增加 input token。只要更改了更早的选中前缀，KV cache 就可能从第一条变化消息开始失去复用。

## 已知限制与暂缓事项

- Web surface 有订阅者时每 1.5 秒轮询 family；后续可改为专用 projection event。
- 自动推荐 include/exclude 节点暂缓。
- 跨 Map import 暂缓；目前只能引用连接到同一原生 root 的 Session。
- Compaction replacement relationship 尚未展开成 shadow node。
- 在 compiler、Remote、replay 与 UI seam 稳定前，package 继续保留在本 Harness fork 中。

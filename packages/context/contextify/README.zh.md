# @deepseek-ai/dsh-contextify

[English](README.md) | 中文

`dsh-contextify` 把一组由 Harness 原生 Session fork 连接起来的对话投影成消息级 Context Map，并注册 `contextify@3` Context Compiler。它不再创造第二套 branch 概念：每条 branch 都是普通 Session，`parentSession` 与 `seedLength` 完全由 Harness 管理。

## 当前行为

在 `agent/session-start` 时，插件会选择 Contextify compiler；若计划不存在，则创建 Natural plan。新 fork 的 child 会继承 parent 的事件前缀，但拥有自己的 Natural plan，因此 context 修改不会被静默继承。

Family projector 从原生 root Session 遍历全部原生后代；标记为 `origin: subagent` 的 Session 属于执行细节而不是聊天分支，因此不会进入 Map。它按最早拥有消息的 Session 对复制前缀去重。每个 Turn 只保留真实 user input，以及成功 `turn/end` 后最后一条含文本或图片的 assistant message。Turn 运行期间 assistant 文本不会进入图；更早的 ReAct step、中间提问、失败或中断时的部分输出、纯 reasoning assistant event、tool call、tool result、context injection 和其他 runtime event 也都会被排除。保留的 user 与最终 assistant 节点都会解析到所在 completed `turn/end`，Branch 因而使用 Harness 原生 Session fork 接受的边界。

持久计划包含三种选择模式：

- **Natural**：消息属于当前 Session 的继承或本地历史时，保持默认输入。
- **Exclude**：从下一次 compilation 中移除一条 Natural 历史消息。
- **Include**：把同一原生 family 内其他 Session 的消息复制到本地 `context/compiler-snapshot` 事件，并按稳定位置插入。

Plan v3 还支持针对单条 user input 或最终 assistant output 的可恢复 **Archive** overlay。Archive 与 context 选择刻意分离：服务端只把模型可见语义替换成固定标记 `[Placeholder: intentionally empty]`，不接受 Agent 或客户端生成的替换文本。同一个 graph node、role、edge、原生 fork boundary 与 append-only Session 原事件全部保留。Restore 只移除 overlay。Reset 会同时清空 Include、Exclude 与 Archive overlay；Undo/Redo 会回放三者。已有 v2 plan 在内存中规范化；已有 v3 replacement snapshot（包括旧版自定义文本）仍可读取和恢复。

每次 plan mutation 都按 revision 做 compare-and-set，并记录完整 undo/redo 状态；Reset 回到 Natural。跨 family 引用、不可用消息、旧 revision、不支持的状态变化以及非 idle Agent 都会失败，不会产生部分更新。跨 Map import 暂不在范围内。

导航使用规范化后的原生 branch 祖先关系。从 parent 继承的边界再次 fork，会与已有 branch 同级；只有在 branch 自己新增的边界上 fork，才成为它的 child。两种情况下，graph 都继续显示真实共享的消息支点。

`contextify` Remote namespace 提供 `get`、分页 `familyPage`、仅建议的 `recommend`、`cancelRecommendation`、`setNodeMode`、批量 `setNodeModes`、`archiveNode`、`acceptBranchSuggestion`、`restoreNode`、`reset`、`undo` 和 `redo`。

`recommend` 提供两种手动选择的模式。Fast 是默认操作：一次有界、禁用工具的 classifier 只检查最可能相关的已选与 off-path candidate。Deep 必须由用户显式选择：Contextify 把完整 tree snapshot 写入私有临时文件，启动一个受限 Harness child；它只能对该文件执行精确路径的 Read/Grep，并通过结构化工具提交结果。成功、失败、取消或超时后，临时文件与 child 都会清理。两种模式都不会把 prompt、reasoning 或结果写入 parent Session，也不会在 Apply 前修改 context。共用 Validator 会把输出与当前有效集合比较，过滤无害的重复／no-op Include 或 Exclude，拒绝未知节点与互相冲突的动作，并返回一份完整的 Current → Proposed 替换。应用 proposal 只提交一个 compare-and-set plan revision，因此 Undo 会整体恢复旧版本。谨慎的 Archive candidate 仍然只供建议，并要求逐项确认。

自动 Branch review 对新 Profile 默认开启，也可以在 Prompt Dashboard 关闭。禁用工具的 classifier 会从第一条 human input 到达时与主回答并发启动，仅在成功 Turn 完成后绑定准确的最终 Q&A，因此主回答不会等待它。它的有界 packet 只包含新 input、当前与祖先 objective、最多三个本地最近 Turn、branch 深度／负载以及最多四个 sibling intent；不会包含完整 tree、reasoning 或 tool event。动态高置信度阈值会压制噪声；格式错误、调用失败、关闭、低置信度或已过期的 review 都保持静默。接受可见建议时，系统用确定性 placeholder 归档源 input 与最终 output，在前一个 completed boundary fork 一个原生 child，并把原始 Q&A 精确回放到 child。搬迁具有确定性 key，可安全重试；若后续对话事件已经让建议过期，则拒绝执行。

三类 review Agent 都使用 Profile 所有的设置。Package 默认 prompt 是只读基线；用户通常只追加自定义规则，也可以显式解锁完整 override。Context selection、Archive advice 与 Branch routing 分别配置，并继续使用 parent Agent 的 Harness provider/model route。

## 模型体验

### 编译后的 Context Plan

#### 模型看到的内容

Harness 原始 transcript 仍然是 append-only。Contextify 按现有顺序选择 active-family 消息、移除显式 exclusion、替换已确认的 placeholder snapshot、从持久 `context/compiler-snapshot` event 读取已 include 的 sibling 消息，并恢复当前 turn 的消息，因此旧 plan 无法隐藏正在回答的请求。

#### Token 影响

Compiler 不添加任何提示词文本。Exclude 可以减少对话历史的 input token；引入 sibling 会按所选 snapshot 内容增加 token。

#### KV Cache 影响

只要更改了更早的选中消息前缀，KV cache 就可能从第一条变化消息开始失去复用。所有节点保持 Natural 时，普通 Session 消息顺序不变。

## 已知限制与暂缓事项

- Web surface 有订阅者时每 1.5 秒轮询 family；后续可改为专用 projection event。
- 启用 Branch review 后，每个 eligible Turn 最多增加一次很小的辅助模型调用；希望完全没有后台分类的用户可以按 Profile 关闭。
- 跨 Map import 暂缓；目前只能引用连接到同一原生 root 的 Session。
- Contextify placeholder 是原节点的 overlay；其他 compaction relationship 尚未展开成 shadow node。
- 在 compiler、Remote、replay 与 UI seam 稳定前，package 继续保留在本 Harness fork 中。

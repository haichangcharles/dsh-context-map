# @deepseek-ai/dsh-contextify

[English](README.md) | 中文

`dsh-contextify` 在同一个 Harness Session 内保存轻量对话图，并注册 `contextify@1` Context Compiler provider。Branch 是持久的因果路径，而不是新 Session：消息、工具事实和请求 header 都保留在原 append-only 日志中。

## 当前行为

在 `agent/session-start` 时，插件会在缺少初始计划时创建 root plan，并选择 Contextify compiler。每个 plan snapshot 记录路径祖先关系、active/mainline path 和显式 include/exclude override。每个 route 把一个 turn 归属到某条 path 及其父节点。编译会从 active path 回溯到 root、应用 override，并无条件恢复当前 turn 的消息。

`contextify` service 提供生成式 Remote 读取和 compare-and-set mutation，用于 graph paging、创建 branch、选择 path、返回 mainline，以及设置节点的 natural/include/exclude 模式。只有针对当前 live idle Agent 和当前 plan revision 的 mutation 才会被接受。Assistant tool call 及其 tool result 会组成不可拆分的 selection group，因此 override 不会向模型发送残缺的 tool exchange。

Compiler 会拒绝非单调 plan、重复或循环 path、缺失的 active path、重复 route、引用旧 plan 的 route、缺失 route parent，以及引用不到消息节点的 override。只有 root 的历史与 Harness 原始 surface 保持等价。

## 模型体验

### 选中的对话历史

#### 模型看到的内容

模型会看到 active 因果路径上的消息和标记为 `include` 的消息。标记为 `exclude` 的历史消息会被省略。当前 turn 已经写入的消息不会因导入或过期 override 而消失。

#### Token 影响

Branch 和 exclude 可以通过省略无关历史来减少输入 token。显式 include 会恢复指定的持久消息并增加输入 token。本插件不添加提示词文本。

#### KV Cache 影响

停留在同一路径时会保留稳定前缀。切换路径或修改较早的 override，可能从第一条变化消息开始使缓存复用失效。

## 已知限制与暂缓事项

- **刷新存在短暂延迟**——Web panel 挂载期间每 1.5 秒刷新一次 graph；以后可以用专用 Contextify projection/event channel 取代 polling。
- **Compaction 投影待完成**——replacement event 尚未表示成可展开的 shadow 关系。
- **暂在仓库内孵化**——package 当前位于 Harness fork 内，以便一起验证 compiler seam、Remote boundary 和 replay 规则；API 稳定后可以抽取到独立 plugin repository。

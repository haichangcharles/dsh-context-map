# Context Map 确定性空占位节点设计

[English](2026-08-19-context-map-empty-placeholder-design.md) | 中文

## 目标

用户确认移除某条 Context Map 消息的语义后，仍把该消息节点保留为图中的物理支点，但让正文在视觉上为空。节点的角色、身份、连线、原生分支边界、选择状态以及恢复原文的能力都必须保留。

## 决策

Contextify 独占一个面向模型的常量标记：

```text
[Placeholder: intentionally empty]
```

推荐 Agent 可以识别 cleanup candidate，并说明它为何过时、冲突或重复，但不能提供、编辑或改写占位内容。用户明确确认后，由服务端自行构造固定标记，并存入现有的、保留消息角色的 compiler snapshot overlay。

客户端根据持久化的 Contextify replacement metadata 识别替换，并且不渲染消息正文。因此卡片只保留原有的 `USER` 或 `ASSISTANT` 外框和控件。固定标记仍对模型可见，因为非空消息比仅有空白字符的消息更能跨模型供应商稳定工作。

## 数据与控制流

1. 隔离的推荐 Agent 返回 cleanup candidate，其中只有 node ID、category、reason 和 evidence node IDs。模型输出中的 placeholder 文本会被忽略，并从公开 cleanup contract 中移除。
2. 审阅面板展示原始内容和固定结果“Empty placeholder”，提供 Keep original 或 Confirm empty placeholder，不再提供 placeholder 编辑器。
3. 确认操作调用 `replaceNode` 时不携带用户或模型生成的替换文本。服务端把包内常量按原消息角色写入 `context/compiler-snapshot`。
4. Context Plan 记录现有的可逆 replacement overlay，不删除也不改写原生 Session event。
5. Graph projection 保留原始 node ID 与拓扑，把节点标记为 placeholder，并且只在 Show original 中暴露完整原文。
6. Context compilation 使用固定标记替换原语义。Restore 移除 overlay、恢复原始语义，同时保留 Include/Exclude 状态。

## 兼容性

现有 version 3 中带自定义文本的 replacement 仍可读取和恢复。新 replacement 一律使用固定标记。UI 把所有 replacement overlay 都视为空占位节点，因此旧版自定义替换文本也不会显示在图上。存储结构没有变化，所以无需升级 Session format 或 Context Plan version。

## 失败行为

- Cleanup 在明确确认前始终只是一条建议。
- Family 或 plan revision 过期时，在写入标记前失败。
- 源消息缺失或角色不兼容时失败，且不会产生半完成的 plan mutation。
- 原始来源不可用时，Restore 继续 fail closed。

## 验证

- 服务测试：Agent 生成的 placeholder 文本不能影响存储 snapshot；确认后始终以原消息角色编译固定标记。
- 客户端测试：placeholder 节点正文为空，ID 和连线不变，并保留 Include/Exclude、Branch、Locate、Show original 与 Restore。
- 客户端测试：cleanup review 不存在可编辑 placeholder 字段。
- 回归测试：旧版自定义 replacement 仍可读取和恢复。
- 组装 Web 测试：recommendation 本身不产生修改；确认后出现视觉空节点、编译消息为固定标记，恢复后返回原文。

## 不在范围内

本次修改不会物理删除 Session event，不会创建成对 Q/A 节点，不允许 Agent 生成 summary，也不会改变 Harness 原生 branching。

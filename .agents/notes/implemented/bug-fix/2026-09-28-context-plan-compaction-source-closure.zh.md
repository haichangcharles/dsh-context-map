# Agent Note: Context Plan selection through compaction sources

Status: implemented

[English](2026-09-28-context-plan-compaction-source-closure.md) | 中文

## Problem

物理 Session checkpoint 可能概括多条历史消息。Context Plan 排除其中一条后，checkpoint 仍可能被选中，其文本便会重新带入已排除消息。委托 child 也可能引用仍被选中的 checkpoint，尽管该 checkpoint 的一个已记录来源已被否决。

## Decision

[Contextify](../../../../packages/context/contextify/README.zh.md) 在当前计划 Exclude 或 Archive 某个来源时，把压缩 checkpoint 展开为它已记录的消息来源。之后的选择和工具调用／结果配对都作用于这些逻辑来源消息。未受计划影响的 checkpoint 保持选中，Undo 也能重新使用它。没有被否决来源的 Natural 计划在编译时不遍历 checkpoint 祖先链。

可选的 revision-lineage 接纳检查会遍历选中事件的传递性 `sourceEventSeqs` 闭包。任一已记录来源被否决时，它拒绝 child 结果，包括藏在嵌套 checkpoint 中的来源。物理替换来源与 summarizer 实际读取集合仍然分开；本次更改并未完整记录后者。

## Alternatives considered

**只要 surface 节点被选中就保留 checkpoint。** 混合 checkpoint 会暴露当前请求已通过 Exclude 或 Archive 移除的内容。

**每次计划编辑都使全部 checkpoint 失效。** 这样会丢弃独立 checkpoint，也会让 Undo 无谓地重放原始历史。

**把已记录的 shadowed span 当作完整语义读取集合。** 压缩记录描述的是被替换的物理节点，而 summarizer 还可能收到其他输入；当作完整集合会夸大保证。

## Consequences

原生测试覆盖压缩前后编辑、Archive、嵌套 checkpoint、工具配对、child 接纳、独立 sibling 保留以及 Undo。Agent Loop 测试还检查 Exclude 和 Undo 后实际发送给模拟 provider 的消息。逻辑展开可能让请求超过物理 surface 的估计；`compaction-basic` 的自动压力判断与摘要仍作用于物理 surface。视图一致的压缩协议和完整读取集合观测仍需单独实现。

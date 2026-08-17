# Agent Note：原生 Session Context Map

Status: proposed

[English](2026-08-17-native-session-context-map.md) | 中文

## 问题

Long-horizon 对话同时需要 branch navigation 与下一次模型请求的历史输入控制。Harness 已经拥有持久 Session fork，而早期 Context Map prototype 又维护了一套不兼容的 Session 内 path。保留两套 branch 会让导航、持久化、命名与模型 context 相互矛盾。

## 提案

一个原生 root Session 及其全部后代组成一个 Context Map。Branch 一律在 completed Turn boundary 调用 `sessions.fork`。Graph 中每条可见 append user/assistant 消息对应一个节点，复制前缀会去重，reasoning、tool 与 runtime-only event 不进入图。

每个 Session 拥有自己的持久 Context Plan。Child 继承事件前缀，但 plan 重置为 Natural。Natural 跟随当前 Session 历史；Exclude 移除 active history 中的消息；Include 对同 family 其他 Session 的消息建立 snapshot。跨 Map import 与自动 include recommendation 暂缓。

右侧 React Flow map 与 Chat 消息 control 共用一个 controller，都能设置 Natural/Include/Exclude。Map 另外提供原生 Branch、Session navigation、搜索、三种布局、多选批量修改，以及 plan Reset/Undo/Redo。Workspace 左侧栏以递归可折叠 tree 展示同一 Session ancestry。

## 考虑过的替代方案

**在单一 Session 中另建 path model。** 独立 prototype 使用一个 Session 内的轻量 path，但若让它与原生 Session fork 同时成为 branch identity，持久化、导航、命名与 context selection 会彼此冲突。

**使用独立的 Context Map 页面。** 全屏 map 空间更大，但用户无法一边阅读 Chat，一边决定下一次请求使用哪些历史。固定在 details column 可让导航与 compilation control 始终位于对话旁边。

**首版支持跨 Map import。** 任意 import 需要额外设计 discovery、authorization 与 provenance。Same-family Include 可以先验证 compiler 与交互模型，而不扩大首版 data boundary。

## Append-only 兼容

Context 修改不会 edit 或 delete transcript event。Include 写入 `context/compiler-snapshot`；plan 修改写入完整、带 revision 的 `contextify/plan` event。`contextify@2` compiler 在请求时选择 model message、恢复 current-turn message，并保持 Harness 普通 surface 不变。

## 验收标准

- 原生 Session lineage 是唯一 branch identity。
- User 与 assistant 消息只能通过 completed `turn/end` 创建 branch。
- Reasoning 与 tool event 永远不成为 map node。
- Chat 与 map 修改同一份持久、带 revision 的 plan。
- 可以 include 同 family sibling 消息，并 exclude active-path 历史消息。
- Child plan 重置为 Natural；修改在 reload 后保留且支持 undo/redo。
- 右侧 map 与 Chat 同时可见，左侧 Session tree 递归可折叠。

## 暂缓

跨 Map import、自动 recommendation、compaction shadow relationship 与 push projection channel 均明确暂缓。

## 风险

大型 Session family 可能增加 graph 与 polling projection 的开销；有界分页和仅在存在订阅者时轮询可以限制首版成本，但后续仍可能需要 push projection。显式修改较早消息可能降低 KV cache 前缀复用，因此 UI 会展示每个 mode，并保持 Natural 为默认值。用户也可能混淆 navigation 与 compilation state；graph 因而同时显示 Session owner 和每条消息的 Natural/Include/Exclude 状态。

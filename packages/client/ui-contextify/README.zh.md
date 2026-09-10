---
description: "在原生右侧栏中查看 Context Map 并编辑持久上下文计划。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-contextify

[English](README.md) | 中文

## 概述

`dsh-client-ui-contextify` 在上游右侧栏中提供可交互的 Context Map 标签页。Map 与消息旁的 Chat control 共用同一个 Session-scoped controller，并操作同一份持久 Context Plan。

## 目录

- [用户体验](#user-experience)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="user-experience"></a>
## 用户体验

右侧子页使用 React Flow 以唯一的自上而下 tree 渲染相互连接的原生 Session family，不暴露其他布局模式。每条真实 user input 与每个 completed Turn 的最后一条可见 assistant output 对应一个 card；复制的 Session 前缀会去重，中间 assistant step、未完成输出、reasoning 与 tool event 不进入图。每个 card 只有一个有效 context checkbox：勾选表示消息进入下一次模型请求，未勾选表示不进入。Natural 根据 active Session path 得出这个结果；checkbox 偏离自动结果时会写入相应的 Include 或 Exclude override，恢复自动结果时则移除 override。Selection 模式仍是独立的画布操作，提供累加点击、可见的 Shift 拖动框选与批量操作。被拖动的节点会持续跟随指针，只在松开后持久化最终位置。画布选择和拖动位置仅属于 viewing state，不会改变模型输入。

第一批完成测量的 graph 只会 frame 一次。随后每个 React Flow card 会把真实 bounding box 反馈给 Dagre，因此即使 output 很长，下一层也会从上一张 card 的实际底部之后开始。此后的 polling、字体导致的重新测量与普通 graph update 都会保留用户当前的 pan 和 zoom；只有 search/Map focus request 会有意移动 viewport。`Re-layout` 会清除全部手动拖拽位置、恢复确定性的 tree coordinate 并 frame 完整 graph，在画布难以阅读时提供明确的恢复操作。

沿用独立版画布，节点操作集中在不透明的右键菜单：Locate in Chat、Branch from Here、Archive node、仅在存在 manual override 时显示的 Restore automatic，以及 Archive 后的 Show original/Restore node。Branch 会在消息对应的 completed Turn boundary 调用 Harness 原生 `sessions.fork`，并打开新的 child Session。Locate 会打开所属原生 Session、切换到 Chat、在需要时加载较早 history，并滚动和高亮准确的持久消息。Batch mode 会在一个 plan revision 中 include、exclude 或恢复多个画布选中节点。Clear manual changes 会移除全部 Include、Exclude 与 Archive overlay，但不会重置 graph layout；Undo 和 Redo 操作持久 plan history。

主 `Recommend` 按钮运行 Fast review；相邻的 `Recommendation mode` 菜单让用户明确选择 Fast 或 Deep tree review，不会自动升级。Fast 发送有界 candidate set；Deep 让受限 Harness child 通过 Read/Grep 检查一次性的完整 tree 文件。Deep 以内联 `Inspecting tree…` 显示进度，并可取消且不影响 Chat。两种模式共用仍覆盖在可见 graph 底部的 Current → Proposed review sheet。Sheet 使用不透明的主题背景，避免底层 graph 干扰建议文字阅读；它汇总新增和移除节点，card checkbox 在用户应用整份替换前始终表示旧版本。无害 no-op 会被过滤，不再让 proposal 失败；一次 Undo 会整体恢复此前版本。Archive 不提供批量执行：每个 candidate 都必须单独 review，展示 evidence 与 graph impact，并且只能确认为服务端所有的空 placeholder。替换后的 card 保持相同 node ID 与 graph structure，以空白正文显示 `Original retained`，并在右键菜单提供 `Show original` 和 `Restore node`。空 placeholder 正文不参与 Map 搜索。关闭、取消或 dismiss 建议不会改变持久状态。Plan 变化、active Session 变化，或任意 parent、sibling、descendant 的追加都会把 proposal 标为 stale，Host 还会在 mutation 前立即重复校验。

当 completed Q&A 高置信度地偏离主题，或更适合与当前路径并列时，最终 output 旁会出现紧凑的非模态卡片。`Keep here` 放弃本次建议；`Move to new branch` 执行可重试的原生搬迁并打开新 Session。源 card 会保留为结构性的 Archive placeholder，因此不会切断原 graph 支点。

Profile Settings 提供 Contextify Prompt Dashboard，分别配置 Context、Archive 与 Branch。随包提供的 prompt 默认灰色只读；Additional instructions 是正常编辑入口。替换默认基线必须显式确认解锁，恢复基线不会丢弃追加规则。

Map 也会订阅 Harness 原生的 Workspace archive set。仅属于已归档 Session 的节点和边会立即消失；对应画布 selection 会清除，但用户拖动位置按完整原生 family 保留，因此恢复 Session 后节点会回到此前坐标。由未归档后代继承的消息仍会保留，因为它们仍是该 Session context 的一部分；但它们的 Locate、Branch 与 context-selection 目标会重新绑定到可见后代，而不是已归档 owner。归档 active Session 时则沿用 Harness 的普通行为，清除当前 conversation。

普通 Chat user 消息与已完成 assistant 消息旁提供紧凑的 Auto/Use/Skip/Map control。它们和 graph 使用同一个 controller，所以 Chat 侧修改会同步到 map，并在 reload 后保留。Steering、reasoning、tool 与仅 runtime 可见的 row 不会获得 Context Map control。

Workspace 左侧栏会另外用递归可折叠 tree 展示原生 Session 祖先关系。在 branch family 很密集时，Map 是信息更完整的导航入口。

<a id="model-experience"></a>
## 模型体验

通过这些控件修改的 Host-owned Contextify plan 与 compiler 间接影响模型体验。

#### KV Cache 影响

UI 不添加提示词文本。Auto 跟随 active Session 历史，Skip 排除一条历史消息，Use 引入同 family 的 off-path 消息；改变更早的已选消息可能从该消息开始降低前缀复用。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- Chat 或 Map 存在订阅者时，family update 使用有界的 1.5 秒 polling。
- 自动 Branch review 对新 Profile 默认开启，是 one-shot、并发且不会进入 subagent 列表的辅助调用；用户可以在 Prompt Settings 中关闭。
- 暂不提供跨 Map import。
- Contextify placeholder 保持为原节点 overlay；其他 compaction relationship 暂不能展开。

<a id="dev-note"></a>
### 开发备注

不发布不变量伴随插件，因为 Agent Loop 伴随插件检查编译后的请求，而本插件没有独立的运行时不变量。

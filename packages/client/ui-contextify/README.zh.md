---
description: "在原生右侧栏中查看 Context Map 并编辑持久上下文计划。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-contextify

[English](README.md) | 中文

## 概述

`dsh-client-ui-contextify` 在上游右侧栏中提供可交互的 Context Map 标签页。Map 与消息旁的 Chat control 共用同一个 Session-scoped controller，并操作同一份持久 Context Plan。 “开始”页同时列出 Context Map 与文件入口；选择入口会将该引导页原位替换为对应页面。

## 目录

- [用户体验](#user-experience)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="user-experience"></a>
## 用户体验

非空的原生 Session（包括普通 fork）会自动打开 Map。通过地址访问的子代理执行详情保留自己的对话控件，不会自动打开原生 Session 家族的 Map。

右侧子页使用 React Flow 以唯一的自上而下 tree 渲染相互连接的原生 Session family，不暴露其他布局模式。每条真实 user input、原生 Web 观察、worker 回报与每个 completed Turn 的最后一条可见 assistant output 对应一个 card；复制的 Session 前缀会去重，中间 assistant step、未完成输出、reasoning 与非 Web tool event 不进入图。每个 card 只有一个有效 context checkbox：勾选表示消息进入下一次模型请求，未勾选表示不进入。Natural 根据 active Session path 得出这个结果；checkbox 偏离自动结果时会写入相应的 Include 或 Exclude override，恢复自动结果时则移除 override。仅当跨分支 Web 结果具有原生调用来源和文本内容时才可 Include；跨分支 worker 结果与无来源 Web 结果仍禁用。Selection 模式仍是独立的画布操作，提供累加点击、可见的 Shift 拖动框选与批量操作。被拖动的节点会持续跟随指针，只在松开后持久化最终位置。画布选择和拖动位置仅属于 viewing state，不会改变模型输入。

第一批完成测量的 graph 只会 frame 一次。随后每个 React Flow card 会把真实 bounding box 反馈给 Dagre，因此即使 output 很长，下一层也会从上一张 card 的实际底部之后开始。此后的 polling、字体导致的重新测量与普通 graph update 都会保留用户当前的 pan 和 zoom；只有 search/Map focus request 会有意移动 viewport。`Re-layout` 会清除全部手动拖拽位置、恢复确定性的 tree coordinate 并 frame 完整 graph，在画布难以阅读时提供明确的恢复操作。

程序调整 viewport 会保留已打开的节点菜单；真实用户移动、空白处点击与 Escape 会关闭它。这能防止延迟的 search 或初始取景在指针交互期间移除操作。参见[移动归属决策](../../../.agents/notes/implemented/bug-fix/2026-10-14-context-map-move-ownership.zh.md)。

控件、无障碍名称与计数模板使用有类型的 Client locale。切换语言会更新 graph card 的标签，但不会翻译对话正文、Agent 给出的理由或已保存的操作值。graph 刷新会保留 card 的测量尺寸。search 会等待目标完成测量；首次取景后，只有新的 search 或 Map 请求才会移动 viewport，无关 card 的重新测量会保留当前 pan 与 zoom。

沿用独立版画布，节点操作集中在不透明的右键菜单：Locate in Chat、Branch from Here、Archive node、仅在存在 manual override 时显示的 Restore automatic，以及 Archive 后的 Show original/Restore node。Branch 会在消息对应的 completed Turn boundary 调用 Harness 原生 `sessions.fork`，把未变更的待发送草稿及附件转移到空白的 child 输入框，将成功的手动 fork 与转移的有界草稿记为一次 Context 策略选择，然后打开 child Session。如果 fork 期间草稿变更或 child 无法接收草稿，当前 Session 保持选中。Locate 会打开所属原生 Session、切换到 Chat、在需要时加载较早 history，并滚动和高亮准确的持久消息。Batch mode 会在一个 plan revision 中 include、exclude 或恢复多个画布选中节点。Clear manual changes 会移除全部 Include、Exclude 与 Archive overlay，但不会重置 graph layout；Undo 和 Redo 操作持久 plan history。

主要的 `Recommend` 操作执行零模型 Local 审核。旁边的 `Recommendation mode` 菜单显式选择 Local、Fast 或隔离 Deep 审核，不会自动升级。所有模式都在可见图上方使用 Current → Proposed 审核单，分别确认来源、路由与生命周期。确认前复选框保留当前选材。用户可以保持任一来源不变；一次 Apply 只接受选定条目，全部保留当前时 Plan 修订不变。Undo 恢复前一选材。Archive 仍逐节点确认服务端拥有的空占位内容，原文保留且可恢复。渲染只记录展示，不证明注意力。关闭时仅明确标为 Keep-current 的条目提供部分拒绝证据，不代表拒绝整单。草稿、图或 Plan 改变后旧建议失效，Host 在修改前再次检查。

每次手动请求建议前，Client 都先刷新原生 family 与 Plan。读取失败或 Plan 写入尚未完成时不会发出审核请求，即使界面仍保留此前的图。新的请求或清除草稿会丢弃仍在等待读取的旧请求；已经运行的审核器会拒绝重叠请求。读取之后发生的变化仍由 Host 的修订检查拒绝。

Composer 在未发送文本非空时显示 **Review context for draft**。默认 Local 审核不调用模型；旁边的草稿模式控件显式选择 Fast 或 Deep。点击审核保留未发送草稿并打开 Map。草稿改变后旧建议被丢弃。路由卡可以建议 Return、Navigate 或 Branch；接受时先通过原生服务转移原样草稿与附件，再切换分支，而 Stay 表示明确拒绝。新分支卡可以指定另一个父节点，预览新分支的 Context，并一次确认两者。Host 批准失败时，Client 尝试把未变化的已转移草稿及附件移回源分支；若并发编辑阻止恢复，草稿仍保留在目标分支。已经创建但未使用的子分支可能保留。

建议审核单展示 Host 提供的确切条件规则与管理工作流，包括任务活动和深度条件、带正负符号的支持度、有界任务案例，以及原生 Session/事件引用。输入大小限制导致条目被省略时，审核单显示省略数量。这些历史记录不会选择回答 Context 或执行工作流步骤。

Map 标题栏的 **Preferences** 按需读取 Profile 策略，展示审核支持度、重复操作倾向，以及带拥有它们的 Session/事件引用的近期明确选择。**Refresh** 在操作或 Undo 后重读证据。**Reset learned preferences** 通过已记录的 Session 水位清空派生学习，同时保留原始记录与当前 Context Plan。视图不存储第二份 Client persona。

**Branches** 折叠列表把每个原生 Session 的任务状态与 Active／Inactive 位置分开显示。**Move draft here** 明确把非空且未改变的草稿转移到另一个原生 Session；目标已有草稿时会拒绝，被动 Locate 不记录偏好。Complete、Park 和 Reopen 是经用户操作确认的选择：它们追加原生工作状态事件并刷新 graph。完成分支不会排除其中的消息或删除证据；对于一般的新任务，路由器不会默认导航到它，但用户明确要求 Resume 时仍可返回。之后若用户在已完成的分支写入新一轮消息，graph 投影会重新标为 open。

当 completed Q&A 高置信度地偏离主题，或更适合与当前路径并列时，最终 output 旁会出现紧凑的非模态卡片。`Keep here` 放弃本次建议；`Move to new branch` 执行可重试的原生搬迁并打开新 Session。下一轮尚未修改的草稿及附件会在切换前转移到 child composer；若搬迁期间草稿变化，当前 Session 保持选中。源 card 会保留为结构性的 Archive placeholder，因此不会切断原 graph 支点。

Profile Settings 提供 Contextify Prompt Dashboard，分别配置 Context、Archive 与 Branch。随包提供的 prompt 默认灰色只读；Additional instructions 是正常编辑入口。替换默认基线必须显式确认解锁，恢复基线不会丢弃追加规则。

Map 也会订阅 Harness 原生的 Workspace archive set。仅属于已归档 Session 的节点和边会立即消失；对应画布 selection 会清除，但用户拖动位置按完整原生 family 保留，因此恢复 Session 后节点会回到此前坐标。由未归档后代继承的消息仍会保留，因为它们仍是该 Session context 的一部分；但它们的 Locate、Branch 与 context-selection 目标会重新绑定到可见后代，而不是已归档 owner。归档 active Session 时则沿用 Harness 的普通行为，清除当前 conversation。

普通 Chat user 消息与已完成 assistant 消息旁提供紧凑的 Auto/Use/Skip/Map control。它们和 graph 使用同一个 controller，所以 Chat 侧修改会同步到 map，并在 reload 后保留。Steering、reasoning、tool 与仅 runtime 可见的 row 不会获得 Context Map control。

Workspace 左侧栏使用上游 Session 列表。Map 提供完整的分支家族导航界面。

Context 提示词设置允许用户为 Fast 检查选择当前聊天模型、Jev 或目标模型加 Jev，并启用或关闭历史选择复用。审核表分别展示发送给模型的案例、确定性校准来源记录和分支阈值来源记录，并区分接受与拒绝的选择。这些记录用于管理建议，不加入回答 Context。

对于既有目标，“携带建议 Context 移动草稿”明确批准完整的已审核来源集合，避免再次调用模型。部分 Keep-current 选择会禁用此操作。目标手动设置冲突时保留原 Plan；Client 尝试将未变化的草稿移回源分支，恢复受阻时保留在目标中。只移动草稿的操作独立保留。

可选的目标模型加 Jev 检查会为草稿调用一次聊天模型及至多一次 Jev。设置中说明额外费用；不确定时跳过 Jev 和推断式 Context 修改。仅选择决策模型不会发出请求。

Context 偏好面板显示完整策略确认样例的历史模式、任务和 Session/事件引用。刷新会读取和 Host 输入相同的事件投影，Context Undo/Redo 后请刷新；重置学习会刷新列表。显示历史选择不表示它已影响当前请求，也不授权执行操作。

<a id="model-experience"></a>
## 模型体验

通过这些控件修改的 Host-owned Contextify plan 与 compiler 间接影响模型体验。

#### KV Cache 影响

UI 不添加提示词文本。Auto 跟随 active Session 历史，Skip 排除一条历史消息，Use 引入同 family 的 off-path 消息；改变更早的已选消息可能从该消息开始降低前缀复用。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- Chat 或 Map 存在订阅者时，family update 使用有界的 1.5 秒 polling。
- 自动 Branch review 对新 Profile 需要主动开启，是 one-shot、并发且不会进入 subagent 列表的辅助调用。
- 暂不提供跨 Map import。
- Contextify placeholder 保持为原节点 overlay；其他 compaction relationship 暂不能展开。

<a id="dev-note"></a>
### 开发备注

不发布不变量伴随插件，因为 Agent Loop 伴随插件检查编译后的请求，而本插件没有独立的运行时不变量。

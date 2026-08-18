# Agent Note：原生 Session Context Map

Status: implemented

[English](2026-08-17-native-session-context-map.md) | 中文

## 问题

Long-horizon 对话同时需要 branch navigation 与下一次模型请求的历史输入控制。Harness 已经拥有持久 Session fork，而早期 Context Map prototype 又维护了一套不兼容的 Session 内 path。保留两套 branch 会让导航、持久化、命名与模型 context 相互矛盾。

## 决策

一个原生 root Session 及其全部后代组成一个 Context Map。Branch 一律在 completed Turn boundary 调用 `sessions.fork`。Graph 中每条可见 append user/assistant 消息对应一个节点，复制前缀会去重，reasoning、tool 与 runtime-only event 不进入图。

每个 Session 拥有自己的持久 Context Plan。Child 继承事件前缀，但 plan 重置为 Natural。Natural 跟随当前 Session 历史；Exclude 移除 active history 中的消息；Include 对同 family 其他 Session 的消息建立 snapshot。跨 Map import 与自动 include recommendation 暂缓。

右侧 React Flow map 与 Chat 消息 control 共用一个 controller，两者都只持久化 Harness 原生的 Natural/Include/Exclude。Map 会把这套约定呈现为单个有效 context checkbox：Natural 根据 active path membership 得出结果，和 path 不同的结果则编译为 Include 或 Exclude。Checkbox 恢复到 path 结果时会写入 Natural，并移除 manual override。Map 另外提供原生 Branch、Session navigation、搜索、三种布局、多选批量修改、清除全部 manual change，以及 plan Undo/Redo。Workspace 左侧栏以递归可折叠 tree 展示同一 Session ancestry。

画布会移植独立 prototype 的交互模型，但不会移植它的 domain store。Checkbox 是普通点击中唯一会改变有效 context 的目标；普通模式点击 card 不会修改 plan。Selection 模式负责累加 card 点击和可见的 Shift 框选；浮动操作条会批量执行有效 include、有效 exclude 或 restore-automatic。Checkbox event 与 React Flow 拖动、画布选择相互隔离。右键菜单提供 Locate in Chat、Branch from Here，并且仅对 manual override 提供 Restore automatic。节点拖动期间，位置会持续更新在临时 React state 中，只有拖动结束时才写入持久 viewing store。

Locate in Chat 通过原生 Session ID 与持久消息序号委托给 conversation 包。Conversation service 会打开所属 Session、把原生 view ring 切回 Chat、持续加载较早 history page 直至消息锚点可用、把该行滚动到中央，并添加临时高亮。Contextify 不查询也不拥有 conversation DOM。

## 考虑过的替代方案

**在单一 Session 中另建 path model。** 独立 prototype 使用一个 Session 内的轻量 path，但若让它与原生 Session fork 同时成为 branch identity，持久化、导航、命名与 context selection 会彼此冲突。

**使用独立的 Context Map 页面。** 全屏 map 空间更大，但用户无法一边阅读 Chat，一边决定下一次请求使用哪些历史。固定在 details column 可让导航与 compilation control 始终位于对话旁边。

**首版支持跨 Map import。** 任意 import 需要额外设计 discovery、authorization 与 provenance。Same-family Include 可以先验证 compiler 与交互模型，而不扩大首版 data boundary。

## Append-only 兼容

Context 修改不会 edit 或 delete transcript event。Include 写入 `context/compiler-snapshot`；plan 修改写入完整、带 revision 的 `contextify/plan` event。`contextify@2` compiler 在请求时选择 model message、恢复 current-turn message，并保持 Harness 普通 surface 不变。

## 测试

纯 projection 与 compiler 测试覆盖 canonical prefix 去重、原生 fork boundary、Context Plan revision、same-family snapshot、child reset 与 runtime context 过滤。Client 组件测试覆盖有效 checkbox projection、自动 override 移除、optimistic failure rollback、checkbox event isolation、Selection 点击、Shift 框选、批量 mutation、右键操作、拖动中的临时位置与结束后的持久位置、Session＋seq reveal、原生 Chat tab 激活、history paging、精确滚动与临时高亮。Browser-plugin 测试固定 Contextify 对原生 Session、conversation、layout 与 Remote face 的委托。

## 暂缓

跨 Map import、自动 recommendation、compaction shadow relationship 与 push projection channel 均明确暂缓。

## 后果

Harness 只有一个 branch authority 与一个 context authority，同时 pinned canvas 保留了独立 prototype 的直接操作体验。把临时拖动和画布选择状态与 Context Plan state 分离，可以避免画布手势产生持久 model-input 修改；把消息 reveal 交给 conversation，可以让 DOM ownership 留在实际渲染它的包内。有效 checkbox 从高频路径中移除了三状态呈现，但用户仍可通过 Restore automatic 与 Clear manual changes 区分状态来源。这会给 conversation 增加一个内存 reveal registry 和精确消息锚点；Locate 请求在完成前可能分页加载更早 history。大型 Session family 仍可能增加 graph 与 polling projection 的开销；有界分页和仅在存在订阅者时轮询可以限制该成本，但后续仍可能需要 push projection。显式修改较早消息可能降低 KV cache prefix reuse，因此 Natural 仍是默认状态，manual override 会一直保留到用户主动恢复。

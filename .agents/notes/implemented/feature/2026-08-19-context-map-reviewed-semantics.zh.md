# Agent Note: Context Map 审阅式语义控制

Status: implemented

[English](2026-08-19-context-map-reviewed-semantics.md) | 中文

## Problem

原生 Session family 保存完整对话历史，但长周期工作需要缩小单次请求上下文，同时不能丢失分支身份或产生不可逆编辑。自动清理并不安全，因为单条消息可能是后续分支的支点，而且同族其他 Session 的变化可能让正在生成的建议失效。

## Decision

`dsh-contextify` 继续以原生 Session 消息、边、fork 边界、归档投影和所有权作为图结构权威。Map 只投影每个已完成 Turn 的首个用户输入和最终 assistant 输出。Include 与 Exclude 是持久化 Context Plan 选择；reasoning、工具和 assistant 中间步骤仍保留在原生轨迹中，但不会成为 Map 节点。

隔离的 Harness spawn Agent 接收某个精确 family revision 的有界 JSON 投影，并只返回供审阅的选择与清理建议。消息内容按不可信数据处理，工具被禁用，结构化输出会针对已审阅图校验，任何建议都不会修改父 Session。选择变更仅在用户明确同意后执行。清理没有批量操作：每个候选都必须单独确认，并且只把模型可见语义替换为保留角色的 placeholder。

Context Plan version 3 将替换 overlay 与原生消息分开保存。替换会保留节点 id、角色、边、fork 点、原始内容以及 Include 或 Exclude 状态。Restore 会移除 overlay；如果 off-path Include 指向 placeholder snapshot，恢复时会把它重新绑定到新建的原始消息 snapshot。Reset 会清除所有显式选择与替换。Version 2 plan 在内存中归一化，并在下一次修改时写为 version 3。

推荐新鲜度同时使用 Context Plan revision、active Session 身份，以及覆盖 family 内每个原生聊天 Session header 和追加位置的哈希。标记为 `origin: subagent` 的 Session 不进入 graph 及其 revision，因为 review Agent 自己就是临时 child 实现细节。服务会在启动前、隔离运行完成后，以及真正接受选择或清理修改前校验该 revision。因此 parent、sibling、原生 descendant、plan 或 active Agent 状态发生变化时都会 fail closed。

Client 将 Map 作为固定在右侧详情栏的页面，与原生 Details 页面并列。React Flow 使用测量后的节点边界定位，因此 parent 底部到 child 顶部以及 sibling 边界会保持固定图空间间距，测量后也不会重置用户视口。原始消息弹窗接收完整文本，卡片仍使用有界预览。

## Verification

Contextify 服务测试覆盖有界隔离推荐、shipped spawn child 的临时 Session 形态、family 全局 stale 拒绝、version 2 归一化、选择编译、active 与 off-path 可逆替换、历史以及 busy Agent 拒绝。Client 测试覆盖只审阅状态、显式原子接受、stale 建议、完整原文显示、逐项清理、复选框、原生菜单和测量布局。无密钥的组装 Web replay 证明 recommendation 本身不改变状态、接受 selection 后 compiled context 才变化、未确认 cleanup 不生效、确认后产生 placeholder 且 restore 能找回原文；它还覆盖原生分支与归档行为、右栏交互、重载持久性和长节点间距。

## Alternatives considered

**在单个 Session 内创建第二套 branch 模型。** 未采用，因为原生 Harness Session 已经拥有 fork、持久化、归档行为和 Agent 生命周期。并行的分支词汇会分裂权威来源并让导航产生歧义。

**让推荐自动执行。** 未采用，因为相关性和语义过时属于用户意图判断，而且 family 变化可能在运行期间让建议失效。显式审阅让模型保持建议者角色。

**清理时删除图节点。** 未采用，因为删除可能断开 descendant 并抹掉有效 fork 支点。可逆 placeholder 能修改请求语义而不改变拓扑。

**使用固定估算高度布局卡片。** 未采用，因为消息长度、视口宽度和替换 badge 都会改变实际边界。测量是避免重叠的可靠输入。

## Consequences

用户可以在 Chat 同一界面控制下一次模型请求，同时保留 Harness 原生历史、分支、详情和归档。清理保持可逆且不破坏拓扑，过期建议无法跨越 family revision。该设计增加了持久替换 snapshot、family 哈希、隔离推荐调用和测量布局过程；它明确不提供自动清理、跨 family Map、reasoning/tool 节点和拓扑删除。

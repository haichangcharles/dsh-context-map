# Context Map 上线语义设计

[English](2026-08-19-context-map-release-semantics-design.md) | 中文

## 目标

在不为 Harness 另造一套对话模型或 Agent loop 的前提下，补齐 Context Map 的上线行为。用户可以归档单条消息、把有效上下文作为一个完整版本进行审核替换、在 Turn 完成后收到轻量 Branch 建议，并在当前 Harness Profile 中自定义各类审核 Prompt。

## 产品模型

原生 Session fork family 仍是唯一的对话拓扑。Contextify 只增加可逆语义 overlay 和审核 proposal，不改写原生 Session 历史，也不允许推荐 Agent 直接修改状态。

从祖先继承的 canonical message 继续以该祖先作为 owner。即使用户正在查看某个 sibling，从同一 canonical message 和 completed Turn boundary 发起的 fork 仍互为同级。只有从 child Session 首次生成的消息发起的 fork，才是该 Session 的子级。

## Context 版本替换

一次 Context 推荐比较两个完整的有效选择版本：

- **Current** 是被分析的 Context Plan 与 family revision 下实际 included 的节点集合。
- **Proposed** 是在 Current 上应用 Agent 给出的受限 include/exclude delta 后得到的目标集合。

Agent 可以同时思考移除与加入，但产品只展示一次版本替换 proposal，不拆成两个执行阶段。服务端确定性计算 `added = Proposed - Current` 与 `removed = Current - Proposed`；审核 UI 展示该 diff，并把用户接受的全部选择变化作为一次 Context Plan revision 提交。Undo 一次恢复完整旧版本。

服务端会归一化无害模型输出。对已 included 节点再次 include、对已 excluded 节点再次 exclude，或重复返回相同动作，都不会导致整份 proposal 失败，也不会出现在 diff 中。未知节点、同一节点的冲突动作、非法字段以及过期的 plan 或 graph revision 仍然 fail closed。

## 单节点 Archive

Archive 是用户确认后作用于单条可见 user input 或最终 assistant output 的语义操作。它复用确定性空 placeholder overlay：原生消息、node ID、role、branch boundary 和 edges 保持不变，但编译时以包内固定 placeholder marker 替代原语义。节点卡片显示 archived 状态，正文为空。

节点右键菜单提供 Archive node 与 Restore node。Archive 和 Restore 都进入 Context Plan 的 undo、redo 与 reset。推荐 Agent 可以提供带证据的 Archive candidate，但不能执行归档，也不能生成 placeholder 内容。

## Context 审核结果

一次 Context review 包含：

- 完整的 Current 与 Proposed 有效选择版本；
- 确定性计算出的 added 与 removed 节点列表；
- 可选且需要逐项审核的 Archive candidates。

Apply 只提交选择版本替换。Archive candidate 改变消息语义，因此必须单独确认。Dismiss 不修改 Context Plan。任何 family 或 plan 变化都会让整份 review 过期。

## 轻量 Branch 推荐

成功 Turn 完成后，Contextify 可以启动一次隔离、无工具的 Harness subagent 请求。主回答与输入区立即可用；Branch review 不能阻塞对话。

请求只包含当前局部目标、最近最多三个 completed Turns、刚完成的 input 与 final output、branch depth 与数量，以及当前 Profile 的 Branch Prompt 追加或覆盖内容。输出仅包含 `continue` 或 `suggest_branch`、confidence 和简短 reason。每个 Turn 最多审核一次。超时、供应商失败、非法输出、低置信度或出现更新 Turn 时，审核静默结束。

默认策略保持保守：只有当刚完成的 Q+A 明显属于离题内容、平行探索或可分离子任务，并且迁移有助于保护当前工作主线时才展示建议。建议卡片提供 Move to new branch 与 Keep here；未经确认不会创建 Branch。

## 用户确认后的 Branch 迁移

Harness Session log 是 append-only，因此确认操作使用原生 fork 加确定性 replay，而不是删除历史：

1. 再次校验 active Session、completed Turn、Context Plan revision 与 family revision。
2. 根据 source Session ID 与候选 Turn boundary 生成稳定 relocation key；重试时复用已经携带该 key 的 child。
3. 在候选 user input 之前的 completed boundary 创建原生 child Session。
4. 只把该原始 user input 与 final assistant output 以一个 completed Turn replay 到 child，保留 role 与内容，并在 child 上记录 relocation key。
5. 用确定性空 placeholder 归档 source Session 中的两个原节点。
6. replay 与 source plan mutation 均成功后再打开 child Session。

因此图上会在 source path 保留空的结构支点，并在新的原生 Branch 上展示完整 Q+A。source plan 提交前失败时，原节点保持不变；重试会复用已经创建的 relocation child，不会重复创建。Context Plan Undo 不会删除已经创建的 Session，因此确认 UI 必须说明这一后果。实现必须防止 replay Turn 再次触发 Branch review。

## Profile Prompt Settings

Contextify 在当前 Harness Profile 中注册一个 settings namespace，分别配置 Context replacement、Archive review 和 Branch suggestion。每项包括：

- 灰色只读展示的包内默认 Prompt；
- 默认使用的 Additional instructions 输入框；
- 明确的 Override default prompt 操作，用户确认后才解锁完整自定义 base prompt；
- Restore default，只移除 override，不删除 additional instructions；
- effective prompt 预览。

双击可以作为显式 override 操作的快捷方式，但可见按钮仍是可访问、可发现的主要入口。新 review 在启动时获取 effective prompt snapshot；修改设置不会改变已经运行的审核。空 additional instructions 继续使用包内默认值。非法或不可读设置由 settings provider 拒绝，不能静默覆盖上一份有效配置。

## 展示

Context review 以 Current → Proposed 展示版本变化，并先汇总 added、removed 与 Archive candidate 数量，再展示节点详情。Branch 建议使用回答后的轻量卡片，而不是 modal。节点右键菜单使用不透明 elevated background、边框、阴影以及足以覆盖卡片和连线的 stacking order。

## 失败与并发行为

- 推荐输出在用户明确操作前始终只是 advisory。
- 每份 proposal 携带被分析的准确 plan 与 family revision。
- 重复 Apply、过期 Apply 与过期 Branch 确认都失败，且不产生部分 Context Plan mutation。
- Context replacement 是一个 revision 和一个 undo unit。
- 每次用户确认的 Archive 是一个 revision 和一个 undo unit。
- Branch review 不运行工具、不发起第二个模型 step，也不延迟来源 Turn。
- replay 的 Branch 内容不能递归安排新建议。
- 同一 source Turn 的 Branch relocation 必须幂等，重试不能创建重复 child。
- 现有手动 Branch from Here 继续直接调用原生 Session fork。

## 验证

- Recommendation protocol 测试覆盖 no-op 归一化、冲突动作拒绝、完整 Current/Proposed 推导、原子 Apply、过期拒绝和一步 Undo。
- Service 测试证明 Archive 与 Restore 保留拓扑并编译固定 marker，且 Agent 输出不能生成 placeholder 文本。
- Family 与客户端测试证明，同一 canonical point 的 fork 在 Map 与 Sidebar 输入中均为 siblings，从 branch-local 节点 fork 时均为 children。
- Branch 测试覆盖每个 completed Turn 只审核一次、无工具单请求、低置信度静默、过期失效、接受后的 replay、source placeholders 与递归抑制。
- Settings 测试覆盖 append、override、restore default、per-profile persistence、effective-prompt snapshot 与只读默认展示。
- 客户端测试覆盖完整版本 diff、独立 Archive 确认、Branch 建议操作和不透明右键菜单。
- 组装 Web replay 通过真实插件组合验证 completed conversation、Context replacement 与 Undo、单节点 Archive 与 Restore，以及确认后的 Branch 迁移。

## 不在范围内

本设计不自动应用 Context selection、不自动归档消息、不自动创建 Branch、不物理删除 Session event、不把 reasoning 或 tool event 放进 Context Map，也不引入 cross-family context selection。

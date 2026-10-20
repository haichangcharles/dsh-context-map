---
description: "管理原生会话家族的上下文选择、归档占位与分支建议。"
kind: "package-reference"
---

# @deepseek-ai/dsh-contextify

[English](README.md) | 中文

## 概述

`dsh-contextify` 把一组由 Harness 原生 Session fork 连接起来的对话投影成消息级 Context Map，并注册 `contextify@3` Context Compiler。它不再创造第二套 branch 概念：每条 branch 都是普通 Session，`parentSession` 与 `inheritedEventCount` 完全由 Harness 管理。

## 目录

- [当前行为](#current-behavior)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="current-behavior"></a>
## 当前行为

没有已记录 Context Plan 的 Session 使用只读的 Natural 默认状态。启动 Agent 或读取 graph 不追加 Plan 或 compiler 选择，因此普通 surface compiler 与请求日志保持不变。第一次提交 Context 编辑时，系统记录初始 Undo 状态和编辑后的 Plan；若当前使用 surface compiler，再选择 Contextify。恢复已有 Plan 的 Session 时会选择 Contextify。新 fork 的 child 会把继承的已记录 Plan 重置为自己的 Natural 状态，因此 context 修改不会被静默继承。

Family projector 从原生 root Session 遍历全部原生后代；标记为 `origin: subagent` 的 Session 属于执行细节而不是聊天分支，因此不会进入 Map。它按最早拥有消息的 Session 对复制前缀去重。它投影真实 user input、原生 `web_fetch`／`web_search` 结果、worker 回报，以及成功 `turn/end` 后最后一条含文本或图片的 assistant message。节点带有 `chat`、`web` 或 `worker` 来源类型；只有成功、纯文本且明确引用匹配工具调用的 Web 结果才保留原生 `web_fetch` 或 `web_search` 动作，以此标记可跨分支导入。Turn 运行期间 assistant 文本不会进入图；更早的 ReAct step、中间提问、失败或中断时的部分输出、纯 reasoning assistant event、tool call、非 Web tool result、context injection 和其他 runtime event 也都会被排除。聊天节点会解析到所在 completed `turn/end`，Branch 因而使用 Harness 原生 Session fork 接受的边界；证据节点不是分支支点。

每个投影后的 Session 还有任务工作状态。Active 分支默认 `open`，inactive 分支默认 `parked`；只有经用户界面确认的 `contextify/work-state` 事件才能将其标为 `completed`。之后该分支上的新一轮用户消息会重新打开它。状态由仅追加的原生事件推导，并受到 family graph 修订号保护；它不会改变 Context Plan 或下一次编译的模型请求。路由器不会为一般新任务推荐已完成分支作为目的地，但允许明确 Resume 和将其证据 Include。

持久计划包含三种选择模式：

- **Natural**：消息属于当前 Session 的继承或本地历史时，保持默认输入。
- **Exclude**：从下一次 compilation 中移除一条 Natural 历史消息。
- **Include**：把同一原生 family 内其他 Session 的消息复制到本地 `context/compiler-snapshot` 事件，并按稳定位置插入。

Plan v3 还支持针对单条 user input 或最终 assistant output 的可恢复 **Archive** overlay。Archive 与 context 选择刻意分离：服务端只把模型可见语义替换成固定标记 `[Placeholder: intentionally empty]`，不接受 Agent 或客户端生成的替换文本。同一个 graph node、role、edge、原生 fork boundary 与 append-only Session 原事件全部保留。Restore 只移除 overlay。Reset 会同时清空 Include、Exclude 与 Archive overlay；Undo/Redo 会回放三者。已有 v2 plan 在内存中规范化；已有 v3 replacement snapshot（包括旧版自定义文本）仍可读取和恢复。

每次 plan mutation 都按 revision 做 compare-and-set，并记录完整 undo/redo 状态；Reset 回到 Natural。跨 family 引用、不可用消息、旧 revision、不支持的状态变化以及非 idle Agent 都会失败，不会产生部分更新。跨 Map import 暂不在范围内。活动路径上的 Web 与 worker 证据可以 Exclude、恢复 Natural，并通过 Undo 恢复。同一 family 内的跨分支 Web 结果若有一条匹配的原生工具调用、成功且只有文本，可作为记录在日志中的 `recall` snapshot Include；其中包含工具名、调用参数和作为引用数据的观察结果，snapshot 记录原 Session 与结果序号，Undo 会从下次编译中移除它。这是渲染后的证据副本，不是重放原生工具协议，也不能防御提示注入。跨分支 worker 证据仍不能 Include，证据也不能作为对话占位符 Archive。

压缩 checkpoint 覆盖的历史消息若被当前计划 Exclude 或 Archive，编译器会沿已记录的来源事件展开该 checkpoint，再应用当前逐消息选择。其余 checkpoint 保持压缩，Undo 后仍可重新选中原 checkpoint。这个处理只覆盖有记录的消息来源，不涵盖 summarizer 读取但未记录的信息。

导航使用规范化后的原生 branch 祖先关系。从 parent 继承的边界再次 fork，会与已有 branch 同级；只有在 branch 自己新增的边界上 fork，才成为它的 child。两种情况下，graph 都继续显示真实共享的消息支点。

`contextify` Remote namespace 通过[生成的 Cordis API](../../../docs/cordis-api/context.zh.md)提供检查修订的图、Context Plan、审核与策略操作。`policyEvidence` 读取近期确认选择及拥有它们的 Session/事件引用。`resetPolicy` 为已知原生 Session 记录自有事件水位，过滤重置前的学习，并保留原始日志与活动 Context Plan；之后的事件即使与重置时间戳相同，也可重新积累偏好证据。

决策数据包还携带有界的管理记忆投影：带适用条件的偏好规则，以及重复出现的两步或三步管理工作流；每项保留带正负符号的有效支持度与拥有它们的事件引用。匹配的分支深度、已知任务活动与来源类型限制规则复用；有因果联系的 Session 目标限制工作流组装。Undo、重置与关闭个性化会移除对应输入。历史任务与引用只为管理提供依据，不进入回答 Context，也不授权路由。[管理记忆决策](../../../.agents/notes/implemented/feature/2026-10-19-context-management-memory.zh.md)定义大小限制、来源与复用边界。

`stewardProfile` 从同一 DSH Profile 下的原生 Session 日志中，将客户端确认的 Context 选择投影为紧凑的策略记忆。它报告 Include、Navigate、Branch、Return 和 Release 的平滑接受率、证据量、建议阈值以及重复选择形成的规则。系统只重读变化过的 Session 家族，未变化的家族复用缓存；无法读取的历史家族会被跳过并在 Host 记录警告。当目标已知时，确实改变状态的单节点 Natural 选择也提供明确证据：恢复活动路径材料计作 Include，撤回借用的跨分支材料计作 Release。这与 Context 排序器一致；未知目标、无变化的操作、未标记的调用、批量编辑和已撤销状态都不会增加有效偏好证据量。Include/Release 观测可保留所选节点的 `chat`、`web` 或 `worker` 来源类型，因此不同来源的行为不会被强行合并为全局偏好。已明确标记为写作、规划或头脑风暴的审阅也会形成任务类型证据；Branch 审阅使用被审阅 Turn 的用户输入，不从之后的消息猜测。成功的手动 Context Map fork 会记录转移到子分支的有界草稿，使这次明确的 Branch 选择也可按任务类型归类；空草稿仍不归类。当总体规则混杂或相反时，偏好摘要可显示任务类型及「来源 × 任务类型」的例外规则，并省略重复的细分规则。当邻近分支深度内至少有四次有效审阅时，估计也会按深度区分；证据不足时退回 Profile 总体估计。已审阅的草稿路由卡会提供明确的 Navigate、Return 和 Branch 选择；Context Map 中成功执行的手动 fork 会通过 `contextify/manual-branch` 提供正向 Branch 选择。仅看到路由卡不构成偏好。一次多项审阅的总权重为一；仅展示卡片、未标记的 Remote 调用和已撤销的计划修改都不构成偏好证据。此投影只调整建议，不授权自动修改 Context Plan 或 Session。

用户先将某项标为 Keep current 再关闭审核时，这项被建议的动作提供明确拒绝证据。只有明确拒绝了条目时，关闭事件才保留有界审核目标。每个拒绝项的权重为整单总条目数的倒数；未决定的条目和单纯 Later 均没有标签。策略投影跨 Profile 读取这些部分选择；再次审核同一草稿时，只压制被拒绝的动作与节点组合。之后明确接受同一项会清除此项压制。拒绝不会成为相反动作的正向风格编辑，关闭也不会改变 Context Plan。

草稿明确要求忽略或排除一个完整 Web URL 时，Fast 审核走一个免模型的高置信度路径：只从有因果绑定的 `web_fetch` 调用参数解析 URL，要求它唯一对应当前纳入的来源，且没有相冲突的手动 Include，然后给出待确认的 Exclude。仅在网页正文中出现的 URL 不算来源标识。缺失或有歧义时回退到普通 Fast 审核；Apply 仍检查图与计划版本，原草稿不会被发送或改写。

Local 校准直接读取原生图的标量特征，不构造模型数据包。因此，积累大量手动 Context 设置不会触发 Fast 的 32 个必选节点上限。直接 Exclude 不会占用自动 Include 的名额；已审核的临时 Exclude 仍可恢复。原生验证保留每个手动 Include/Exclude。Fast 仍使用有界推理数据包，并在必选候选过多时于模型调用前拒绝。参见 [Local 审核候选准入决策](../../../.agents/notes/implemented/bug-fix/2026-10-19-local-context-admission.zh.md)。

Local 和 Fast 审核可为明确的草稿目标给出独立路由卡。Local 使用保守的文本提示与词法分支匹配。Fast 从同一次模型回复接收可选、有界的意图、目标分支、证据与失效分数；未知候选和非法分数会被拒绝。明确提示优先，路由不确定时保持当前分支，证据有用不代表应切换目标。Fast 在 `contextify/recommendation-request` 中记录冻结的系统提示、用户数据包、目标、provider/model 与输出 token 上限，不记录密钥；该日志事件不会改变图修订。Client 在移动前复核准确草稿、图修订、Plan 修订和目标。`reviewRoute` 在原生转移成功后记录明确接受，或记录明确 Stay；它不负责切换 Session。成功的 `recordManualRoute` 将明确 Move draft here 操作与被动 Locate 区分记录。路由建议与 Include/Exclude 残差均可使用同一 Profile 下其他原生家族的确认选择。

`recommend` 提供三种模式。Local 为默认模式：它复用有界图候选与确认选择策略，不解析或调用模型；明确的生命周期提示可以独立建议一次 Park、Complete 或 Reopen。Fast 需要显式选择：一次有界、禁用工具的 classifier 审核可能需要的来源与可选语义路由。Local 和 Fast 均丢弃 Archive 候选。Deep 把完整树写入私有临时文件，启动只能对该文件执行精确路径 Read/Grep 并结构化提交的受限 Harness child。Profile 的 `deepMaxRequests` 默认三次，可设一至十次请求，重试也计入；超时为 45 秒，每次最多输出 1,200 tokens。任何结束路径都会清理 child 与文件。Fast 和 Deep 还可返回一项可选生命周期建议，必须对应已知原生 Session、合法状态和真实状态变化；明确的草稿生命周期意图优先。Deep Archive 候选需要逐项确认。所有模式在确认前均不修改 context。应用已校验的选材仅提交一次 compare-and-set Plan 修订；Undo 恢复前一版本。`reviewWorkState` 单独确认或拒绝准确的待审生命周期建议，绝不改变选材。

在长对话中，Fast 依据与当前目标的词项重叠，选出最多八条活动路径上较早但仍被包含的消息，同时给跨分支候选预留空间。候选准入不依赖个人历史，因此切换个性化开关不会改变当前候选集合。对于排名靠前的旧消息，它还检查活动路径中位置更晚、角色相同且词项足够相近的消息；即使后来的纠正与当前目标用词不同，也可能一同进入审核。经过分支支点时，它另将当前活动分支入口的最多三条消息保留在候选包中，即使这些消息与本轮目标没有词项重合；此类入口消息总共最多六条，且不占用跨分支预留空间。对跨分支候选，Fast 先预留最多四条符合导入条件且绑定原生调用的 Web 观察，优先覆盖不同分支再按分数补足，然后执行一般的分支覆盖和分数填充，避免大量词项相近的旧聊天消息占满跨分支名额，同时保留其他聊天与来源候选。完整 packet 仍最多 32 个节点，其中跨分支节点最多 12 个。审核 Agent 因而能同时看到可能冲突的两个版本和回访分支最初的目的；路由本身不修改 Context Plan。

Fast packet 还会展示最多四条同一 Profile 跨 Session 家族中较早的、由 Client 确认的 Context 选择，每条目标和消息摘要至多 180 个 Unicode 码位。它先选最多两条与当前目标相近的案例，再用近期选择填满剩余名额；已审核多项选择的分数权重会保留在这份有界列表中。另将最多两次已接受、实际改变计划的多节点建议作为成组 `planExamples` 展示，每组不超过四个选择。每个选择明确记录确认前后该消息是否被纳入；只有组内每个节点都真实改变状态时才保留这组案例。记录不完整或没有 Client 来源标记的批量操作也不展示。这些是供 classifier 参考的证据，不是指令，也不会修改 Plan。仅凭来源／路径风格不再对聊天消息新增 Exclude：用户曾五次排除旧聊天约束，不意味着较新的更正也应被自动排除。Classifier 仍可在看到两个版本后建议排除具体旧消息，但需要用户确认。 已确认选择还会携带经原生日志核验的 `ownerRelation`（本任务、祖先任务或其他任务），独立于包含继承消息的 `onActiveBranch`。关系依据原编辑 Session 和不可变父记录推导；复制前缀归属未获核验或祖先记录不完整时省略。它只表示来源归属，不是用户期望的保留范围，也不改变确定性排序。

Fast review 还会读取同一 Profile 下跨原生 Session 家族、最近最多 32 条经 Client 确认的 Include/Exclude 选择。历史任务原文可以成为有界、模型可见的案例；个性化不改变候选准入或排序。确定性校准使用当前家族的聊天选择和类型化 Web 来源选择，不把其他家族中特定任务的聊天排除推广为全局风格。现有免训练策略比较来源、路径和发言者专家，对稀疏分格收缩，并尊重近期一致的更正。一份审核单的总权重为一。模型结果通过普通校验后，校准可以抑制冲突建议，或新增最多两条合格 Include 和两条 Exclude 建议，随后再次校验。显式 Plan 编辑仍具有最高优先级；先前审核的暂时排除只能通过另一次确认恢复。校准不额外调用模型，也不导入缺乏支持的 worker 或 Web 证据。没有合格反馈时保留通用建议，不从未操作、整单关闭或未标记的调用中推断偏好。

已确认的 `contextify/recommendation-reviewed` 事件会保存本次审核使用的有界目标，包括尚未形成 `user/message` 的草稿目标。个人 Context 案例使用这个准确目标，不再把选择误配到更早发送的轮次。已确认的 `contextify/route-choice` 同样保存其审核过的草稿目标。未审核或仅关闭的建议不会将目标持久化为偏好证据。缺少目标字段的旧审核事件仍可读取，并沿用最近一条已记录用户消息作为兼容回退。

个人偏好策略现在还记录已确认 Chat 来源的发言者是用户还是助手。如果两者呈现不同的 Include/Exclude 习惯，策略可以选择按发言者校准；有足够证据的类型化习惯优先于冲突的宽泛词面残差。这只改变待审建议。Fast 候选路由仍可能漏掉远距且词面不相似的消息，因此当前策略不能管理长对话中的每条旧来源。

用户通过标记为 Client 的建议审核接受的 Exclude 会留在 Plan 中，直到下一次确认修改。若当前请求再次需要该来源，Fast 会标记 `reviewableExcluded`，分类器可以建议 Include；个人偏好残差不会因为先前的暂缓选择压制这次恢复。校验器仍保护用户直接执行的 Exclude 和归档替换。恢复只是一条待审建议；用户接受后，下一轮模型请求才会带入该来源。

如果同一来源类型、Web 动作和路径位置的至少五次较早单条选择形成强偏好，随后五次独立、方向一致且相反的单条选择会让该分格的审核建议切换。更少的纠正或批量建议中的分数权重选择不会触发切换。这个有界变化检测使用户可以修正旧习惯；它不会自动编辑 Plan，也没有证明个性化效果提升。

每次提交 Plan 的 `setNodeModes` 调用都会在 plan revision 之后记录一条仅用于日志的 `contextify/node-choice` 事件。当前建议可只应用接受的条目；若全部保留当前，则消耗审核单而不增加 Plan 修订。事件记录实际选择的节点模式，并区分应用当前已审核建议与直接调用 Remote 方法；应用建议时还保留建议的选择，未改变选择的调用标为 `changed: false`。独立的 `contextify/recommendation-reviewed` 事件记录准确的建议动作及接受、拒绝的节点 ID。策略将拒绝动作保留为拒绝证据，不把它当作相反来源动作的正向编辑。如果受保护的 Apply 找不到已审核建议，就必须重新请求建议。未过期的审核面板在可见 Client 文档中渲染时，`contextify/recommendation-presented` 只记录一次准确的待审建议，不修改 Plan 或图修订；它只证明面板渲染，不证明用户读过。显式关闭该面板时，系统以待审建议的基准版本和节点动作记录 `contextify/recommendation-dismissed`，并消耗建议，但不修改 Plan；关闭时显式切换为保留当前的条目提供部分拒绝证据；不能把关闭理解成拒绝其中每个动作。取消正在运行的审核、清除错误、丢失过期建议或保持沉默都不是负选择。随包发布的 Client 会用 `uiOrigin: contextify-client` 标记其调用，使未标记的 Remote 调用可区分。该标记表示 Client 路径，不代表已认证的人类身份。

自动 Branch review 对新 Profile 默认关闭，也可以在 Prompt Dashboard 开启。禁用工具的 classifier 会从第一条 human input 到达时与主回答并发启动，仅在成功 Turn 完成后绑定准确的最终 Q&A，因此主回答不会等待它。它的有界 packet 只包含新 input、当前与祖先 objective、最多三个本地最近 Turn、branch 深度／负载以及最多四个 sibling intent；不会包含完整 tree、reasoning 或 tool event。动态高置信度阈值会压制通用建议的噪声；格式错误、调用失败、关闭或已过期的 review 保持静默。若用户在相近深度多次选择 Move，或多次把相近请求移入新分支，通用 Keep 可变成待确认建议；若用户在相近深度多次选择 Keep，通用 Move 可被抑制。风格路径至少需要五次已审核选择，不覆盖极端高置信度判断。可选的 `@deepseek-ai/dsh-contextify/branch-tool` consumer 只在挂载它并设置 `enabled: true`（默认值）的 preset 内提供 `request_context_branch`。随包发布的 standard、cordis 和 PTC preset 会挂载该 consumer，minimal 不会。Host 未挂载 Contextify 时，consumer 不注册工具；仅安装 Host service 也不会增加全局工具。即使关闭自动 review，已启用的 preset 内模型仍可使用该工具：direct human 显式要求开分支时，它会安排同一张 Turn 后确认卡，并且不会声称分支已经创建。接受可见建议时，系统先通过 Harness Host 原生的 before-Turn fork 路径，在该轮之前的平衡边界创建完整且由 Agent 支撑的 child，再把准确 Q&A 回放到 child，并用确定性 placeholder 归档源 input 与最终 output。裸的 live Session 会被拒绝，从而避免普通导航与 persistence resume 竞态。搬迁具有确定性 key，可安全重试；若任一 conversation 已推进，或原生 child 与建议边界不匹配，则拒绝执行。

问答对搬迁要求已完成轮次中恰好有一条追加的直接用户消息。含额外用户纠正的轮次不参与搬迁，避免丢失纠正内容。普通原生 fork 仍保留完整前缀。

用户明确点击 Keep 或成功执行 Move 后，源 Session 会追加一条 `contextify/branch-choice` 事件，关联原建议和已完成的 Turn。随包发布的 Client 会用 `uiOrigin: contextify-client` 标记其调用；直接调用 Remote 时若调用者不声明相同来源，就不会带此标记。重复操作不会产生重复选择；Client 重载后，已决定的建议不会重新显示。仅生成建议不代表用户做了选择。

后续自动 Branch review 会利用同一 Profile 下跨原生家族、按事件时间排序的最近 32 条 Client 声明 Keep/Move 选择校准置信度阈值。调整会对相近的输入措辞与 branch 深度给予更高权重，让明确 Keep 与 Move 对称生效；反馈较少时向通用阈值收缩，并把双向调整限制在五个置信度百分点内。Keep 提高阈值，Move 降低阈值。至少五次相近深度的已审核选择可触发按 Beta 先验平滑的风格路径：以 Keep 为主时抑制非极端置信度的通用 Move，以 Move 为主时可从非极端置信度的通用 Keep 提出待确认卡。多次词项相近的 Move 另有针对低置信 Keep 的路径。这些规则根据开发例调整过，尚无独立准确率保证。未标记的 Remote 选择不会训练该策略。个性化只改变是否显示建议，未经确认不会创建 branch，目前也没有准确率改善的实测保证。

三类 review Agent 都使用 Profile 所有的设置。Package 默认 prompt 是只读基线；用户通常只追加自定义规则，也可以显式解锁完整 override。Context selection 指引用于 Fast，Archive 指引用于 Deep，Branch 指引用于轮后审核；三者都继续使用 parent Agent 的 Harness provider/model route。

Package 还导出供研究集成使用的可选 revision-lineage compiler，以及追加式 delegation-slice/request-read-set 辅助函数。`startSourceBoundContinuable` 从已选中的人类 Session 文本消息、原生 Web 工具结果或 Contextify Web recall snapshot 构造 child 的委托 prompt。它会校验原生 Web 结果对应的调用事件，以及导入 snapshot 的来源、recall 形式与内容哈希，在启动前记录当前 Session 中选中的来源事件，并禁用全局工具。当前 Plan 移除导入的 snapshot 后，依赖它的 child 会失效；原兄弟 Session 后续发生的编辑不会跨 Session 追踪。直接使用这些辅助函数时，调用方必须选用 lineage compiler，并在每次 parent 请求发送前记录依赖；即使一个 step 没有新接纳的消息也要记录。Compiler 会拒绝所记录 parent 来源（包括传递性的 checkpoint 来源）被当前计划否决的过期 child 消息，并递归移除依赖这些来源的历史 child 消息与 parent 回答。`guardDelegatedToolCalls` 可在指定 child 的来源片段失效后拒绝它的所有后续工具调用；ToolRuntime 会在异步分发包装器之后、工具函数体开始时复检。其他插件仍可把输入注入 child 请求；纯合成的工作区指令测试已经证明这一缺口。辅助函数不观测这种环境输入、作用域工具或外部读取，已发布 profile 也未安装这个可选 runtime，因此当前原型没有完整来源保证，也不能保护已经开始的副作用在提交时仍有效。Contextify 还会拒绝 parent Agent 正在运行时的编辑，所以它不支持撤销运行中 parent 已生成的输出。

需要可复用的可选路径时，在 ContextifyService 后安装 `@deepseek-ai/dsh-contextify/revision-lineage-runtime`。它在新 Contextify Session 的第一次模型请求前选择 lineage compiler，在每个 pre-step 过滤过期 child 消息并记录请求 read set，还为每个 Session 在内存中保留最多 64 条被拒消息供检查。已有 assistant 历史但缺少读集的旧 Session 保留其当前 surface 或 Contextify compiler，不会获得 lineage 保护或伪造读集。该 runtime 提供 `list_context_sources`，对当前选中的纯文本 human 或 Web 来源分页展示，每页最多 16 条短预览；`delegate_context_sources` 在启动无工具 child 前重新校验一至八个所选事件序号并记录来源切片。受保护 Session 中，普通 `subagent*` 和 `send_message` 工具调用会被拒绝，因为它们缺少或可能改变这个来源切片；旧 Session 保留这些工具。30 例原生 fork 回放和无密钥 Loader 组合 Web 测试覆盖来源绑定 child；已发布 profile 在第一次 Context 编辑前保留 surface 选择，之后使用普通 Contextify；只有安装该可选 runtime 才使用 lineage compiler。

原生来源追踪还会检查所引用 assistant 回答及失败尝试的已记录读集，以及所引用 worker 报告的来源切片。摘要不能仅因只引用回答或报告，就保留已经失效的祖先。隐藏的消息祖先只有通过当前仍选中、有效且记录了来源的压缩记录才可被接纳。单调不动点检查会撤销无效 checkpoint 的来源授权，包括被当前轮保护保留的 checkpoint；追踪在已排除的祖先处停止。排除 checkpoint 或移除完整工具组后，其他摘要不能重新引入其隐藏消息。释放导入的 compiler snapshot 仍会使其后代失效。这些检查依赖已记录的依赖关系，不会从任意摘要文本中推断来源。

Fast 默认使用当前聊天模型。将 `fastDecisionProvider` 设为 `jev` 会选择 Host 侧 Jev 1.13.0 适配器；Host 通过托管凭据或启动环境解析 `TYPESAFE_API_KEY`。独立的任务匹配判断比较当前任务与原生目标，另一个新任务判断和父任务 Choice 区分继续任务与创建其子任务。每张任务卡从任务入口、与草稿相关的原文和最近原文抽取至多四段，不依赖逐节点选材候选。清晰分数提出待审核路由，含糊分数保留当前任务。明确的完整任务及祖先保留策略使用原生图成员关系，而非逐句回答相关性；人工约束和目标校验仍有效。如果原生路由拒绝或覆盖评分目标，来自该目标的范围修改会被丢弃。历史 Branch、Navigate 和 Return 案例保留审核目标及操作前的任务原文。适配器记录不含凭据的准确请求，限制为 128 KiB，超时为 20 秒，不自动重试或回退。原生校验、修订检查和显式审核控制每项操作。

主动选择 `goal-model-jev` 后，精确绑定未发送草稿的检查会分开判断目标归属与 Jev Context。当前聊天模型接收原生任务证据和已确认的管理案例，仅返回目标、new/existing/unknown 归属与合法 Session ID；Host 保留原始证据。Unknown 跳过 Jev 和推断式 Context 校准。其他情况下，Host 将已校验的目标、新任务父节点或已有任务目标作为引用数据传给 Jev。消息归属、证据与替代判断以该任务为依据，不再各自从草稿猜测；仅选定目标不意味着保留其全部历史或祖先。每个来源问题还引用原生 owner 及其与已分配 Session 的关系（已有任务、新任务父节点、其他 owner 或未知）；继承和借用的来源仍可选择，归属不强制决定消息选择。Jev 提供这些来源判断，明确要求整任务范围时由原生图策略编译。每次使用一次聊天模型和至多一次 Jev 调用，先检查必需凭据，整体可取消且限时 45 秒，不重试或回退。结果仍需审核，不证明准确率或个性化提升。此模式下非草稿 Fast 检查仅使用 Jev；默认仍为 `parent-model`。

用户明确选择与 Navigate 或 Return 一起携带 Context 后，完整批准的来源 ID 集合经目标校验和一次 Plan 提交完成重基，无需再次推理。手动设置冲突或任一 Plan 中选中来源被替换时会拒绝操作，不静默放宽集合；目标批准记录保留原 `sourceBase`。Branch 可以指定另一个原生父节点。确定性路由规划器将导航、原生 fork 和 Context 应用组织成有依赖顺序的操作 DAG，Session 祖先结构仍为树。新子分支和 Jev 具体目标的 Context 以目标节点的 Plan 为基础，再应用审核过的归属选择与源 Plan 的明确 Include/Exclude，不默认复制旧分支的 Natural 历史；审核单单独展示该集合。Host 校验原生父节点元数据和未变化的原家族。重新激活可替换已接受路由的旧审核，尚未决定的目标审核仍阻止携带。自动轮后 Branch 检查与 Deep 保持各自的模型路径。 目标存在替换内容时禁用 Context 携带，但仍保留仅移动草稿的路由。

`personalizationEnabled` 默认为 true。关闭后，新检查不使用历史案例、个人校准或已学习的路由阈值，但保留手动 Context 选择。其他家族中针对具体任务的聊天编辑作为有界案例迁移，不直接成为全局风格规则；确定性校准使用当前家族的编辑和已记录的 Web 来源习惯。每个建议分别展示模型收到的选择案例、校准来源记录和阈值来源记录。历史案例文本只进入管理决策，不进入回答 Context。设置变化或策略重置会取消可能持有旧证据的运行中检查。

<a id="model-experience"></a>
## 模型体验

### 编译后的 Context Plan

#### 模型看到的内容

Harness 原始 transcript 仍然是 append-only。Contextify 按现有顺序选择 active-family 消息、移除显式 exclusion、替换已确认的 placeholder snapshot、从持久 `context/compiler-snapshot` event 读取已 include 的 sibling 消息，并恢复当前 turn 的消息，因此旧 plan 无法隐藏正在回答的请求。

#### Token 影响

Compiler 不添加任何提示词文本。Exclude 可以减少对话历史的 input token；引入 sibling 会按所选 snapshot 内容增加 token。展开 checkpoint 可能让编译后的输入超过物理 Session surface 的 token 估计；`compaction-basic` 只计量物理 surface，其自动压力判断不会计入这部分差异。可选 lineage runtime 会在模型请求中加入两个原生工具 schema。列举来源每页至多返回 16 条、每条 180 个 Unicode 码位的预览；来源绑定 child 的初始 prompt 包含所选来源的完整文本，因此委托可能增加 child 输入 token。

#### KV Cache 影响

只要更改了更早的选中消息前缀，KV cache 就可能从第一条变化消息开始失去复用。所有节点保持 Natural 时，普通 Session 消息顺序不变。启用 lineage runtime 或编辑旧 Plan 都可能改变请求前缀，降低 cache 复用。


## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- Web surface 有订阅者时每 1.5 秒轮询 family；后续可改为专用 projection event。
- 启用 Branch review 后，每个 eligible Turn 最多增加一次很小的辅助模型调用；希望完全没有后台分类的用户可以按 Profile 关闭。
- 跨 Map import 暂缓；目前只能引用连接到同一原生 root 的 Session。
- Contextify placeholder 是原节点的 overlay；其他 compaction relationship 尚未展开成 shadow node。
- 可选来源绑定 worker 仅限制初始委托文本并且不授予全局工具；其环境 prompt、直接追加 child 输入的服务调用、外部读取，以及编辑前已开始的副作用不在记录切片的保证范围内。被隔离消息只保存在内存中，尚无持久的用户可见收件箱。
- 在 compiler、Remote、replay 与 UI seam 稳定前，package 继续保留在本 Harness fork 中。

<a id="dev-note"></a>
### 开发备注

不发布不变量伴随插件，因为 Agent Loop 伴随插件检查编译后的请求，而本插件没有独立的运行时不变量。

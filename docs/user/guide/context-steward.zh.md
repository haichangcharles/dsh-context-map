# 用 Context Steward 管理长对话

[English](context-steward.md) | 中文

## 概述

Context Steward 让规划、查证、写作和头脑风暴保留在同一个可检查的对话家族中。你可以决定下一轮在哪个分支进行，以及请求使用哪些旧材料。明确审核的选择可以指导后续建议；原生对话仍是证据记录。

## 目录

- [启动工作区](#start-a-workspace)
- [选择上下文与目标分支](#choose-context-and-a-destination)
- [审核 Agent 建议](#review-agent-advice)
- [管理任务与偏好](#manage-work-and-preferences)
- [保留管理记录](#keep-a-management-record)
- [无需 API 的验证](#verify-without-an-api)

<a id="start-a-workspace"></a>
## 启动工作区

按照[源码安装说明](../../../README.zh.md#run-from-source)操作，然后[选择工作区并配置模型](index.zh.md)。Context Steward 在内置 `web` profile 中运行。用已有 Session 数据试验 runtime 升级时，请设置独立的 `DSH_HOME`；[迁移限制](../../../README.zh.md#existing-session-data)仍然适用。

在 Chat 旁边打开 Context Map。每个分支都是 Harness 原生 Session。共享的继承消息只显示一次，每个来源保留原始拥有者。当前 Session 有自己的 Context Plan。

<a id="choose-context-and-a-destination"></a>
## 选择上下文与目标分支

**Natural** 使用当前 Session 路径上的消息。**Exclude** 跳过指定路径消息。**Include** 借用另一分支中受支持的来源。把导入来源恢复为 Natural，可以停止在当前请求中使用它，同时保留原始来源。需要时可以再次 Include。

例如，在一个分支查证发布日期，在另一个分支撰写社区网站页面。写作时 Include 日期证据；构思无关措辞时恢复为 Natural；最终事实核查时再 Include。这些操作管理每一轮请求的选材，不代表删除或完成任务。

用 **Branch** 开始独立任务。用 **Move draft here** 把尚未发送的草稿原样转移到已有分支；草稿已经改变或目标分支已有草稿时，操作会拒绝。该控件要求有非空的未发送草稿。**Locate** 只查看消息，不提供偏好标签。路由建议可以单独提出 Navigate 到已有分支，或沿原生继承关系 Return。

如果你在回答过程中追加了纠正内容，系统不会建议搬迁该轮的问答对，因为只搬问题和回答会漏掉你的纠正。原生 Branch 和 Branch from here 仍会保留完整对话前缀。

<a id="review-agent-advice"></a>
## 审核 Agent 建议

| 模式 | 用途 | 额外模型请求 |
| --- | --- | --- |
| Local | 图约束、明确路由提示与已确认选择建议 | 零次；默认模式 |
| Fast | 有界的语义来源与目标分支审核 | 显式选择时一次无工具请求；可选目标模型加 Jev 至多两次 |
| Deep | 主动检查隔离的完整树快照 | 显式 DSH 审核；默认 3 次请求，可配置 1–10 次，45 秒超时 |

发送前审核草稿，或打开 Map 审核菜单。建议本身不会发送草稿、创建分支或修改 Context Plan。目标分支相关性和证据相关性分别判断：查证分支可以提供有用证据，而对话仍在写作分支继续。目标不明确时保留当前分支。Local 使用明确提示、词法匹配和已确认选择，不能证明一般语义理解。Deep 的请求上限包含重试，每次请求最多输出 1,200 tokens。

只接受有用的项目。**Keep current** 明确拒绝该项建议的操作；未决定的项目不构成反馈。关闭审核单会记录已经选定的拒绝，但不改变上下文。Apply 以一次修订改变已审核的选材；Undo 撤去相应学习证据。草稿、图或 Plan 改变后，旧建议失效，需要重新审核。

在 Prompt Dashboard 中可以主动开启每轮结束后的 Branch 分类。开启后，每个符合条件的轮次可能额外产生一次请求。即使后台分类关闭，主 Agent 明确请求 Branch 时仍会产生确认卡。

<a id="manage-work-and-preferences"></a>
## 管理任务与偏好

Park、Complete 和 Reopen 描述分支的任务生命周期。它们不会删除证据或改变上下文选择。已完成分支仍可提供证据，也可以明确 Resume。之后该分支出现人工新轮次时会重新打开。任务状态建议与 Include、Exclude 和 Archive 分别审核。Local 要求明确的 Park、Complete 或 Reopen 提示；Fast 和 Deep 最多提出一项图上合法的修改。明确草稿提示优先于模型建议。

Preferences 视图汇总同一 Profile 内不同原生 Session 家族中反复确认的 Context 选择。证据足够时，建议以活动、来源类型和分支关系为条件。选择稀少时保留保守默认值。近期证据标明来源 Session 事件；被动浏览、未答复的卡片和未标记的 Remote 调用不会训练 profile。

重置学习利用已记录的 Session 水位清空派生偏好投影。对话、原始选择记录和当前 Context Plan 会保留。之后的明确选择可以积累新证据。这种 policy memory 描述上下文管理习惯，不是一般人格或个人事实。

在 Context Map 提示词设置中，快速 Context 决策模型可选择当前聊天模型、Jev、目标模型＋Jev Context 或目标模型＋完整任务 Context。Jev 需要 Host 配置 `TYPESAFE_API_KEY`，调用可能收费；仅切换选项不会发出请求。“参考已确认的 Context 选择”控制后续检查使用的历史案例与个人校准。展开审核表可分别查看模型案例和校准记录。策略重置或设置变化会取消持有旧证据的运行中检查。

目标模型＋Jev Context 先识别精确草稿的任务及要求保留的历史。你可以要求只保留该任务自己的消息，或同时保留其祖先任务；新任务自身的历史从空集开始。要求保留范围时，Jev 只审核明确要求的来源例外：不能仅因相关性低就丢弃已要求保留的消息，也不能仅因相关就从其他任务借用来源。普通确认单会在任何变更前显示建议选材。

审核显示 **仅保留本任务** 或 **保留本任务及父级任务** 时，完整同意实际改变的范围可为后续建议保留整次选择的样例。保持任一条目不变只记录局部反馈。Undo 会移除完整策略样例，Redo 会恢复，重置学习会将其从后续审核中排除。空范围、无变化选择与含来源例外的建议不产生这类样例。显示的选择不代表对你一般人格的判断。

任务、保留要求或必需的祖先信息不明确时，不调用 Jev，也不生成组合式自动建议；手动选择仍然可用。任务目标或新建／已有选择存在冲突时同样如此。没有要求保留范围的草稿仍可使用相关性审核。草稿检查使用一次聊天模型及至多一次 Jev 调用；非草稿 Fast 检查只使用 Jev。Host 在首次调用前检查凭据，组合检查限时 45 秒。此模式为可选项，不代表已证明准确率提升。

目标模型＋完整任务 Context 至多调用一次聊天模型，不调用 Jev，也不需要 Jev 凭据。需要保留完整任务或原始祖先链且没有来源例外时，可选择此模式；逐条选择来源请使用其他决策模型。新任务自有分支从空历史 Context 开始。任务或策略不明确，以及手动选择、替换或路由冲突时会弃权。只有精确草稿可提出切换目标；否则仅审核当前任务。每项变更仍需你批准。聊天模型可能收费；此选项保证相对于已校验归属的范围，不保证模型选对了任务。

打开 **Context 偏好 → 已确认的完整策略样例**，查看最近四条有效历史模式、任务及原始事件引用。审核可以改用更早的相关案例，因此记录的样例可能与此近期列表不同。这些选择可供已启用的个性化审核参考，不授权当前更改。Context Undo/Redo 后请刷新；重置已学习的偏好会刷新列表并保留 Context Plan。

<a id="keep-a-management-record"></a>
## 保留管理记录

暂停操作，选择对话家族中已知的最上级 Session，再使用顶部菜单的 **Download session log** 或 `/export`。[既有日志导出器](../../../packages/session-query/session-log-export/README.zh.md)会包含该 Session 及其已知后代。只导出子分支会遗漏祖先和兄弟分支。各 Session 依次读取，因此归档不是整个家族的原子快照。

归档包含原始对话、已记录的请求、管理选择、工作区路径及引用附件，并未匿名化。请留在本地检查后再分享。Undo 与重置学习保留旧选择的原始记录，同时改变它们能否用于后续建议。若重置记录在其他家族，完整恢复 Profile 还需要那个家族的日志。各 Session 的序号和明确来源引用保留顺序；仅靠时间戳不能确定所有分支的全局先后。Client 声明的显示或确认不证明真人身份或注意力，导出也不包含每项临时审核细节。

使用同一导出读取器、官方解码器和原生 Context 编译器验证所选 fixture 日志：

```sh
pnpm exec vitest run scripts/context-steward-export.spec.ts --maxWorkers=1
```

这项隔离工程检查在恢复后保留确认事件引用，并检查 Undo、Redo 和 Reset。它不会读取你已保存的对话，也不评估模型质量或真实用户偏好。

<a id="verify-without-an-api"></a>
## 无需 API 的验证

按[源码安装](../../../README.zh.md#run-from-source)完成 `pnpm run build` 后，在仓库根目录运行以下原生工作流检查；无需配置模型或打开浏览器：

```sh
pnpm exec vitest run packages/context/contextify/tests/route-scope.spec.ts packages/context/contextify/tests/scope-policy-runtime.spec.ts --maxWorkers=2
```

两组测试在隔离临时目录中调用实际 Session、Contextify 和 Context Plan 服务，模型及 Jev 响应由工程 fixture（测试前置数据）提供。它们检查：

1. 在指定父级下 Branch，Return 时不携带子任务 Context，之后导航回该任务并重新激活其 Context。
2. 完整确认实际改变的 Context、原事件引用，以及下一次 Host 目标输入中的对应样例。范围未变时不产生完整策略样例。
3. 在新服务实例中从 JSONL 恢复，Undo／Redo，以及再次冷启动后仍然生效的重置学习。

两个测试文件都应通过。这些是隔离工程场景，不是同一段连续用户会话或语义准确率评测；它们不会修改你保存的对话。

要检查构造的 30 轮 fixture 与分离的预期结果，可以导出仅含当前前缀的数据包：

```sh
node --import tsx/esm scripts/context-steward-replay.ts /tmp/context-steward-replay
pnpm exec vitest run scripts/context-steward-replay.spec.ts
```

命令生成 `.visible.json`、`.gold.json` 和 `.summary.json`。每个可见数据包只包含当前决策前已有的图与确认选择。预期结果和受控 scorer 输出不进入该数据包。`actionPacket` 字段是产品实际使用的有界 scorer 输入；外围完整 fixture 图用于调试，不是额外模型请求。回放无需调用 provider，即可检查原生 fork 身份、完成后的证据、重入与路由约束。它是工程示例，不是真实用户偏好数据集或语义准确率 benchmark。

构建 Client 后，组装后的浏览器验收用无需密钥的响应回放检查真实 UI 与编译请求：

```sh
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-long-horizon.e2e.ts
```

Compiler、来源约束 worker 和修订限制见 [Contextify 包](../../../packages/context/contextify/README.zh.md)，集成细节见 [UI 包](../../../packages/client/ui-contextify/README.zh.md)。

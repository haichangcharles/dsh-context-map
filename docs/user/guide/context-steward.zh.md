# 用 Context Steward 管理长对话

[English](context-steward.md) | 中文

## 概述

Context Steward 让规划、查证、写作和头脑风暴保留在同一个可检查的对话家族中。你可以决定下一轮在哪个分支进行，以及请求使用哪些旧材料。明确审核的选择可以指导后续建议；原生对话仍是证据记录。

## 目录

- [启动工作区](#start-a-workspace)
- [选择上下文与目标分支](#choose-context-and-a-destination)
- [审核 Agent 建议](#review-agent-advice)
- [管理任务与偏好](#manage-work-and-preferences)
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

在 Context Map 提示词设置中，快速 Context 决策模型可选择当前聊天模型、Jev 或目标模型＋Jev Context。Jev 需要 Host 配置 `TYPESAFE_API_KEY`，调用可能收费；仅切换选项不会发出请求。“参考已确认的 Context 选择”控制后续检查使用的历史案例与个人校准。展开审核表可分别查看模型案例和校准记录。策略重置或设置变化会取消持有旧证据的运行中检查。

目标模型＋Jev Context 先识别精确草稿的任务及要求保留的历史。你可以要求只保留该任务自己的消息，或同时保留其祖先任务；新任务自身的历史从空集开始。要求保留范围时，Jev 只审核明确要求的来源例外：不能仅因相关性低就丢弃已要求保留的消息，也不能仅因相关就从其他任务借用来源。普通确认单会在任何变更前显示建议选材。

任务、保留要求或必需的祖先信息不明确时，不调用 Jev，也不生成组合式自动建议；手动选择仍然可用。任务目标或新建／已有选择存在冲突时同样如此。没有要求保留范围的草稿仍可使用相关性审核。草稿检查使用一次聊天模型及至多一次 Jev 调用；非草稿 Fast 检查只使用 Jev。Host 在首次调用前检查凭据，组合检查限时 45 秒。此模式为可选项，不代表已证明准确率提升。

<a id="verify-without-an-api"></a>
## 无需 API 的验证

在仓库根目录使用受支持的 Node.js，并安装依赖后，导出构造的 30 轮 fixture（测试前置数据）与分离的预期结果：

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

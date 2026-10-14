# Agent Note：跨 Context 分支导入绑定来源的 Web 证据

Status: implemented

[English](2026-10-10-source-bound-web-import.md) | 中文

## Problem

兄弟 Session 发现的 Web 观察可以出现在 Context Map 中，却不在活动模型请求里。单独复制它的 `tool/result` 会丢失供应商工具协议所需的前置调用。完全拒绝这类 Include，又会阻止用户与个人 Context 推荐器跨分支复用网页。

## Decision

只有成功、纯文本且明确引用一条匹配的原生 `web_search` 或 `web_fetch` `tool/call` 事件时，family graph 才把 Web 结果标为可导入。同一 family 的 Include 再次校验该关系，然后写入 `context/compiler-snapshot`；其中的 user message 采用 `recall` 来源形式，记录 Web 动作、原调用参数，并把观察结果标为不可信引用数据。Snapshot 的 provenance 保留原 Session 和结果序号。当前 Plan 只在节点的稳定插入位置选择一次 snapshot；Natural、Undo 和 Reset 移除它，不修改原 Session。异常或未绑定来源的结果既不能产生 snapshot，也不能推进 Plan。

Fast 推荐、普通推荐校验和 Context Map checkbox 只接纳带可导入动作的跨分支 Web 节点。个人来源匹配会区分 `web_search` 与 `web_fetch`；跨分支 worker 回报仍不可用。直接恢复到 Natural 时，活动路径材料被记录为正向反馈，跨分支材料被记录为负向反馈。

可选的 source-bound 委托辅助函数也能把当前已选中的导入 Web snapshot 渲染进 worker prompt。它校验 recall 消息只有文本、来自 Contextify 且内容哈希仍与记录一致，再把当前 Session 的 snapshot 序号记为 worker 的依赖。活动 Plan 移除该 snapshot 后，既有 lineage 校验会拒绝这个 worker。

## Alternatives considered

- **只复制原始工具结果** — 拒绝，因为模型请求缺少 assistant 工具调用，可能违反供应商协议。
- **复制原始 assistant step 的全部消息** — 拒绝，因为一步可能含有多个调用及无关结果，导入它们会改变用户选择的证据集合。
- **继续禁用全部兄弟分支 Web 结果** — 拒绝，因为这让核心的分支复用动作无法由 Context Plan 执行。

## Consequences

证据 capsule 为显式跨分支复用保留来源身份与工具上下文，但它是渲染后的数据消息，不是原生工具交换的重放。它不能防御恶意网页文本中的指令，也不证明另一条 Plan 仍选中原兄弟 Session。选择和 worker 读集校验基于活动 Session 的复制 snapshot；当前 Plan 移除 snapshot 后，后续编译请求不再包含它，依赖它而委托的 worker 也会失效。原生 Session 定向测试覆盖导入、worker 依赖与撤销、Undo、重复 Include、缺失调用来源及客户端可用性。另一个真实 child 回放使用受控的原生 `web_fetch`，验证撤销兄弟分支 Web snapshot 后，依赖它的迟到报告进入隔离区且不再出现在下一次 parent 模型请求。要宣称端到端用户收益，仍需完整的自然 Web 任务评测。

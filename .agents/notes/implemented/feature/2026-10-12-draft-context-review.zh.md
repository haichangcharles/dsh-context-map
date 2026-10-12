# Agent Note: 草稿绑定的 Context 审阅

Status: implemented

[English](2026-10-12-draft-context-review.md) | 中文

## Problem

如果只在模型回复之后审阅 Context，就无法阻止下一次请求读取无关或已被更正的历史。若审阅当前 Session 时又不提供尚未发送的草稿，系统也难以判断下一个答案需要哪个旧分支的证据。

## Decision

Contextify Client 在草稿非空时于 composer 上方加入明确的审阅入口。点击后，客户端通过 DSH Remote 将草稿作为目标交给已有的有界 Fast Contextify 审阅，并在审阅成功后打开 Context Map。草稿保留在 composer 中；Agent 不会把它当成用户消息。异步调用结束后，客户端比较编辑器修订号和文本，清除针对旧草稿的建议。现有 Context Plan 审阅仍是应用建议的唯一途径。

用户输入时，该入口不会自动调用模型。它复用 DSH Agent 和原生 Session 家族，不增加浏览器侧模型路由。Fast 审阅现在可针对明确的 Return、继续旧分支或新话题，另外给出保守的 Session 路由卡。路由策略读取同一份冻结图与已审阅草稿，不增加第二次模型调用。模糊请求和短纠错仍留在当前 Session；Turn 完成后的 Branch 审阅也继续存在。

Context Map 中手动执行的 Branch from Here 会先创建原生 fork，再通过 `ctx.conversation.moveDraft` 转移草稿，然后才切换 Session。Conversation 服务会核对来源文字与编辑器 revision，要求目标输入框为空，并转移附件和重新绑定文件上传。核对失败时仍选中来源 Session，因此异步 fork 不会把已修改的草稿悄悄留在旧分支。成功转移后，客户端记录一条 `contextify/manual-branch` 事件，作为明确的正向 Branch 策略证据。完整 Web 回放验证了草稿交接与事件写入。

Completed Turn 的 Branch 建议也会在打开搬迁后的 child Session 前使用同一草稿交接。上一轮 Q&A 的搬迁与下一轮尚未发送的草稿保持分离；接受搬迁不会发送或重写下一条消息。

接受草稿路由前，客户端会重新核对图与 Plan 修订、准确草稿和目标 Session，然后转移输入框文字与附件；成功转移后才切换原生 Session。拒绝卡片会留在当前 Session。`contextify/route-choice` 事件只记录明确的接受或拒绝，`stewardProfile` 因此可以从这些事件学习 Navigate、Return 和 Branch 偏好，并聚合同一 DSH Profile 下多个 Session 的确认选择。语义路由打分尚未发布。

## Alternatives considered

**拦截每次发送并强制审阅 Context。** 这会让所有轮次（包括简短纠错）增加延迟和模型费用，而且现有 composer 的发送模式与队列消息语义不同，因此没有采用。

**每次修改草稿都运行审阅。** 输入过程会产生大量过期的模型调用，费用也难以预测，因此没有采用。

**由浏览器自行给 Context 候选打分。** DSH 负责模型路由、Session 来源和 Context Plan 校验，因此没有采用。

## Consequences

用户可以在下次回复前检查和修正 Context，也可以接受一条明确的 Session 路由，而不用发送草稿。明确点击可限制 API 开支。路由建议仍是保守的词项后备方案，并未证明准确率提升；Release 自动化和留出集偏好评测仍需独立完成。

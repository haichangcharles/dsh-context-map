# Agent Note：可选的 revision-lineage runtime

Status: implemented

[English](2026-10-10-opt-in-revision-lineage-runtime.md) | 中文

## Problem

Contextify 已导出 lineage compiler 和 request-read-set 辅助函数，但研究回放仍手写 pre-step 拦截。因此请求一致性的主张依赖测试接线，而非可复用的 Harness 组件。若不检查就升级已有 Session，还可能移除那些从未记录 read set 的旧 assistant 消息。

## Decision

`ContextifyRevisionLineageRuntime` 是在 ContextifyService 之后安装的可选 Service。它在 Contextify Session 首次 pre-step 时，仅当既有 assistant step 都有 read set 才选择有版本的 lineage compiler。已有答案但没有读集的旧 Session 继续使用普通 Contextify，不会凭空获得追溯保护声明或部分读集。在每个受保护的 step，runtime 按当前 Plan 过滤委托来源已失效的 child 消息，在 provider 请求前记录准确的已接纳消息与选中历史，并为每个 Session 在内存中保留最多 64 条被拒消息以供检查。Session 释放时清空该内存。已发布 profile 默认不安装这个 runtime。

可选 runtime 还注册两个模型可用工具。`list_context_sources` 每页列出最多 16 条当前选中的纯文本人类消息、原生 Web 结果或导入的 Web recall，并限制预览长度。`delegate_context_sources` 接受一到八个事件序号，再次按当前 Plan 校验、记录来源切片，并启动禁用全局工具的 spawn child。在受保护的父 Session 中，guard 拒绝可能引入未绑定 child 输入的普通 `subagent*` 与 `send_message` 工具调用；旧 Session 保留普通工具行为。单独导出的 runtime 入口允许 Web profile patch 安装这条路径，不改变默认 profile。

原生来源引用会经过结构事件递归校验 assistant 读集（包括失败尝试）与 worker 委托切片。顶层选择和祖先有效性分开：隐藏的消息依赖需要当前仍选中、有效的压缩记录及其已记录来源，追踪在被明确否决的祖先处停止。单调剔除会撤销无效 checkpoint 的隐藏来源授权，即使当前轮保护将其保留在基础选择中。排除 checkpoint 或工具组不能再为其隐藏消息提供接纳依据。明确排除、被替换的原文和已释放的 compiler snapshot 会使派生内容失效。失效回答或报告的摘要会被移除，独立证据仍然可用。重新启用来源会恢复有效后代。跨越读集与原生引用的循环会被拒绝。

## Alternatives considered

- **继续让各回放分别接线**——核心保证仍停留在测试代码中。
- **在 ContextifyService 中无条件启用 lineage**——会改变已有 Session 的语义，并可能静默删掉缺少 read set 的 assistant 历史。
- **在无 read set 的情况下接纳旧 assistant 历史**——会声称并未观察到的来源关系。
- **在启动后从自由文本 worker prompt 推断来源**——无法可靠识别它混入了哪些已选 Web 或人类材料；受保护路径改从选中的事件直接构造 child 输入。
- **要求每个祖先始终可见**——合法压缩会隐藏原始消息，因此会错误拒绝仍有效的回答。递归依赖校验保留这些内容，同时执行明确撤销与 snapshot 释放。

## Consequences

原生兄弟分支 Web worker 测试现在使用该 Service，并在隔离区观察到被拒的迟到报告。在相同的 30 个 TopiOCQA 封存 fork 案例中，Service 复现了原手写 hook 实验的全部可见性和请求数；独立的 A worker 在 30/30 例中保留。Service 仍只能观察已记录输入，不能回滚已启动的副作用，不持久化或自动重放隔离消息，也未安装到已发布 profile。

真实 Agent Loop 的渐进接入测试先在未安装 runtime 时启动旧 Session，再安装并续聊，确认它继续使用普通 Contextify、没有伪造读集；安装后新建的 Session 在第一次 provider 请求前选用 lineage 并记录读集。普通 `tool-subagent` 回报仍没有来源绑定，会被受保护路径拒绝；默认 Web profile 仍未安装这个 runtime。

来源绑定工具入口现已实现，并在无密钥的真实 Loader Web 组合中验证：工具 schema 进入父 agent 的模型请求；A、B worker 同时运行时，排除 Web 来源 B 会让它从来源列表消失、拒绝新的 B 委托，保留后来返回的 A 报告，同时从下一次父请求中排除 B 报告。这不能证明 child 的完整输入来源：环境提示词、绕过工具的服务调用对 child 的追加消息、外部读取以及已启动的副作用仍不在所记录切片内。默认 Web profile 暂不改变，直到这些路径与旧会话重启行为获得产品级覆盖。

手工编写的 `contextify-lineage-provenance` 会话快照通过已发布 headless profile 和 Contextify 公开 package 入口，在源码及构建模式下启动。测试专用工具记录固定来源、委托切片、合成 worker 报告、其摘要以及完整压缩生命周期。下一次组装出的模型请求保留有效 checkpoint 和当前输入，同时排除被撤销的来源及派生载体。负对照在请求断言处拒绝原始 compiler；恢复修复后，无密钥回放通过。该 fixture 不启动 worker，也不测量模型质量。

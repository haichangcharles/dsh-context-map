# Agent Note：Context 快照发布就绪条件

Status: implemented

[English](2026-10-14-context-snapshot-publication-readiness.md) | 中文

## Problem

模型轮次完成并呈现在 Chat 后，异步 Context graph 轮询才会发布全部原生消息操作。此前部分浏览器基准只截到了用户控件；CI 随后看到合法的助手控件，因而比较失败。在收起 Map 后等待，还会让指针停留在开关上并显示瞬态提示。

官方品牌 SVG 位于可访问的 **New session** 按钮内，其装饰性祖先标记了 `aria-hidden`。默认的可访问角色查询无法找到这个装饰图像。

## Decision

公开的[浏览器辅助函数](../../../../apps/web/tests/support.ts) `waitForMessageContextControls` 根据场景明确的原生消息数量，等待每条消息的四个 Context 按钮，再截图。反馈与 skill 场景先等待发布，再收起 Map、移开指针，并确认开关提示消失。排队图片用例还会在两次恢复 Chat 宽度后移开指针，等待偶然的侧栏提示消失。该用例分别检查初始用户控件和最终五条原生消息；被中止的部分助手输出仍不进入 Context graph。

队列操作快照还会在暂停 prompt 响应前，等待已接纳的当前用户消息的 Context 控件。模型回放的 hang-ready 标志证明模型推进，并不证明 Client graph 已发布。共享页面的 draft-review 测试通过既有 `writeComposerDraft` 键盘路径（点击、编辑器所属 Select All、Backspace）清空草稿后，等待编辑器 `textContent` 为空、草稿检查按钮消失且 Send 禁用，再进入下一项对话截图；这样就不会继承尚未完成状态发布的草稿。Lexical 的空段落可能在 `innerText` 中表现为布局换行，但并无文本节点内容。Playwright 的空 fill 则选择 DOM Range 并发送 Delete；Lexical 另有编辑器 selection，只有 editor commit 才发布草稿。源码路径有差别，但 CI 的具体 selection 事件时序仍未证实。原基准刻意包含的 Copy 提示先明确悬停并等待；Queue 初始准备则将指针移离原生侧栏开关，仅等待其偶然提示消失。

Web observation 夹具先等待准确的来源 article，再读取节点标签列表。绑定 Session 不代表 Client graph 已发布；既有等待必须位于列表断言之前。

默认 Web search 快照等待已接纳用户消息的四个 Context 控件。Host 结算和搜索结果可见并不代表该发布已完成。Session 导出的几何检查等待全宽 Chat 收起动画结束，并在一次浏览器求值中读取全部三个矩形；独立协议调用可能看到不同动画帧。原有 golden 和 32 像素相邻断言保持不变。

built-boot 测试验证准确的 SVG 属性、装饰性祖先以及其所属按钮确实位于可访问的 New session 控件列表中。多个独立的 New session 按钮是合法的。基准仅加入逐项核对过的合法 Context 控件。原始 Session/model JSONL、回放请求、文件内容、图片几何、反馈释放及队列顺序断言保持不变。

SDK的手写`subagent-list-agents`轨迹同样要求子任务结算通知出现在父任务的独立下一轮。场景通过patch列表复用现有`subagent-send-message`事件屏障，防止快速子任务在父任务仍运行的启动轮内结算。此处只改变测试调度，生产continuation语义、超时和golden均不变。所属SDK语料在Node24下18项全通过，精确案例在Node22下也通过。此前远端120秒超时缺少临时日志，未确认其直接原因；此屏障消除的是另外核实可达的时序依赖。

## Alternatives considered

- **隐藏 Context 操作或过滤快照。** 这会掩盖实际产品行为。
- **把悬停提示加入基准。** 提示反映测试指针位置，并非预期的稳定对话。
- **大范围刷新模型记录。** 模型可见行为没有改变。

## Consequences

这些修改稳定了对既有产品的观察，不改变 agent 策略、模型质量或个性化行为。[已审阅操作说明](../feature/2026-10-13-context-steward-reviewed-actions.zh.md)与[浏览器回放架构](../testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)继续有效，本说明不取代它们。

## Testing

五个负责的文件共含 19 项无需密钥的测试。第一轮定向执行通过两项 built-boot 和两项 SVG 测试，同时暴露其余文件的指针悬停与初始发布竞态。修复这些前提后，第二轮通过 feedback-release、queue-image 与 skill-user-invoke 的全部 15 项测试。负责范围的 lint 与 diff 检查通过。后续 CI 又在 steering 中发现相同的最终回复发布竞态，并发现官方构建中的第二个合法 New session 按钮。显式等待最终回复控件、准确核对品牌所属按钮，修复了这两项测试前提；随后两个负责文件的全部八项测试在无需密钥的执行中通过。后续 CI 提交又暴露初始队列发布竞态和共享页面的草稿清理竞态。加入显式就绪检查后，queue-actions 文件的三项测试及 message-actions 的五项测试分别通过；所有既有基准与记录保持不变。986 提交的完整 E2E lane 通过，而 artifact lane 暴露了空 fill 后保留草稿及偶然侧栏悬停。改用既有原生编辑器手势并明确提示前提后，进一步定向执行通过两个负责文件的全部八项测试（18.04 秒），包含 Queue 的全部四次回放；原基准和 Session/model 记录保持不变。原生 Web evidence 文件后续暴露列表断言早于既有 article 等待；将该等待前移，保留原断言后，全部三项负责用例通过。没有调用提供方 API；上述范围内的证据不代表完整远端 CI 已通过。

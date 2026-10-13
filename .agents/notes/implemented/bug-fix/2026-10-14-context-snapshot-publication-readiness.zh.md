# Agent Note：Context 快照发布就绪条件

Status: implemented

[English](2026-10-14-context-snapshot-publication-readiness.md) | 中文

## Problem

模型轮次完成并呈现在 Chat 后，异步 Context graph 轮询才会发布全部原生消息操作。此前部分浏览器基准只截到了用户控件；CI 随后看到合法的助手控件，因而比较失败。在收起 Map 后等待，还会让指针停留在开关上并显示瞬态提示。

官方品牌 SVG 位于可访问的 **New session** 按钮内，其装饰性祖先标记了 `aria-hidden`。默认的可访问角色查询无法找到这个装饰图像。

## Decision

公开的[浏览器辅助函数](../../../../apps/web/tests/support.ts) `waitForMessageContextControls` 根据场景明确的原生消息数量，等待每条消息的四个 Context 按钮，再截图。反馈与 skill 场景先等待发布，再收起 Map、移开指针，并确认开关提示消失。排队图片用例分别检查初始用户控件和最终五条原生消息；被中止的部分助手输出仍不进入 Context graph。

built-boot 测试验证准确的 SVG 属性、装饰性祖先以及可访问的 New session 按钮。基准仅加入逐项核对过的合法 Context 控件。原始 Session/model JSONL、回放请求、文件内容、图片几何、反馈释放及队列顺序断言保持不变。

## Alternatives considered

- **隐藏 Context 操作或过滤快照。** 这会掩盖实际产品行为。
- **把悬停提示加入基准。** 提示反映测试指针位置，并非预期的稳定对话。
- **大范围刷新模型记录。** 模型可见行为没有改变。

## Consequences

这些修改稳定了对既有产品的观察，不改变 agent 策略、模型质量或个性化行为。[已审阅操作说明](../feature/2026-10-13-context-steward-reviewed-actions.zh.md)与[浏览器回放架构](../testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)继续有效，本说明不取代它们。

## Testing

五个负责的文件共含 19 项无需密钥的测试。第一轮定向执行通过两项 built-boot 和两项 SVG 测试，同时暴露其余文件的指针悬停与初始发布竞态。修复这些前提后，第二轮通过 feedback-release、queue-image 与 skill-user-invoke 的全部 15 项测试。负责范围的 lint 与 diff 检查通过。没有调用提供方 API；上述范围内的证据不代表完整远端 CI 已通过。

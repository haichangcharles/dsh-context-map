# Agent Note：让 Profile 反馈排序回归保持确定性

Status: implemented

[English](2026-10-14-profile-feedback-order-regression.md) | 中文

## Problem

Windows 的全部测试通过，但未覆盖 Profile Branch 反馈排序中按 Session id 与事件序号打破同时间平局的分支。Linux 只是偶然覆盖：既有原生事件在那里有时共享同一毫秒，而更慢的 Windows append 获得不同时间戳。运行时排序仍有必要，因为最近 32 条窗口可以改变个性化 Branch 建议。

## Decision

保持运行时排序不变。两项原生 service 回归只在同步追加历史 Session 事件期间固定 Date.now，随后立即恢复，早于任何 harness 等待。两个独立 family 按相反的字典顺序创建。一个拥有 32 个确认选择（24 次 Move、8 次 Keep），另一个拥有一次 Move。时间戳相同时，Session id 排序把额外 Move 放在真实最近 32 条窗口之外，通用 Keep 保持原样。另一个 family 的选择确实晚一毫秒时，第一条 Keep 离开窗口，保留的 Move 比率变成 26/34，相同通用 Keep 得到可审阅的个性化 Branch 卡片。同一 Session 的反馈也共享时间戳，覆盖按原生事件序号排序的行为。

## Alternatives considered

- **去掉 tie-break。** 原生事件时间戳相等是合法情况，catalog 插入顺序不代表时间顺序。
- **依赖更快的测试执行。** 覆盖仍会依赖机器速度与 wall-clock 分辨率。
- **放松覆盖或伪造宿主平台。** 两者都不验证缺失路径背后的行为。

## Consequences

不改变产品源、模型请求预算、选择策略或生命周期行为。测试检查公开证据的全部 33 个来源 cursor 及其在同一 Session 内的序号顺序。通过不同的公开建议结果验证真正有界的 Branch 窗口，同时保持公开证据列表的独立排序合约不变。固定时钟不改变异步 deadline。

## Testing

全部 29 个 Contextify 测试文件、471 项测试通过。Owning index 源文件的 statement（1083）、branch（843）、function（210）、line（958）覆盖均为 100%。新增 classifier 每种场景使用一次本地 mock 请求，不自动创建 branch。真实 Windows 覆盖仍需下一轮 CI 验证。

## Related

- [原生 service 回归](../../../../packages/context/contextify/tests/service.spec.ts)
- [跨 Profile 排序](../../../../packages/context/contextify/src/index.ts)
- [有界 Branch 校准](../../../../packages/context/contextify/src/personal-branch-policy.ts)

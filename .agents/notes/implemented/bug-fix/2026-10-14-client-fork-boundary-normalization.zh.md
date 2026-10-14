# Agent Note: 一致归一 Client 分支边界

Status: implemented

[English](2026-10-14-client-fork-boundary-normalization.md) | 中文

## Problem

ClientSessions 接受图上的数值锚点，包括中断 Chat 轮次使用的带小数排序位置。包含锚点的 atSeq 路径先向下取整，再构造原生整数 SessionSeq。排除锚点的 beforeSeq 路径直接做品牌类型校验，因此既有公开回归中的 42.8 在到达 Host 前就失败。

## Decision

两个 Client 边界选项都先对传入锚点向下取整，再校验整数品牌类型。Host 仍负责各自不同的包含与排除切点语义。负数、非有限值和不安全数值继续在发出分支请求前被拒绝，未提供的边界继续省略。

## Alternatives considered

- **把回归改成接受错误。** 这会丢失 Client 数值锚点契约，并与 atSeq 不一致。
- **允许小数 SessionSeq。** 这会削弱整个 Harness 的原生通信边界。
- **四舍五入到最近整数。** 这可能把图上的小数锚点推进到下一个事件。

## Consequences

Client 一致地将显示层数值锚点归一为真实原生事件位置。不改变 Host 分支操作、重命名策略、发布和选择生命周期。

## Testing

既有 exclusive 42.8 边界回归在修复前失败，修复后以精确的 42 通信值通过。原始 atSeq 小数回归保持不变。两个选项都验证负数、NaN、无穷大和不安全值在访问 Host 前失败；完整 Client Sessions 回归套件通过。

## Related

- [Client Sessions 服务](../../../../packages/api/session-controller/src/client/sessions/service.ts)
- [Client Sessions 测试](../../../../packages/api/session-controller/tests/sessions-service.client.spec.ts)

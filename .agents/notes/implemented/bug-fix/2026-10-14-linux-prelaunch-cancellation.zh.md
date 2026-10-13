# Agent Note: 保留 bootstrap 消费请求前的 Linux 取消语义

Status: implemented

[English](2026-10-14-linux-prelaunch-cancellation.md) | 中文

## Problem

调用方可能在 Linux scope 的一次性 bootstrap 消费启动请求前取消执行。如果把每个未消费请求都视为意外启动失败，短超时、中止和提供方释放就会变成启动错误。覆盖率插桩使这种顺序更容易发生，也会使要求 killed 结果的消费者丢失请求的终止信号。

## Decision

[Linux scope owner](../../../../packages/subprocess/subprocess-local/src/linux-scope.ts) 保存请求的终止信号。普通进程与 PTY 共用结果解析：已报告的启动错误仍是权威结果；显式终止后尚未消费的请求以空退出码和请求信号结算；未请求终止的未消费请求退出仍是错误。bootstrap 消费请求后，实际目标结果仍是权威结果。范围完全停稳与协议清理继续独立完成。

假的 PTY 生命周期 fixture 显式选择其模拟的 fallback owner。它们不能消费真实原生 bootstrap 请求。专用 Linux scope 和 PTY owner fixture 继续验证原生选择与所有权。

## Alternatives considered

**等待 bootstrap 就绪后才允许取消。** 这会推迟调用方超时与释放，并允许命令在取消意图之后启动。

**忽略所有未消费请求。** 这会掩盖没有取消请求的 bootstrap 崩溃与真实启动失败。

**提高超时或测试限制。** 这只改变竞争的发生概率，无法保留要求的取消结果。

## Consequences

信号意图属于现有操作 owner，而非第二个取消控制器。没有重放命令、提高超时或移除 scope 成员检查。意外 bootstrap 退出与启动诊断仍保持失败关闭。本地平台接缝测试证明结果处理顺序；真实 systemd 行为仍由 Linux CI 覆盖。

## Testing

[scope 测试](../../../../packages/subprocess/subprocess-local/tests/linux-scope.spec.ts) 覆盖待启动时的 SIGTERM 与 SIGKILL、没有 Node 信号的 launcher 退出码、PTY 取消、请求清理与启动错误优先级。负例保留未请求终止的未消费请求退出拒绝，以及未知 scope 状态错误。scope、运行时、spawn 和 terminal 套件共 185 个测试通过，没有提供方调用或放宽时间断言。

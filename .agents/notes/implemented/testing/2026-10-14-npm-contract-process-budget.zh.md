# Agent Note：npm 契约子进程预算与安全超时事实

Status: implemented

[English](2026-10-14-npm-contract-process-budget.md) | 中文

## Problem

Windows coverage 的第一个本地 registry npm 契约用例触发了私有的十秒子进程截止。清理在 12.4 秒完成；同文件之后两个全新 consumer 分别在 640 和 472 毫秒完成。该 lane 已给予九十秒。目前未找到 registry 就绪、端口与缓存所有权、继承 npm 配置或 metadata 响应的缺陷。旧错误不含退出和请求事实，因此实际延迟阶段仍未知。

## Decision

只有[所属 spec](../../../../scripts/benchmark-npm-resolution.spec.ts) 的三个真实 npm 功能用例采用既有 lane 的九十秒上限。子进程截止取公开 `TestContext.task.timeout` 减八秒：一秒 TERM 宽限、五秒强制退出、两秒所属 registry 和临时目录清理。不可能、非有限或小数预算在启动前明确失败，不启动无界工作。根据 Vitest 常规语义，明确的 case 上限覆盖更短的 CLI 默认值；普通本地单测仍可运行。

[benchmark](../../../../scripts/benchmark-npm-resolution.ts) 的截止错误增加固定的耗时、请求计数及真实子进程 close 状态和信号。不增加子进程输出、路径、registry 地址、包名或环境。生产的三百秒默认值、显式 CLI 截止、手动 `--max-ms` SLA、性能门禁及原来的一秒终止回归保持不变。

## Alternatives considered

- **重试 npm 或回退到公共 registry。** 这会改变隔离并重复工作，而非诊断所属子进程。
- **扩大性能阈值。** 三个用例验证不下载归档、安装位置及配置隔离，不验证速度 SLA。
- **认定冷启动导致延迟。** 首轮与后续调用的差异提示争用，但不能定位阶段。

## Consequences

契约 fixture 不再用无关的十秒子进程限制取代 lane 预算。它仍有有限截止、有界终止及等待完成的清理。后续原生失败可以区分 metadata 是否收到请求以及子进程是否关闭。这不证明 Windows CI 已通过，也不证明原始延迟的具体原因。

## Testing

真实一毫秒 npm 截止回归在没有退出事实时 RED，修改后 GREEN。公开集成断言保留 registry 请求、零归档、精确别名版本及恶意继承配置下的 peer 位置。预算边界用例拒绝不可能的输入。范围 Node 24 测试使用真实本地 npm 和 loopback，不涉及 OS 伪装、provider、测试重试或断言过滤。原生 Windows CI 仍为权威依据。

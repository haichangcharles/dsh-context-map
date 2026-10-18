# Agent Note: 原生测试工作进程退出证据

Status: implemented

[English](2026-10-18-native-worker-exit-evidence.md) | 中文

## Problem

Windows 原生测试通道可能丢失 Vitest 进程，却不报告断言失败。Vitest 4.1.8 丢弃退出回调的退出码与信号，因此通用错误无法区分运行时崩溃和测试被终止。多次运行在不同数量的已完成用例后结束。本机通过不能解释 Windows 原因。

## Decision

[E2E 工作流](../../../../.github/workflows/e2e.yml)中主动选择的 `runtime-diagnostics` 任务迁移 [Vitest PR 10587](https://github.com/vitest-dev/vitest/pull/10587) 的退出码与信号报告方式。它只改变该诊断任务所安装依赖的错误文字，要求预期处理器恰好出现一次，依赖改变时明确失败。原子替换文件避免改动 pnpm 存储硬链接。依赖版本、产品代码、普通测试任务和断言均保持不变。

该任务使用详细输出和至多两个工作进程运行四个原生生命周期测试文件。[回归测试](../../../../scripts/worker-exit-diagnostics.spec.ts)在私有假包目录中执行内联补丁，检查 Windows 大退出码和信号被保留，并检查未知处理器被拒绝且文件未修改。回归测试不改动开发机器已安装的依赖。

[显式 CI 预算决策](2026-10-13-explicit-ci-api-budget.zh.md)继续有效：手动诊断要求 `runtime_diagnostics=true`，清空模型凭据，并保持 `real_api=false`。它不授予模型调用授权。此机制补充诊断证据，不替代既有测试或预算决定。

## Alternatives considered

**重试直到变绿或增加超时。** 进程崩溃不是超时，成功重试也不解释之前的崩溃，因此否决。

**观察退出前就更换 Node、关闭 JIT 或改变工作流终止。** 这会在尚未确定原因时修改疑似责任方，因此否决。

**升级或永久修补整个 Vitest 依赖。** 此次调查只缺诊断输出，因此采用有界的主动诊断适配，保持已有依赖图和普通判定。

## Consequences

适配明确绑定已安装的处理器，Vitest 变化时需要重新检查。它暴露退出证据，不修复底层运行时故障，也不证明原生崩溃不再发生。诊断运行与必需的原生 CI 判定分开。首次失败和之后的结果独立保留。

# Agent Note: 必需 Windows 原生通道的崩溃证据

Status: implemented

[English](2026-10-19-required-native-crash-evidence.md) | 中文

## Problem

必需 Windows Vitest 子进程曾以访问异常 `0xC0000005` 退出。单独的有界诊断未复现；后续诊断通过不修复或替代原必需通道的失败结论。捕获必须跟随实际必需通道的 runner、Node 选择、pnpm 环境及测试命令。

## Decision

[ci.yml](../../../../.github/workflows/ci.yml) 的必需原生和覆盖率任务调用 [Windows 包装脚本](../../../../scripts/run-windows-native.ps1)。默认 native 通道保留原有四个文件、`pnpm exec`、默认报告器、串行方式及超时。coverage 通道只执行一次原有 `pnpm run check:ci:coverage`，保留分区、worker、报告和超时配置；每次调用都传播失败。不改变依赖、运行时标志、断言或产品行为。覆盖率也出现过无断言失败的子进程异常退出；没有异常证据前，不能认定它与此前的访问异常相同。

只在一次性 GitHub-hosted Windows 上，[调试器准备](../../../../scripts/prepare-native-debugger.ps1)使用官方、经过 Microsoft 签名验证的 SDK 及匹配的公开 Node 符号。[AeDebug](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/enabling-postmortem-debugging) 仅在未处理崩溃后启动 CDB；`.jdinfo` 选择原始异常上下文。日志记录堆栈和模块清单，不保存内存转储。即使测试命令返回零，独立异常标记仍会使包装脚本失败。

[注册表所有者](../../../../scripts/native-postmortem-registry.ps1)只保存、恢复 Debugger/Auto 的原类型及原始值，正确处理名称大小写和不展开的字符串。成功、失败或部分初始化后，`finally` 都恢复配置。私有 HKCU 六例替身分别以正常和抛错回调检查不存在的键、无关值、小写展开字符串及 DWord。Self-hosted runner 只运行原命令，不准备调试器或改变机器注册表。两个无密钥任务的模型凭据环境变量均为空，各通道使用独立诊断日志。

## Alternatives considered

反复重试直到通过，或未抓到栈就改变 Node/JIT/终止方式，会掩盖原因。全程附加调试器会改变时序；事后捕获在失败前不附加调试器，但增加了 hosted runner 对 SDK/符号可用性的依赖。

## Consequences

这是可观测性，不声称已修复运行时。原失败继续保留。包装脚本的原生执行必须由必需 CI 自身验证；替身和独立诊断通过不能替代。它不授予模型 API、训练或付费工作流授权。

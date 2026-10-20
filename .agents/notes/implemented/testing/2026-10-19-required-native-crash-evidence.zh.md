# Agent Note: 必需 Windows 原生通道的崩溃证据

Status: implemented

[English](2026-10-19-required-native-crash-evidence.md) | 中文

## Problem

必需 Windows Vitest 子进程曾以访问异常 `0xC0000005` 退出。单独的有界诊断未复现；后续诊断通过不修复或替代原必需通道的失败结论。捕获必须跟随实际必需通道的 runner、Node 选择、pnpm 环境及测试命令。

## Decision

[ci.yml](../../../../.github/workflows/ci.yml) 的必需原生和覆盖率任务调用 [Windows 包装脚本](../../../../scripts/run-windows-native.ps1)。默认 native 通道保留原有四个文件、`pnpm exec`、默认报告器、串行方式及超时。coverage 通道只执行一次原有 `pnpm run check:ci:coverage`，保留分区、worker、报告和超时配置；每次调用都传播失败。不改变依赖、运行时标志、断言或产品行为。覆盖率也出现过无断言失败的子进程异常退出；没有异常证据前，不能认定它与此前的访问异常相同。

只在一次性 GitHub-hosted Windows 上，[调试器准备](../../../../scripts/prepare-native-debugger.ps1)使用官方、经过 Microsoft 签名验证的 SDK 和匹配的公开 Node 符号。原生通道将 CDB 附加到原始子进程树，在运行前安装异常过滤器，以独占私有回执保留原检查结果；堆损坏警告独立于零退出码判失败。覆盖率仍使用 [AeDebug](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/enabling-postmortem-debugging) 事后捕获，`.jdinfo` 选择异常上下文。日志记录堆栈及模块清单，不保存内存转储；独立致命异常标记也会使相应通道失败。

[注册表所有者](../../../../scripts/native-postmortem-registry.ps1)只保存、恢复 Debugger/Auto 的原类型及原始值，正确处理名称大小写和不展开的字符串。成功、失败或部分初始化后，`finally` 都恢复配置。私有 HKCU 六例替身分别以正常和抛错回调检查不存在的键、无关值、小写展开字符串及 DWord。Self-hosted runner 只运行原命令，不准备调试器或改变机器注册表。两个无密钥任务的模型凭据环境变量均为空，各通道使用独立诊断日志。

Hosted 包装脚本还使用[操作系统进程退出通知](../../../../scripts/windows-process-exit-evidence.ps1)，在没有未处理异常堆栈时记录后代进程的数值退出状态。私有 CIM 订阅缓冲[进程启动](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/krnlprov/win32-processstarttrace)与[退出](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/krnlprov/win32-processstoptrace)事件；按系统时间排序，从包装进程PID确定归属并撤去复用PID的归属。日志只包含进程名、ID、时间和退出状态，不含参数、环境或内存转储。汇总明确属于尽力观察：延迟或缺失通知会漏记，最多解码50000条通知、保留32条非零退出详情，并记录省略数。测试中预期的非零子进程不会使成功命令失败。初始化或采集失败只警告，原回调仍只执行一次；所有路径均清理私有订阅和事件。纯替身检查归属、排序、PID复用、上限，以及部分初始化失败后回调的返回/抛错传播；实际CIM通知交付由Windows CI观察，替身不证明该行为。

原始必需原生步骤在一次性 hosted runner 上失败后，另一个[有界归约](../../../../scripts/run-windows-worker-reduction.ps1)通过实际源码 workflow 引擎，在微软 [Full PageHeap](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/gflags-and-pageheap) 下固定执行四次 return42、获取结果及清理。它把已安装的 Node 复制到私有临时目录，使用唯一诊断映像名，要求对应注册表项原本不存在，验证 full traces，并在 finally 中恢复不存在的状态。绝不对通用 node.exe 或本机开启 PageHeap。[注册表工程夹具](../../../../scripts/native-pageheap-image.ps1)无需目标进程或机器设置，检查成功、设置／运行／关闭失败及碰撞。探针保留源码 worker 引导和原生清理，记录身份及生命周期阶段，不启动子 Agent 或调用模型。每个调试器进程最多150秒，目标 watchdog120秒，JS 旧空间512MiB，另有 PageHeap 内存开销。超时后尝试终止自有进程树并有限等待根进程退出，但后代静默仍未确认，因此阻断进一步目标运行。原始原生判定绝不被替代，日志及 blocked 状态保留三天。此前源码／构建／纯 worker 与加载器注册对照保留在已提交版本中，不重复执行。即使回执为0，原始堆损坏警告、VERIFIER STOP 或未处理原生故障仍独立判失败。诊断成功不等于修复运行时。

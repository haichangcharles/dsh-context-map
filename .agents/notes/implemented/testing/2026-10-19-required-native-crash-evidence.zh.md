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

常规 CI 保留原始必需捕获，不自动重复已完成的归约实验。在一次性 hosted runner 上另行限定范围的诊断可调用[有界归约](../../../../scripts/run-windows-worker-reduction.ps1)，通过实际源码 workflow 引擎，在微软 [Full PageHeap](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/gflags-and-pageheap) 下固定执行四次 return42、获取结果及清理。它把已安装的 Node 复制到私有临时目录，使用唯一诊断映像名，要求对应注册表项原本不存在，验证 full traces，并在 finally 中恢复不存在的状态。绝不对通用 node.exe 或本机开启 PageHeap。[注册表工程夹具](../../../../scripts/native-pageheap-image.ps1)无需目标进程或机器设置，检查成功、设置／运行／关闭失败及碰撞。探针保留源码 worker 引导和原生清理，记录身份及生命周期阶段，不启动子 Agent 或调用模型。每个调试器进程最多150秒，目标 watchdog120秒，JS 旧空间512MiB，另有 PageHeap 内存开销。超时后尝试终止自有进程树并有限等待根进程退出，但后代静默仍未确认，因此阻断进一步目标运行。原始原生判定绝不被替代，日志及 blocked 状态保留三天。此前源码／构建／纯 worker 与加载器注册对照保留在已提交版本中，不重复执行。即使回执为0，原始堆损坏警告、VERIFIER STOP 或未处理原生故障仍独立判失败。诊断成功不等于修复运行时。

hosted 失败路径中的超时对照在同一包装器中选择 `dual-tsx-vm-timeout`。它使用已安装的 Node 映像，不开启 PageHeap 或修改注册表，注册已安装的 tsx ESM/CJS 钩子，并用 `runInContext` timeout5000 执行相同的立即返回 async42 程序。四轮 worker／结果／终止只观察同步超时监护的建立与清理，不触发超时，也不验证异步中断。常规 CI 不重复这一已完成对照；另行获准的诊断使用保留的包装器。步骤跳过不能算阴性结果。原始必需失败仍有权威性，已完成的对照在后续无关推送中停用。

另行限定的 `dual-tsx-typescript` 对照在相同 VM 程序前，仅用绝对 file URL 导入一个无依赖的 TypeScript enum 夹具。worker 与父进程验证导出值42之后才记录 typed-import 成功。它复用已安装的 tsx 注册和同一有界生命周期，不增加 timeout 选项、PageHeap、workflow 导入或生产变更。常规 CI 不重复这项已完成的 hosted 观察；另行授权的诊断仍可使用保留的 wrapper。它检查的是 typed-module 加载组合路径，不能单独归因转换器、缓存或非法写入者。

另行限定的完整工作负载模式，以唯一且受 PageHeap 保护的已安装 Node 副本启动实际 Vitest CLI，运行相同四个必需文件和参数；原必需命令不变。私有文件启动 witness 仅记录进程身份和内部匹配的 CLI／worker 角色，不输出 stdout、参数或环境值，并尊重 workflow 的环境隔离。只有实际 Vitest worker PID 与 CDB 受保护映像及 flags 证据对应，才可解释阴性结果。新模式单独允许自有调试器450秒、根进程 join5秒和 hosted step9分钟；普通对照保持150秒。它在捕获清理前保留原始独占退出回执，明确记录缺失／复制失败，并将原生故障证据与工作负载或回执是否完整分别保留。回执完成不等于69项齐全或 worker 已受保护；超时、内存不足、缺项和保护未知均不予认证，绝不替代原始失败。没有生产或模型操作。

## Alternatives considered

反复重试直到通过，或未抓到栈就改变 Node/JIT/终止方式，会掩盖原因。附加调试器会改变时序，但原生通道的实时捕获能记录覆盖率事后路径可能漏掉的线程退出堆证据。SDK／符号可用性与 Full PageHeap 内存开销增加了诊断成本；小型归约为阴性，也不能排除原始多用例或编译／清理的交互。

## Consequences

这是可观测性，不声称已修复运行时。原失败继续保留。包装脚本的原生执行必须由必需 CI 自身验证；替身和独立诊断通过不能替代。它不授予模型 API、训练或付费工作流授权。

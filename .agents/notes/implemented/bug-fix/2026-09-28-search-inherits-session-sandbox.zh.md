# Agent Note: Filesystem search inherits the calling session sandbox

Status: implemented

[English](2026-09-28-search-inherits-session-sandbox.md) | 中文

## Problem

`bash` 工具通过会话沙箱策略约束子进程，而 `glob` 和 `grep` 直接通过 subprocess 提供方启动打包的 ripgrep。因此，同一会话的 shell 无法读取的文件，搜索工具仍可能读到。`--no-config` 能阻止 ripgrep 配置注入，但不能限制文件读取。

## Decision

共用的 [`runRipgrep()`](../../../../packages/fs/tool-fs-search/src/search-core.ts) 辅助函数为调用会话解析 `ctx.sandboxPolicy`，在受限模式下把 ripgrep 的 argv 交给 `ctx.sandbox.confine()`。`glob` 和 `grep` 均继承此行为。受限策略缺少沙箱提供方时在启动前失败；只有沙箱提供方而缺少策略服务时也失败。两项可选服务都不存在的组合保持本地 subprocess 搜索；显式 `danger-full-access` 仍不受限。

本次更改复用沙箱提供方现有的文件系统策略，没有加入按来源细分的生产策略配置。研究用 Seatbelt 提供方对已知 A 目录设置读取拒绝，以验证搜索遵从与 `bash` 相同的限制；它不属于正式发布的策略。

## Alternatives considered

**因为搜索只读就保持不受限。** 搜索结果仍会暴露调用 Agent 无权读取的来源内容及文件名。

**让搜索经 shell 执行器运行。** 搜索使用固定 argv、限制原始输出并解析结果，不涉及 shell 语法；直接使用沙箱提供方可保留这些性质及现有 subprocess 捕获路径。

**所有组合一律要求沙箱服务。** 不受限的本地 profile 可以合法使用文件发现；可选 peer 保留这一用法，同时在执行时拒绝不完整的受限配置。

## Consequences

官方搜索测试覆盖本地路径、受限策略缺少提供方时的失败，以及执行器故障诊断优先于 ripgrep 的退出 1 空搜索结果。macOS 原生研究回归验证 `grep` 和 `glob` 不会暴露被拒绝的 A 目录，同时 B 仍可搜索。普通沙箱策略管理文件写入模式，不提供 A/B 读取分区；要主张来源隔离，还需要按来源限制的提供方、完整输入通道清单及全量强制执行检查。当前搜索结果不报告提供方的部分强制执行状态。

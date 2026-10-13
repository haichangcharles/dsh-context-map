# Agent Note: 显式 CI 模型 API 预算

Status: implemented

[English](2026-10-13-explicit-ci-api-budget.md) | 中文

## 问题

自动模型 API 验证在每个符合条件的 PR 或 push 上消耗费用。已安装 wheel 的 CI 能通过可复用工作流使用同一凭证，因此只保护主 e2e job 仍会留下自动消费路径。固定的 Ubuntu 包归档 URL 也会在旧 bubblewrap 修订被移除后失效，使准备步骤在任何测试运行前就失败。

## 决策

[E2E 工作流](../../../../.github/workflows/e2e.yml)在普通 PR 和 push 上运行完整 Context Map 构建、录制会话回放和浏览器回放，不携带模型凭证。付费 profile 和已安装 wheel 的测试必须同时满足 `workflow_dispatch` 和默认关闭的 `real_api` 输入。[可复用 runtime builder](../../../../.github/workflows/build-exe-for-python-sdk.yml)在每个携带密钥的步骤前独立检查这两个值。自动 PR、master 和发布调用方保留原生产物与无密钥 black-box 覆盖，不传递模型密钥。各提供方和 E2B 工作流仍只允许手动触发。本决策推翻[真实 API CI 决策](2026-06-19-real-api-e2e-ci.zh.md)中的自动消费策略，保留其预检与凭证隔离。

[Bubblewrap 准备脚本](../../../../scripts/prepare-ci-bubblewrap.sh)通过已认证的 APT 索引把当前发行版软件包下载到运行器的私有目录，不执行系统包事务就解包，并且只在功能性隔离探测通过后公布二进制路径。私有索引目录避免并行 job 共享锁；更新钩子通过[APT 文档规定的指令](https://manpages.ubuntu.com/manpages/jammy/man5/apt.conf.5.html)清除，避免获取索引时写入全局缓存。运行器清理负责解包后的二进制；脚本清理负责移除获取阶段的元数据。

默认关闭的 `runtime_diagnostics` dispatch 输入在 Linux 与 Windows 上选择原生生命周期、提示符与投影缓存测试，并清空所有提供方凭证。此类选定的插桩运行不代表完整覆盖率。普通事件仍运行完整回放 job 与仓库覆盖率检查；只有显式诊断 dispatch 才省略完整回放。

## 考虑过的替代方案

**每次 push 后取消付费运行。** 取消会与设置和模型执行竞态，并且需要持续监控。触发器与凭证检查在自动模型调用开始前就阻止它们。

**移除 e2e 检查或跳过所有集成测试。** 这会丢失产品覆盖。录制执行的无密钥回放、浏览器回放和原生已安装 wheel 检查仍自动运行；真实模型验证仍能在显式授权后使用。

**固定另一个归档 URL 或通过 APT 全局安装。** 新固定 URL 有同样的过期问题。全局包事务引入共享锁和安装钩子；已认证的当前索引与私有解包保留包校验，不引入这些变化。

## 后果

普通 CI 不证明当前外部模型质量。显式真实运行仍在缺少凭证时失败，日志不会打印密钥。[工作流预算测试](../../../../scripts/ci-api-budget.spec.ts)验证自动事件与 opt-in 条件，包含反例，并检查完整工作流集合。[准备测试](../../../../scripts/prepare-ci-bubblewrap.spec.ts)通过命令 fixture 验证失败、清理和并行进程分配；真实内核隔离仍以 Linux CI 的探测为准。

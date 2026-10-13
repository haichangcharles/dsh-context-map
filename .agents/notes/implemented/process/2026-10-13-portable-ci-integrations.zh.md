# Agent Note: 无需上游账户依赖的 CI

Status: implemented

[English](2026-10-13-portable-ci-integrations.md) | 中文

## 问题

Fork 能成功构建，却可能因为没有上游账户凭证或组织运行器池而在可选发布或 Project 自动化中失败。把每个必需 worker 排入不可用的自定义运行器，会让仓库无法产生 CI 结论。缺少集成配置与产品或测试失败是不同的问题。

## 决策

[必需的 PR CI](../../../../.github/workflows/ci.yml)默认使用标准托管 Linux 和 Windows 运行器，并限制 worker 与覆盖率分区数量。`DSH_CI_LINUX_RUNNER` 和 `DSH_CI_WINDOWS_RUNNER` 选择已配置的大型池；显式 failover 保留现有 self-hosted 路由。Master standby job 只针对已配置的 failover 池运行。所有必需 PR 构建、覆盖率、快照、benchmark 和原生平台检查仍保留。[API 预算策略](../testing/2026-10-13-explicit-ci-api-budget.zh.md)独立阻止自动模型消费。

[Preview CI](../../../../.github/workflows/build-preview-cloudflare.yml)为每个 PR 构建并保留产物。Cloudflare 上传、受保护镜像验证和 URL 评论必须同时满足受信任的同仓库 PR，以及完整的部署和 Access 凭证。未配置仓库报告仅产物模式；部分部署配置会明确失败。仅产物运行不会被宣称为托管 preview。

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml)和[Issue policy](../../../../.github/workflows/issue-policy.yml)始终测试可信的策略实现。真实 Project 操作必须满足配置中的组织/仓库与触发仓库一致，以及完整的 GitHub App 配置。App token 针对当前仓库，不针对硬编码的上游安装。未配置的 fork 明确报告没有执行看板策略或修改；适用但不完整的配置会失败。现有人类 PR 和 changes-requested 检查条件仍受强制执行。

## 考虑过的替代方案

**跳过所有 fork CI。** 产品缺陷将失去构建、浏览器、软件包和平台证据。只有依赖可选账户的操作需要配置；本地测试与必需 CI 仍运行。

**复制上游密钥或修改其 Project。** Fork 无权复用该安装或账户。仓库匹配与显式配置把外部操作限制在预期所有者范围内。

**无条件使用上游自定义运行器标签。** 标签不会为另一个账户创建运行器池，排队 job 永远不会产生结论。标准运行器为 fork 提供可执行默认值，已配置池仍保留更高的并发度。

## 后果

本地策略测试不证明组织 Project 已被读取或更新，preview 产物也不证明部署。工作流摘要明确这些限制。[配置测试](../../../../scripts/fork-ci-options.spec.ts)不使用真实凭证就执行凭证存在性判断，保留部分配置失败，并验证托管和自定义运行器路由。一旦显式配置集成，真实权限错误仍会导致失败。

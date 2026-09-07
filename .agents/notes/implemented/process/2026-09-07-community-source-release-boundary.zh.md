# Agent Note: 社区源码发布边界

Status: implemented

[English](2026-09-07-community-source-release-boundary.md) | 中文

## 问题

DSH Context Map 在独立公开仓库中维护，同时保留 DeepSeek Harness 的 Workspace 与 Package 图。继承的仓库包含组织专用 Runner、Project Automation、Registry 发布 Job 和上游 Package 标识。在本仓库中运行这些路径，要么会因为与产品无关的基础设施而失败，要么会形成发布本项目并不拥有其 Namespace 与发布流程的 Package 的入口。

本项目仍然需要证明自己的改动与完整的继承构建保持兼容。删除所有打包 Workflow 会掩盖依赖、Payload 和已安装产物的回归，而这些回归同样会破坏源码用户的使用。

## 决策

DSH Context Map 通过 GitHub Releases 和产品专属的 `dsh-context-map-vX.Y.Z` Tag 发布不可变源码。Release Tag 指向通过社区检查的精确 Commit。受支持的构建输入是 Checkout 到该精确 Tag 的 Git 仓库，从而让官方构建记录真实的 Commit 来源。GitHub 自动生成的源码归档缺少 `.git`，因此只作为参考快照而不是直接构建输入；确实需要从归档构建时，必须把 `DSH_CLIENT_COMMIT_HASH` 设置为完整的 Release Commit SHA。Release Notes 会说明 DeepSeek Harness 是当前唯一受支持的 Context Map 宿主 Runtime，并把 Claude Code 与 OpenAI Agents SDK 的宿主 Runtime Adapter、以及后续进入 OpenCode 的应用描述为 Roadmap 目标，而不是已经可用的集成。DeepSeek Harness 内部继承的 Claude Code Subagent 与 Hook 互操作能力与该 Roadmap 相互独立。

继承的 dsh、vendor、Landlock Run 与 Python Release Workflow 仅用于兼容性检查。它们可以构建、打包、安装、检查和短期保留 GitHub Artifact，但不包含 npm 或 PyPI 发布 Job、Registry 凭据或发布用 OIDC 权限。内部 `@deepseek-ai/*` 名称保持不变，因为它们属于继承的 Workspace 图，并不表示本仓库拥有上游 Package Namespace。

Registry 发布工具以明确命名的 `upstream:*` 维护参考形式保留在源码树中，以便未来同步上游时比较完整的继承工具。任何受支持的社区 Workflow 或 Release 说明都不会调用这些工具，它们也不属于 DSH Context Map 的发行约定。

Community CI 在 GitHub-hosted Runner 上为 Pull Request 和 `master` Push 运行。它会执行 Workflow 协议回归，并同时覆盖 Typecheck、Lint、Workspace constraints、GUI 测试和重点 Runtime 测试。继承的私有 Runner 矩阵只作为手动工程参考保留。Real-provider 检查保持手动并要求显式配置 Secret；聚焦、无凭据的真实内核 Sandbox 证明则在 `master` Push 后由独立 Workflow 运行。GitLab 配置只是一条需要显式选择的手动构建参考，不包含 Package 上传 Stage。

本仓库不保留 DeepSeek 组织 Project Automation。Issue 与 Pull Request 使用普通仓库能力，不依赖 GitHub App 或组织 Project。文档发布使用本仓库自己的 GitHub Pages 配置、源码链接、编辑链接、产品名称与视觉标识。

## 考虑过的替代方案

**在 CI 中保留受保护的手动 Registry 发布入口。** Environment 审批和 Tag 校验能够降低误操作概率，但独立项目仍不拥有上游 npm 或 PyPI 发布标识。即使暂时不使用，CI 凭据入口也会与仅发布源码的承诺冲突，并扩大 Workflow 错误的后果。

**删除所有继承的 Package Workflow。** 这样可以消除发布风险，但也会失去 Fork 仍能生成可安装上游形态产物的证据。无凭据的兼容性演练可以保留这些证据，同时不把产物包装成受支持的 Registry Release。

**在发布前把所有继承 Package 改到项目自有 Scope。** 新 Namespace 将来可以支持 Package 发布，但全仓库改名会扩大长期维护的 Fork 范围，并显著增加上游合并难度。Package 发布需要单独决定版本、迁移与所有权策略。

**把上传的 CI Artifact 或 GitHub 自动源码归档当作可直接构建的产品。** 短期 CI Artifact 是诊断证据，并且可能使用继承的 Package 标识。自动源码归档缺少记录真实构建来源所需的 Git 元数据。受支持的发行物是 Checkout 到带 Tag 源码 Commit 的 Git 仓库，两类 Artifact 都不会被描述为稳定、可直接构建的安装渠道。

## 后果

用户按照本仓库的 Git Checkout 说明安装 DSH Context Map，并优先 Checkout 到不可变 Release Tag。Release Notes 会公布精确 Commit SHA，以便高级用户在构建自动源码归档时显式提供 `DSH_CLIENT_COMMIT_HASH`。本项目不会声称带继承名称的 npm 或 PyPI Package 包含这个发行版。兼容性 Job 能发现打包回归，但它们的 Artifact 会过期，也不是受支持的发布渠道。

未来发布 Package 必须先形成新的决策，明确项目自有 Namespace、版本、迁移路径、凭据与 Registry 策略。在此之前，Workflow 协议测试会拒绝重新引入的发布 Job 与 Secret，并由必需的 Community CI 在每次受支持的改动上执行这些测试。

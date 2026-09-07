# DSH Context Map 社区发布就绪设计

[English](2026-09-07-community-release-readiness-design.md) | 中文

## 目标

让独立维护的 DSH Context Map 仓库具备真实、可发布的状态。公开文档必须区分当前能力与未来 Runtime 集成，并且所有自动触发的 GitHub Workflow 都只能验证这个社区仓库实际能够支持的性质。

## 产品定位

DeepSeek Harness 是当前版本唯一已经实现并受支持的 Context Map 宿主 Runtime。Roadmap 可以说明未来为 Claude Code 与 OpenAI Agents SDK 增加 Context Map 宿主 Runtime Adapter，并进一步进入 OpenCode 等开源 Agent 产品，但不能暗示这些集成现在已经存在。DeepSeek Harness 内部继承的 Claude Code Subagent 与 Hook 互操作并不等同于 Context Map 宿主 Runtime Adapter。

Context Map 的持久图、选择 Revision、Archive 占位符、推荐协议与 UI 继续由应用层拥有。未来 Adapter 可以把其他 Runtime 的原生 Session、消息、分支和生命周期事件转换为这个稳定模型。本次发布不会增加第二套 agent loop。

## Runtime 重试协议

一份 Context compilation 在单次请求尝试中被冻结，并在普通 provider retry 中复用。Recovery middleware 可能在两次尝试之间提交 Session surface replacement，最典型的情况是 Compaction。因此 Agent Loop 会在 compilation 旁记录 `session.surface.replaceGeneration`，并且只在 retry 观察到 generation 改变时重新编译。这样既保留 retry 的确定性，也避免压缩前的陈旧 compilation 在下一次 adapter 请求之前就因重建校验失败。

任何挂载 Agent Loop 的 Loader fixture 也必须挂载必需的 Context Compiler service。生产 Bundle 已经满足该要求，遗漏发生在 retry composition fixture 中。

## CI 与发布策略

- Community CI 在标准 GitHub-hosted runner 上为 Pull Request 和 `master` Push 运行，负责 Typecheck、Lint、GUI 测试和重点 Runtime 回归。
- 继承的上游 CI 只保留为手动工程参考，因为它依赖 DeepSeek 的私有与大型 runner pool。
- 所有继承的 Package Workflow 都是无凭据的兼容性检查。dsh、vendor、Landlock Run 与 Python Workflow 可以构建和验证与上游一致的产物，但不保留 npm 或 PyPI 发布路径。三个 Context Map Package 与继承的 dsh Release family 对齐，同时把源码元数据指向本仓库。
- Real-provider E2E 在仓库有意配置合适 Secret 之前只允许手动运行；手动触发但缺少 Secret 时仍必须明确失败。
- Sandbox CI 只证明内核隔离。macOS 任务运行重点 Seatbelt E2E，不再重复整个 Unit suite。
- GitHub Pages 使用 GitHub Actions 作为构建来源，现有文档 Workflow 继续负责校验与部署。
- 删除依赖 DeepSeek 组织 Project 的 Issue Automation。本仓库通过普通 GitHub Issues 和 Pull Request 接受贡献，不依赖不可用的 GitHub App 或组织 Project。

## 发布边界

本仓库发布 GitHub 源码 Release，而不是继承的 npm 或 PyPI Package family。Release tag 必须指向经过验证的当前 Commit，历史 Tag 保持不变。受支持的构建输入是 Checkout 到该 Tag 的 Git 仓库。GitHub 自动源码归档因为缺少 `.git` 而只作为参考快照；确实从归档构建时必须把 `DSH_CLIENT_COMMIT_HASH` 设置为 Release Commit。Release Notes 需要说明 DeepSeek Harness 是当前 Runtime，外部 Runtime Adapter 仍属于 Roadmap。

## 验证

本地证据必须覆盖 retry 回归、Loader composition、Workspace constraints、Release-family 校验、GUI 测试、Typecheck、生产构建、双语文档检查和干净 Diff。Push 之后，必须在同一个精确 Commit 上检查 Community CI、Package compatibility、Sandbox 和文档部署。Real-provider E2E 不得自动运行。

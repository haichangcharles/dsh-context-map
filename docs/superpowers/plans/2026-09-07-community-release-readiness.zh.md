# DSH Context Map 社区发布就绪实施计划

[English](2026-09-07-community-release-readiness.md) | 中文

**目标：** 发布真实的 GitHub 源码 Release，并用适合社区仓库的检查替代继承基础设施造成的失败。

**架构：** DeepSeek Harness 继续作为当前唯一 Runtime。普通 request retry 复用同一份 compilation，只在 Session surface replacement 已经提交后使其失效；社区专属 Workflow 改动与上游 Runtime 行为保持分离。

**技术栈：** TypeScript、Cordis Loader、Vitest、GitHub Actions、GitHub Pages、Markdown

## 任务 1：修复请求重试编译

- [ ] 在实现前记录 Compaction 与 Loader 测试的失败证据。
- [ ] 在 request loop 前保存 Context compilation 与它的 `replaceGeneration`。
- [ ] 收到 retry action 时，只在当前 surface generation 不同时重新编译。
- [ ] 在合成 Loader fixture 中挂载 Context Compiler。
- [ ] 一起运行 Compaction、Loader 和普通 provider-retry 回归测试，预期 12 项全部通过。

## 任务 2：对齐社区 Package 兼容性

- [ ] 把三个 Context Map Package 版本设为 `0.1.0-rc.8`。
- [ ] 把源码元数据指向 `haichangcharles/dsh-context-map`，并让 Workspace constraints 识别这三个社区拥有的 Package。
- [ ] 把继承的 dsh、vendor、Landlock Run 与 Python Release Workflow 改为无凭据的兼容性检查，不保留 npm 或 PyPI 发布路径。
- [ ] 运行 Workspace constraints 和 `release:verify --family dsh`。

## 任务 3：替换不可用的 CI 基础设施

- [ ] 将继承的 CI 改为仅手动运行，因为本仓库无法使用它的自定义 runner pool。
- [ ] 在 `ubuntu-latest` 上增加 Community CI，覆盖 Typecheck、Lint、GUI 测试和重点 Runtime 回归。
- [ ] Real-provider E2E 保持手动触发，并严格检查可选 Secret。
- [ ] Sandbox 只保留真实内核隔离 E2E。
- [ ] 删除继承的组织 Project 与 GitHub App Issue Automation。

## 任务 4：发布真实文档

- [ ] 在两份 README 中增加当前 Runtime 支持和未来 Adapter Roadmap。
- [ ] 只把 Claude Code、OpenAI Agents SDK 和 OpenCode 描述为未来工作。
- [ ] 为独立仓库更新文档站品牌、源码链接、编辑链接和贡献指南。
- [ ] 记录并校验所有变更的双语 Pair。

## 任务 5：启用并验证 GitHub Pages

- [ ] 把仓库 Pages build type 配置为 `workflow`。
- [ ] 本地运行文档同步和 VitePress 生产构建。
- [ ] 检查精确 Push Commit 上的远程文档 Workflow。

## 任务 6：验证并发布

- [ ] 运行重点回归、Community CI 命令、Workspace constraints、Release 校验、GUI 测试、Typecheck、生产构建、文档检查和 `git diff --check`。
- [ ] Commit 并把经过验证的精确工作树 Push 到 `master`。
- [ ] 取消仍在等待不可用上游 runner 的旧 Workflow。
- [ ] 检查所有自动触发的 Workflow；Real-provider E2E 必须保持未触发。
- [ ] 从经过验证的 Commit 创建新的不可变 GitHub 源码 Tag 和 Release，不移动历史 Tag；把带 Tag 的 Git Checkout 写成受支持构建方式，并为确实需要构建自动归档的用户公布完整 SHA。

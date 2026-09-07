# 贡献

[English](CONTRIBUTING.md) | 中文

感谢你为 DSH Context Map 作出贡献。本项目是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、由社区独立维护的项目，并非 DeepSeek 官方产品。

## 在哪里反馈问题

- Context Map 的 Bug 和功能建议，请提交到本仓库的 [Issues](https://github.com/haichangcharles/dsh-context-map/issues)。
- Harness 底层 Runtime 的缺陷，请提交到 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness/issues)。
- 如果暂时无法判断问题属于哪一层，可以先在本仓库创建 Issue 并描述观察到的现象。维护者可以协助转交，不要求你先完成归因。

提交问题时，请提供复现步骤、操作系统和 Node.js 版本、预期行为，以及相关日志或截图。发布前请移除密钥、私密对话内容和其他敏感信息。

## Pull Request

本项目欢迎社区提交 Pull Request。开始较大改动前，请先创建 Issue，以便讨论范围和兼容性影响。每个 Pull Request 应聚焦单一目标，避免修改无关的上游兼容代码；如果行为发生变化，请同步补充或更新测试和文档。

请以 `master` 为目标分支。常用的验证流程如下：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:gui
pnpm run build
pnpm run doc-sync
```

创建 Draft Pull Request 前，请运行与改动相关的检查；如有检查无法在本地执行，请在 PR 中说明。仓库的架构和开发约束见 [AGENTS.md](AGENTS.md)。不要提交模型服务商密钥，也不要把秘密信息复制到 Issue、测试 Fixture 或日志中。

## Runtime 边界与 Roadmap

DeepSeek Harness 是当前唯一已经实现并受支持的 Context Map 宿主 Runtime。为 Claude Code 与 OpenAI Agents SDK 增加 Context Map 宿主 Runtime Adapter，并进一步进入 OpenCode 等开源 Agent 产品，属于 Roadmap 探索方向，不代表当前兼容性，也不构成交付时间承诺。这不否定 DeepSeek Harness 内部已经继承的 Claude Code Subagent 与 Hook 互操作能力。

我们欢迎讨论未来的 Runtime Adapter 边界，但方案必须让 Context Map 的持久状态与 Agent Runtime 保持分层，并且不能在当前 DeepSeek Harness 应用中引入第二套 Agent Loop。

## 许可证

提交贡献即表示你同意按照本仓库的 [MIT License](LICENSE) 授权相关内容。

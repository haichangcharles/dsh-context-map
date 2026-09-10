# DSH Context Map

[English](README.md) | 中文

DSH Context Map 是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、由社区独立维护的对话上下文工作区。它把 Harness 原生 Session 分支转换成可检查的 Map，让用户在长周期对话中导航不同分支，并控制哪些已完成的用户输入和模型最终输出进入下一次模型请求。

**独立社区项目。** DSH Context Map 由 [haichangcharles](https://github.com/haichangcharles) 独立维护，并非 DeepSeek 官方产品，也不由 DeepSeek AI 维护或背书。

## 增加的能力

- **Context Map** —— 在 Chat 旁边把一组相互连接的 Harness 原生 Session 显示为消息级树。
- **显式上下文控制** —— Include 或 Exclude 单条用户输入和模型最终输出，同时不改写底层 Session log。
- **上下文推荐** —— 使用快速的有限候选推荐，或主动开启读取临时完整树快照的深度检查；确认整体替换方案后一次 Apply，也可以一次 Undo。
- **Branch 推荐** —— 当一个已完成的 Q&A 更适合移动到平行 Session 时，以轻量方式询问用户是否创建原生分支。
- **单节点 Archive** —— 使用确定性的占位内容隐藏过时语义，同时保留节点、边、原始事件和恢复路径。
- **Prompt Dashboard** —— 为 Context、Archive 和 Branch 推荐器追加 Profile 级规则，也可以在显式解锁后完整覆盖基础 Prompt。
- **Harness 原生兼容** —— 继续使用 DeepSeek Harness 已有的 agent loop、工具、模型路由、Session 持久化、Fork、Compiler hook 和 Web UI slot。

Context Map 为每个成功 Turn 保存一个最初用户输入节点和一个最终可见的模型输出节点。Reasoning、工具调用、工具结果、上下文注入、中间模型步骤和未完成输出不会进入 Map。

<a id="run"></a>
## 运行

<a id="run-from-source"></a>
### 从源码运行

安装受支持的 Node.js 版本和 pnpm，然后运行：

```sh
git clone https://github.com/haichangcharles/dsh-context-map.git
cd dsh-context-map
pnpm install
pnpm run build
pnpm dsh web
```

Web UI 默认启动在 `http://127.0.0.1:3080`。运行时密钥沿用 DeepSeek Harness 的配置机制；不要把任何模型服务商密钥提交到仓库。

## 架构与上游更新

### 当前 Runtime 支持

DeepSeek Harness 是当前版本唯一已经实现并受支持的 Context Map 宿主 Runtime。Contextify 负责持久消息图和 Context Compiler 行为，Web 插件负责可视化与交互。本项目不会引入第二套 agent loop，也不会从浏览器直接调用模型服务商。

### 已有 Session 数据

官方迁移链不接受本分支格式 v0 中的 `context/compiler*` 和 `contextify/*` 事件。后续格式迁移还会改变事件序号，因此不能在缺少跨 Session 引用迁移的情况下直接放行这些记录。支持完整 Session 家族的迁移实现前，已有 Context Map 数据应继续使用旧 Runtime；请在独立的配置和 Session 目录中验证本次升级。此分支不会修改已有数据目录。

### Roadmap：可移植的上下文基础设施

后续将为 Claude Code 与 OpenAI Agents SDK 增加 Context Map 宿主 Runtime Adapter，并进一步探索把同一套持久上下文映射能力应用到 OpenCode 等开源 Agent 产品中。这些 Adapter 属于 Roadmap，并非当前版本已经提供的功能。DeepSeek Harness 已经继承的 Claude Code Subagent 与 Hook 互操作，是底层 Harness 的另一项能力。

内部 `@deepseek-ai/*` 包名会继续保留，以兼容上游 Workspace 和模块图。这些名称说明底层 Runtime 包的来源，并不代表 DSH Context Map 是 DeepSeek 官方发行版。

开发仓库应使用以下 Remote：

```sh
git remote -v
# origin    https://github.com/haichangcharles/dsh-context-map.git
# upstream  https://github.com/deepseek-ai/deepseek-harness.git
```

此次同步以官方 `aa8262ec091698bae9a6b04773a6b5b06ad4aef2`（2026-09-10，包版本 `0.1.5-rc.1`）为目标，替换原来的 `0.1.0-rc.8` 基线。后续更新仍应在专用分支合并经过确认的 Tag 或 Commit：

```sh
git fetch upstream --tags
git switch -c codex/sync-dsh-2026-09-10 master
git merge --no-ff aa8262ec091698bae9a6b04773a6b5b06ad4aef2
pnpm run typecheck
pnpm run build
pnpm run doc-sync
```

只在最小的 Contextify 接入位置解决冲突，不要在上游同步分支中混入产品功能。完整维护约定见[项目身份设计](docs/plans/2026-09-07-dsh-context-map-project-identity-design.zh.md)。

## 开发

建议先阅读 [DeepSeek Harness 架构文档](docs/architecture.zh.md)、[Contextify 包说明](packages/context/contextify/README.zh.md)和 [Context Map UI 包说明](packages/client/ui-contextify/README.zh.md)。参与仓库开发时必须遵循 [AGENTS.md](AGENTS.md)。

常用检查：

```sh
pnpm run test:gui
pnpm run typecheck
pnpm run build
pnpm run doc-sync
```

## 生态关系

本仓库使用 DeepSeek Harness 贡献指南建议的 [`dsh-plugin`](https://github.com/topics/dsh-plugin) Topic。关于 DSH Context Map 的问题和 Issue 应提交到本仓库；关于底层 Runtime 的问题应提交到 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

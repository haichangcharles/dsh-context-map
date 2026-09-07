# DSH Context Map 项目标识

[English](2026-09-07-dsh-context-map-project-identity-design.md) | 中文

## 目的

DSH Context Map 是一个基于 DeepSeek Harness、由社区独立维护的项目。其公开仓库、文档和产品界面以 DSH Context Map 作为产品标识，同时注明 DeepSeek Harness 是底层 agent 运行时。本项目不暗示由 DeepSeek AI 赞助、所有或维护。

## 公开标识

仓库以 `haichangcharles/dsh-context-map` 发布，项目名称为 **DSH Context Map**，描述聚焦于可视化、可控制的对话上下文。仓库主题包括 `dsh-plugin`、`deepseek-harness`、`context-management` 和 `conversation-visualization`，使项目在 Harness 生态中仍然容易被发现。

根 README 首先介绍独立产品、用户价值、截图或 walkthrough 入口、本仓库的安装方式以及明确的归属声明。原 Harness 文档通过链接和保留的架构文档继续提供，而不会让本仓库看起来像 DeepSeek 官方发行版。

Web UI 在浏览器标题、应用文字标识、PWA manifest 和其他产品级标签中使用 DSH Context Map 名称。模型提供方名称、DeepSeek 模型名称、上游包名称、协议标识、环境变量和对底层运行时的事实性描述保留原名。

## 兼容边界

项目继续将 DeepSeek Harness 作为唯一 agent 运行时。Contextify 扩展已记录的插件、compiler、Session、Remote 和客户端 slot 机制；它不会引入第二套 agent loop，也不会从 Web UI 调用模型提供方。

除非项目以后发布独立命名空间的包，否则现有 `@deepseek-ai/*` 工作区包名称保持不变。保留这些内部名称可以减少合并冲突、维持上游模块图不变，并将产品品牌与依赖标识区分开。

品牌相关改动集中在项目自有入口和一个小型社区品牌插件中，不会机械地重命名上游实现文件。简短且可由机器搜索的归属标记，使评审可以发现它是否被意外删除。

## 仓库拓扑

独立 GitHub 仓库是本地 `origin`。官方 `deepseek-ai/deepseek-harness` 仓库继续作为只读的 `upstream`。以前的 GitHub fork 可以保留为历史镜像，也可以在独立仓库验证后归档；它不是产品的规范 URL。

默认分支承载已发布的 DSH Context Map 代码。产品开发使用 `codex/*` 功能分支。稳定版本使用 `dsh-context-map-vX.Y.Z` 标签，使产品版本不会与上游 Harness 发布标签混淆。

## 上游更新流程

对于每个上游版本，从当前 DSH Context Map 默认分支创建 `codex/sync-deepseek-<version>`，获取 `upstream`，再合并精确的上游标签或经过评审的 commit。仅在范围最小的所属集成点解决冲突，然后验证 Contextify 包测试、Web UI 行为、类型检查、生产构建和文档链接，最后再合并同步分支。

不要在上游同步分支中开发产品功能。如果上游改动替换了 Contextify 所用的扩展点，应让插件适配新的已记录机制，而不是保留一份已经过时的上游核心代码。

预计冲突范围仅限于 Contextify 包、Web 组合包、右侧面板与消息操作使用的客户端 slot，以及产品品牌入口。上述范围以外的改动需要额外评审，因为它们会扩大长期 fork 的维护面。

## 发布检查

发布时要验证 GitHub 名称、描述、主题、默认分支、README 链接、clone 命令、浏览器标题、PWA 名称和可见文字标识都指向 DSH Context Map。还要验证归属链接指向 DeepSeek Harness 官方仓库，并且 `origin` 和 `upstream` 分别解析到预期仓库。

发布构建必须通过 Contextify 聚焦测试、Context Map 的 Web UI 回归测试、仓库类型检查、生产构建、文档同步和 `git diff --check`。任何品牌改动都不得改变 Session 持久化、Context Compiler 行为、模型路由或 Harness agent loop。

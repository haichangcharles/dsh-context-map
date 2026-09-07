# native/

[English](README.md) | 中文

与 DeepSeek Harness 代码库一同维护的原生源码与继承包约定。[`landlock-run/` workspace](landlock-run/README.md) 负责 harness 使用的 Landlock 自限后执行启动器，包括其架构、由三个包组成的 npm 包家族、平台支持、开发工作流和[兼容性流程](landlock-run/docs/release.md)。DSH Context Map 只发布源码，不发布这些继承的 npm 包。

## Workspace 与发布边界

`landlock-run/` 及其包属于仓库根 pnpm workspace，并共用根锁文件。开发和 CI 中的 harness 消费方直接使用当前 workspace 的入口包，因此启动器约定变更与消费方更新可以在同一个改动中落地并一起测试。

主仓库的 `Landlock Run` 工作流为每个受支持架构构建并测试。手动的 `Package compatibility (upstream Landlock Run)` 工作流会汇集这些原生产物并打包、验证三个 npm tarball，但不使用 Registry 凭据，也不包含发布 Job。入口包继续将平台包声明为 npm 可选依赖，因此上游形态的包排练仍只选择与用户操作系统和 CPU 匹配的包。

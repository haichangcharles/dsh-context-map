# Agent Note：发布的原生依赖使用已测试版本

Status: implemented

[English](2026-10-14-native-dependency-version.md) | 中文

## 问题

全新的 npm 消费者不继承工作区 lockfile。六个原生 Host 包声明 Koffi `^3.1.0`，而工作区 CI 解析到 `3.1.1`。打包安装 CI 解析到 `3.3.3`，在 Linux Node 24.21.0 下编译 `uv.cc` 失败：条件表达式混用了 `Napi::Value` 和 `nullptr_t`。验证器省略可选依赖，因此 Koffi 的可选平台预编译产物不可用，安装器改为从源码编译。

## 决策

六个公开运行时消费者均声明精确版本 Koffi `3.1.1`；lockfile importer 使用相同 specifier，不改变已解析的包。[发布契约回归](../../../../scripts/release/native-dependency-contract.spec.ts) 通过已有 release family 发现公开消费者，并检查发布约束等于工作区已测试的解析版本。有意升级原生依赖时必须同时更新两者。打包安装验证器及其可选依赖策略保持不变。

## 考虑过的替代方案

- **保留 caret，只固定工作区 lock。** 全新的 npm 消费者仍会解析到另一个原生安装器。
- **增加根目录 override。** 发布的 Host 包不携带工作区根目录的 override。
- **跳过安装脚本或放宽发布门禁。** 这样会留下未验证的原生加载路径。

## 后果

全新消费者保持使用已测试的原生版本。升级需要显式修改包约束并验证原生安装。这不保证所有操作系统或 Node 版本都能源码编译，也不改变 agent 行为或增加 provider 请求。

## 测试

新的公开 manifest 契约在旧 caret 下失败，六个消费者修正后通过。全新 macOS arm64 npm 消费者在 Node 24.19.0 下使用标准可选预编译产物安装并加载 Koffi `3.1.1`。省略可选依赖的本地探针因缺少 CMake 而停止；Linux 源码安装仍由未修改的打包安装 CI 门禁负责。离线 pnpm 元数据验证也需要本机缓存中缺失的 registry 元数据；其供应链策略保持不变。lockfile 仅改变六处 Koffi specifier。

## 相关内容

- [官方 3.1.1 元数据](https://registry.npmjs.org/koffi/3.1.1) 与 [3.3.3 元数据](https://registry.npmjs.org/koffi/3.3.3) 将平台预编译产物声明为可选依赖。
- [发布序列决策](../process/2026-08-10-npm-release-sequences.zh.md) 与[发布依赖所有权](../process/2026-08-26-published-dependency-faces.zh.md) 保留各自的发布和依赖 identity 理由；本决策不取代两者。

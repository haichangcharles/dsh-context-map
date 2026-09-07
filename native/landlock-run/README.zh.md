# @deepseek-ai/node-addon-landlock-run

[English](README.md) | 中文

一个 [Landlock](https://landlock.io/)「先限制自身、再执行」启动器，用于在 Linux 上限制子进程。上游 DeepSeek Harness 以按平台预构建的 npm 包和轻量 JS 入口包分发它；DSH Context Map 保留该包约定用于源码构建兼容性，但不会发布继承的 `@deepseek-ai/*` 包。

该工具是 **`landlock-run`**：一个「先限制自身、再执行」的 [Landlock](https://landlock.io/) 启动器（基于原始内核 UAPI 编写，约 300 行 C11，并与 musl 静态链接）。它在自身上安装 Landlock 规则集，再 `exec` 被包装的命令；该规则集会跨 `execve` 继承，因此命令及其产生的每个进程都在限制下运行，调用进程仍不受限制。它采用失败闭合：如果内核无法强制执行，则不运行命令并直接退出。

## 上游包约定

```sh
npm install @deepseek-ai/node-addon-landlock-run
```

上游包族由一个入口包和可选平台包组成：

```text
@deepseek-ai/node-addon-landlock-run
@deepseek-ai/node-addon-landlock-run-linux-x64
@deepseek-ai/node-addon-landlock-run-linux-arm64
```

npm 的 `os`/`cpu` 字段使安装器只拉取匹配的平台包。系统有意不提供安装时构建回退：在没有对应平台包的宿主上，解析后的路径绝不存在，探测会报告 `unusable`，消费方以失败闭合方式处理。

## 用法

```js
import { grantArgs, launcherPath, probe } from '@deepseek-ai/node-addon-landlock-run';

const launcher = launcherPath();
if (probe(launcher) !== 'unusable') {
  const argv = [launcher, ...grantArgs({ readOnly: ['/'], readWrite: ['/tmp/work'] }), '--', 'bash', '-c', command];
  // spawn argv with your process runner of choice
}
```

公开 API 有意保持精简：

- `launcherPath()`：当前宿主启动器的绝对路径（有意不检查是否存在；探测结果才是可用性信号）。
- `probe(launcher?, { timeoutMs? })`：功能性强制执行探测，返回 `'full' | 'partial' | 'unusable'`。
- `grantArgs({ readOnly?, readWrite? })`：启动器的授权 argv；未授予的一切都被拒绝。
- `LAUNCHER_BIN` 和 `LAUNCHER_FAILURE_EXIT`（125）：约定常量。成功完成 exec 的子进程也可能返回 125，因此消费方必须同时看到致命诊断和该状态，才能将结果归因为启动器失败。

完整的二进制约定（argv 语法、退出码、报告行）锁定在 [docs/cli-contract.md](docs/cli-contract.md) 中。

## 支持范围

支持 linux-x64 和 linux-arm64，且内核已启用 Landlock（5.13+；ABI 级别决定强制执行为 `full` 还是 `partial`，详见 [docs/support-matrix.md](docs/support-matrix.md)）。其他平台有意不提供对应包：消费方会在这些平台上运行其他限制后端。

## 开发

```sh
corepack enable
pnpm install
pnpm build:ts        # entry packages → lib/
pnpm build:native    # this Linux architecture's binaries (apt-get install musl-tools)
pnpm test
```

二进制文件被 git 忽略，并且按架构原生构建：本地构建当前机器版本，兼容性 CI 则在所选 runner 上构建。继承的包排练详见 [docs/release.md](docs/release.md)；本仓库支持的发布渠道仅为源码发布。

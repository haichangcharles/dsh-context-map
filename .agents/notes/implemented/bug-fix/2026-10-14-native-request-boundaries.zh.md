# Agent Note：明确原生请求边界

Status: implemented

[English](2026-10-14-native-request-boundaries.md) | 中文

## Problem

覆盖率门禁发现 compiler、sandbox 和最终 dispatch 的部分公开边界缺少测试。Agent compiler 还在异步路由准备之后读取可变 phase 的坐标，并保留了唯一私有调用方不可能使用的零值回退。

## Decision

已经准入的 Agent step 把捕获的 turn 和 step 传给请求构造。running phase 检查、取消检查和缺失 compiler 的拒绝保持不变。原生回归通过本地 HTTP fixture 验证 JavaScript compiler 的异常输出、空原生 assistant 消息、注册释放、缺失的持久 compiler 插件、sandbox policy 和 runner 诊断，以及同步 dispatch 授权。

Deep snapshot 通过原生 `mkdtemp` 原子创建私有目录，删除重复的 POSIX `chmod`。[libuv 调用原生 mkdtemp](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/fs.c)，[glibc 以仅拥有者权限创建目录](https://github.com/bminor/glibc/blob/master/sysdeps/posix/tempname.c)。更严格的 umask 可以继续限制拥有者权限，系统尊重这个选择；snapshot 文件保留 `0600` 创建和真实 POSIX 权限断言。Windows 保留原生临时目录行为，不把 POSIX 位宣称为 ACL 保护。

## Alternatives considered

- **忽略未覆盖分支。** 这会让公开失败行为缺少验证。
- **操纵 Agent 私有 phase。** 这种 fixture 违反已经准入的 step 合约。
- **放宽最终 dispatch 返回值验证。** 异步回调会在 dispatch 之前重新打开 context 编辑窗口。

## Consequences

Compiler selection 与路由准备、原生 step 事件使用同一组执行坐标。无效公开输入仍在 dispatch 之前失败。这些无密钥测试使用本地 mock server，证明请求边界行为，不证明模型质量或研究结果。

## Testing

完整 compiler、Agent-loop、search tool 和 DeepSeek 测试共 985 项全部通过，四个负责的源文件覆盖率均为 100%。未经修改的 surface compiler 在原生请求 header 上保持透明。取消用例验证公开 ABORTED 错误保留原始 cause，且不发送请求。Sandbox 用例使用真实原生 Session 完成 policy 投影。真实 PTY 不覆盖 host platform 即可正常结束并交付输出。公开 PowerShell executor fixture 使用受控 subprocess outcome 区分 foreground timeout 和上游取消。本地 shell 测试通过 368 项，另有 39 项沿用平台跳过；Bash 和 subprocess 源文件覆盖率为 100%。本地 host 没有 PowerShell，因此既有覆盖率豁免使我们不能声称本地已测得完整 PowerShell 源码覆盖率。

## Related

- [Agent 请求组装](../../../../packages/core/agent-loop/src/agent.ts)
- [Compiler 回归](../../../../packages/context/context-compiler/tests/registry.spec.ts)
- [DeepSeek dispatch 回归](../../../../packages/llm/llm-deepseek/tests/adapter.spec.ts)

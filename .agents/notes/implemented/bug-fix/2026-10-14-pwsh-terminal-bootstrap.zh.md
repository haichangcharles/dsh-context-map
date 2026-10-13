# Agent Note：在拥有的提示符就绪后发布 PowerShell 终端

Status: implemented

[English](2026-10-14-pwsh-terminal-bootstrap.md) | 中文

## Problem

PowerShell 终端启动用上一次 viewport 的长度决定是否提交编码和提示符初始化。一次空白的静默结算会重复提交初始化。Backend stdin-read 结果也可能在受控提示符安装完成前发布空 viewport 或原有 PowerShell 提示符。Linux CI 暴露了这两类调度；一份输出包含重复的初始化源代码。

## Decision

启动单独记录提交状态，初始化只写入一次。只有 stdin-read 就绪且既有 parser 已观察到拥有的 OSC marker 和准确的受控提示符，才发布终端。LocalPtySession 用只读 getter 暴露这两个 parser 事实。空白的启动观察 continuation 在静默结算后保留部分拥有的提示符证据；任何实际输入或提交即使请求 continuation 也会重置证据。普通 send、取消、启动的绝对 deadline 和环境密钥清理合约保持不变。

## Alternatives considered

- **增加启动超时。** 更多时间无法识别是哪个提示符产生 stdin-read 就绪。
- **接受含提示符字面量的源代码。** 初始化回显含同一字面量，却不能证明初始化已经执行。
- **等待任何非空输出。** 原有 PowerShell 提示符非空，也仍早于初始化。

## Consequences

发布的终端已到达自己的提示符，而不是较早的 shell 输入等待。空白和初始化回显不能再次触发初始化提交。这不把提示符文本当作一般命令完成证明；foreground 检查仍是 stdin-read 的权威。真实 PowerShell 的持久状态和密钥清理断言保持原样，必须在已安装 PowerShell 的 host 上验证。

## Testing

Backend 回归涵盖空白 inferred-idle、空白 stdin-read、原有 PowerShell stdin-read 和初始化回显。修复前有三例失败，修复后通过。原生 parser 测试保留分段 marker 行为，验证 marker 之前、prompt 文本之前均未就绪，两者完整后就绪。公共 terminal fixture 上的真实 session 还涵盖拥有的 marker 到达后、prompt 文本跨静默 bridge 才到达的情况。保留 continuation 证据前失败，修复后通过。输入和提交用例仍清除先前证据。完整 index 和 session 测试共 75 项通过。

## Related

- [启动编排](../../../../packages/terminal/terminal-bash/src/index.ts)
- [拥有的提示符证据](../../../../packages/terminal/terminal-bash/src/session.ts)
- [真实终端回归](../../../../packages/terminal/terminal-bash/tests/local.spec.ts)

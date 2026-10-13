# Agent Note：在拥有的提示符就绪后发布 PowerShell 终端

Status: implemented

[English](2026-10-14-pwsh-terminal-bootstrap.md) | 中文

## Problem

PowerShell 终端启动用上一次 viewport 的长度决定是否提交编码和提示符初始化。一次空白的静默结算会重复提交初始化。Backend stdin-read 结果也可能在受控提示符安装完成前发布空 viewport 或原有 PowerShell 提示符。Linux CI 暴露了这两类调度；一份输出包含重复的初始化源代码。之后的仅失败时原生诊断定位到了更早的边界：初始化写入发生在初始 cursor-position reply 之前，此后只有初始化回显，虽有原生 stdin 等待却没有任何拥有的 marker。提交初始化时，初始控制台协商尚未完成。

## Decision

PowerShell 启动先等待非空初始输出、terminal protocol reply 全部 drain，以及原生 stdin-read 就绪；精确 stdin 等待能力受支持或未知时，静默不能结束这个初始阶段。前台事实新增可选的 `stdinWaitSupported`，由真实 inspector 与 ABI 提供，而不是消费方猜测宿主 OS。明确不支持的 macOS、Windows、不支持的 Linux ABI 与 E2B 仅在初始阶段保留非空输出、已 drain 协议与静默路径。单次 `inputWaiting` 为 false 不代表缺少能力；最终发布始终要求拥有的 marker 与准确提示符。随后单独记录提交状态，初始化只写入一次。只有 stdin-read 就绪且既有 parser 已观察到拥有的 OSC marker 和准确的受控提示符，才发布终端。LocalPtySession 用只读 getter 暴露这两个 parser 事实。空白的启动观察 continuation 在静默结算后保留部分拥有的提示符证据；任何实际输入或提交即使请求 continuation 也会重置证据。空白观察没有提交输入，所以不必先离开已经存在的 stdin 等待。实际输入和提交仍必须建立自己的写入后就绪。取消和环境密钥清理合约保持不变。同一个绝对启动 deadline 同时覆盖初始控制台就绪与受控提示符安装；两个阶段不会各自重新获得完整超时。

## Alternatives considered

- **增加启动超时。** 更多时间无法识别是哪个提示符产生 stdin-read 就绪。
- **接受含提示符字面量的源代码。** 初始化回显含同一字面量，却不能证明初始化已经执行。
- **等待任何非空输出。** 原有 PowerShell 提示符非空，也仍早于初始化。

## Consequences

发布的终端已到达自己的提示符，而不是较早的 shell 输入等待。空白和初始化回显不能再次触发初始化提交。这不把提示符文本当作一般命令完成证明；foreground 检查仍是 stdin-read 的权威。真实 PowerShell 的持久状态和密钥清理断言保持原样，必须在已安装 PowerShell 的 host 上验证。

## Testing

Backend 回归涵盖空白 inferred-idle、空白 stdin-read、原有 PowerShell stdin-read 和初始化回显。修复前有三例失败，修复后通过。原生 parser 测试保留分段 marker 行为，验证 marker 之前、prompt 文本之前均未就绪，两者完整后就绪。公共 terminal fixture 上的真实 session 还涵盖拥有的 marker 到达后、prompt 文本跨静默 bridge 才到达的情况。保留 continuation 证据前失败，修复后通过。输入和提交用例仍清除先前证据。公共 terminal fixture 重现了原生调度：过早输入只回显而不执行初始化；延迟的 cursor-position reply 必须先 drain；原有控制台报告 stdin 就绪前不得提交初始化。该回归在两阶段修复前失败、修复后通过。共享 deadline 测试在初始阶段使用 80 ms，在 100 ms 总限额内只留剩余 20 ms 给初始化重试。空白观察可以结束已有等待；独立的实际命令回归仍要求离开并重新进入等待。同一个公共 fixture 覆盖受支持、显式不支持与未知能力，不修改宿主平台。原生 inspector 与 PTY 测试验证能力识别及转发；mock E2B 测试保留显式不支持合约。本地全部 99 项适用终端测试通过，四项依赖已安装 PowerShell 的测试跳过；两个修改源文件的 statement、branch、function、line 覆盖均为 100%。仍须真实 Linux PowerShell 验证才能宣称原生故障已解决。

## Related

- [启动编排](../../../../packages/terminal/terminal-bash/src/index.ts)
- [拥有的提示符证据](../../../../packages/terminal/terminal-bash/src/session.ts)
- [真实终端回归](../../../../packages/terminal/terminal-bash/tests/local.spec.ts)

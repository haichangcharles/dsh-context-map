# Agent Note：观察真实 fixture 命令完成

Status: implemented

[English](2026-10-14-codex-fixture-command-completion.md) | 中文

## Problem

可选 Codex adapter 的隔离 bypass 测试使用固定的 localhost 响应脚本：请求文件系统写入，然后回答工作完成。真实 Windows Codex 在 10.0133 秒后返回 `exec_command` 结果，命令仍有运行中的 session，且没有输出。脚本在命令还在运行时立即回答完成，导致真实文件存在断言失败。断言诊断也打印了包含无关 developer instructions 的整个请求历史。

## Decision

私有 Responses fixture 在保留既有固定脚本的同时，支持根据当前请求选择行为。隔离命令脚本只读取最近的 `function_call_output`。真实的运行中 session 结果会选择已 advertised 的 `write_stdin`，使用实际 session id、空输入和默认 yield。只有成功的进程退出结果才能触发最终回答。既有的同一个 60 秒测试 deadline 包含启动与每次 continuation。诊断只保留最近的工具输出。

## Alternatives considered

- **增加工具 yield 或测试超时。** 运行中的 session 是合法工具结果，仍需要显式观察。
- **忽略缺失文件或合成成功。** 这会去掉真实产品测试所验证的权限和文件系统行为。
- **修改 Windows shell 命令。** 捕获结果表明命令在运行，而不是路径或 shell 错误；没有证据支持修改产品或命令。

## Consequences

测试仍通过 localhost 模型 stub 与隔离临时工作目录运行真实 binary。文件存在、准确内容、选定权限和整个进程范围完全停稳，仍保持真实断言。Adapter 仍是可选组件；本次不改变 ContextMap agent runtime、模型提供方、shell 配置或产品权限策略。仍须实际 Windows 重跑才能确认所观察到的原生故障已解决。

## Testing

七项私有 fixture 用例覆盖重复的运行中 session continuation、具有误导性的较早输出与 developer 文本、缺失或失败输出、不安全的 session id、不变的绝对 deadline，以及根据 localhost 当前请求序列化响应。七项真实产品用例也在本地通过，包括隔离写入和默认权限拒绝：共 14 项测试通过。三个修改的测试文件通过 lint 与空白检查。

## Related

- [私有响应 fixture](../../../../packages/subagent/subagent-codex/tests/responses-fixture.ts)
- [真实产品权限与文件系统测试](../../../../packages/subagent/subagent-codex/tests/real-product.spec.ts)
- [Continuation 回归](../../../../packages/subagent/subagent-codex/tests/responses-fixture.spec.ts)

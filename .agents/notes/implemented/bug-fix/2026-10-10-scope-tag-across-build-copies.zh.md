# Agent Note：跨构建副本共享作用域标签

Status: implemented

[English](2026-10-10-scope-tag-across-build-copies.md) | 中文

## Problem

研究工作目录可能在同一进程里加载 `dsh-scope` 的源码和构建产物。两个副本以前分别创建 `Symbol('dsh.scope')`，因此一个副本创建的 child context 在另一个副本的注册表看来没有作用域。带作用域的 prompt 被登记到全局层，创建第二个 worker 时就因重复登记 `subagent:delegation` 而失败。既有的 system-prompt 作用域测试也随之失败。

## Decision

上下文标签改用 `Symbol.for('dsh.scope')`。不同模块副本共享标签，而每个作用域仍保留各自不透明的 key 对象。新增回归测试：由构建包创建作用域，再由源码模块读取。

## Alternatives considered

- **保留模块局部 Symbol，并要求解析器只加载一个副本**——工具同时加载源码与构建产物时很脆弱。
- **只给 child prompt 登记做特判**——会掩盖更广泛的注册表作用域不一致。

## Consequences

13 个 system-prompt 作用域测试、原生多 worker Web 回放及新增跨副本测试均恢复通过。这个修复只解决上下文标签识别；父链和载体记录仍属于模块局部状态，生产构建仍应使用同一个包实例。

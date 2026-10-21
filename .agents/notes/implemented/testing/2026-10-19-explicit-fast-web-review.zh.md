# Agent Note: 显式选择Fast的Web审查替身

Status: implemented

[English](2026-10-19-explicit-fast-web-review.md) | 中文

## Problem

组装后的Web偏好测试名为Fast建议路径，却省略模式参数；Host默认使用Local。共用候选构建器掩盖了这一错配，独立Local候选准入使候选集合不同，导致最后一条Web来源的预期失败。

## Decision

[所属测试](../../../../apps/web/tests/research-contextify-web-evidence.e2e.ts)显式选择Fast，并断言返回模式及工程替身适配器恰好收到一次请求。预期来源的Exclude、批准前Plan不变、批准后编译Context的断言均保留。不联系模型服务；Local行为和Fast候选准入均不改变。

## Alternatives considered

修改预期来源或快照会继续以Fast测试名验证Local；修改Host默认值或候选排序会为测试设置错误改变产品行为。选择文档规定的模式直接修复错配的所属位置。

## Consequences

省略模式会使模式/请求断言失败，不能再偶然通过另一条路径。未修改的原案例已复现CI来源错配；修复后的聚焦案例检查真正的有界分类器和偏好校准。这是集成测试修复，不是模型准确率提升的证据。

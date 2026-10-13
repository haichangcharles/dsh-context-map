# Agent Note: 回放当前工具 guard 说明

Status: implemented

[English](2026-10-14-guard-description-replay.md) | 中文

## 问题

无需密钥的 headless CI 回放只有 `cordis-inspect-jsdoc` 场景失败。当前 format-v3 的 Session 预期仍包含旧的 `tools.guard` 说明，而源码与生成的 Cordis API 目录已经正确记录了派发前的第二次检查。该检查保护排队期间或异步执行包装中权限状态发生变化的工具。

## 决策

只更新[当前 format-v3 Session 预期](../../../../snapshots/session/cordis-inspect-jsdoc/session.v3.jsonl)中的该方法说明。保留历史 format-v2 数据、模型录制、事件标识、工具 schema 和其余全部预期字段。继续严格比较完整 Session 并验证请求头。不删除 guard，也不通过忽略 API 说明来满足回放。

## 验证

远端失败的准确 diff 只有 guard 说明。预期文字与[源码 JSDoc](../../../../packages/core/tools/src/index.ts)及[生成的 API 目录](../../../../packages/extensions/tool-cordis/src/api-catalog.ts)一致。在没有 provider 凭证的环境中重新运行对应录制场景；结果记入项目验收报告。

## 考虑过的替代方案

**删除第二次 guard 检查。** 这会重新允许过期权限，并违背已有的派发回归检查。

**在回放时忽略说明文字。** 这会掩盖未来的 API 目录漂移。只匹配确实改变的一项说明，保留了更强的预期比较。

## 后果

当前回放预期符合已记录的派发契约。历史日志与模型脚本保持原状；这是预期输出中的说明修正，不是 Session 格式迁移。

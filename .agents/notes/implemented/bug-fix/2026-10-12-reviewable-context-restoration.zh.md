# Agent Note：暂缓 Context 的待确认恢复

Status: implemented

[English](2026-10-12-reviewable-context-restoration.md) | 中文

## Problem

在长对话中，用户可能接受 Agent 的建议，先排除一条旧来源以处理其他阶段，随后又回到需要它的任务。Context Plan 正确保留了 Exclude，但建议校验器把这种暂时排除等同于用户直接设下的禁令。即使当前任务需要该来源，Include 建议也无法进入审核；个性化校准还可能强化先前的暂缓选择。

## Decision

Contextify 从原生 Session 事件中重建每条当前已排除来源的最新修改。只有当标记为 Client 的审核接受了针对该来源的 Agent 建议，且对应的审核事件紧跟其 Plan 修改记录，后续 Include 才有资格成为待确认建议。有界 Fast 数据包将这类节点标记为 `reviewableExcluded`；校验器允许针对它提出 Include，个性化校准也不会因为旧的排除而压制同一来源的恢复。用户直接执行的 Exclude、已归档的替换，以及没有这类审核来源的节点仍受保护。只有用户接受新建议后，Plan 才会改变。

## Alternatives considered

- **把所有 Exclude 都视为 Agent 不得再提议恢复。** 暂缓任务回流时会丢失必要来源。
- **允许 Agent 反转所有 Exclude。** 这会混淆用户直接设下的边界与经确认的暂时建议。
- **任务词项重合时自动恢复。** 词面重合无法证明用户同意，也无法判断旧约束是否仍然有效。

## Consequences

Agent 可以管理暂缓 Context 的生命周期，同时不覆盖用户直接选择。恢复资格来自日志中标记为 Client 的审核来源，而非模型文本推断；这一标记不能认证人类身份，也不能证明用户看过审核单。来源仍须被候选路由找到，且分类器仍须提出 Include；服务回归证明用户接受的恢复会进入下一轮编译请求，并未证明系统能自动识别所有长对话中的任务回流。

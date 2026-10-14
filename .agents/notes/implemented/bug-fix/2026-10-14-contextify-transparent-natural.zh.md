# Agent Note: 透明 Natural Context 与 preset 作用域 Branch 工具

Status: implemented

[English](2026-10-14-contextify-transparent-natural.md) | 中文

## 问题

用户尚未编辑 Context 时，打开普通 Web 对话不应改变其请求历史。Host 注册的 Branch 工具还会进入 minimal preset；该 preset 的模型约定是固定提示词和一个持久 shell。该工具也会进入 preset 系统刻意保持为空的全局目录。

## 决策

Contextify 用脱离日志的 Natural Plan 投影未经编辑的 Session。Agent 启动和 graph 读取不追加 Plan 或 compiler 选择。第一次提交 Context 编辑时，系统记录初始 Undo 状态和编辑后的 Plan，并把 surface compiler 切换为 Contextify。已记录 Plan 仍可恢复，原生 child 会重置继承的已记录 Plan。显式挂载的 lineage runtime 可以升级新 surface Session；已有 assistant 历史但缺少 read set 的 Session 保留当前 compiler。

可选的 `@deepseek-ai/dsh-contextify/branch-tool` consumer 在所属 preset 的作用域中注册 `request_context_branch`。Standard、cordis 和 PTC 会挂载它，minimal 不会。其 `enabled` 配置默认 true；Host 未提供 Contextify service 时，它不注册工具。该工具仍调用同一个经过校验、绑定 direct human Turn 的请求操作，只安排确认，不创建分支。

## 考虑过的替代方案

**全局注册并更新所有 preset 的期望。** 这会让 minimal 的模型约定依赖不相关的 Host service，绕过 preset 对模型工具的所有权。

**在历史浏览器回放中禁用 Contextify。** 这会让测试无法观测实际 graph 和 compiler 行为。透明 Natural 启动允许原始模型响应和持久日志继续作为判定依据；独立固定的当前工具 schema 可以明确加入新 consumer。

**从回放比较中过滤 Plan 和 compiler 事件。** 这些事件决定后续请求的选择，normalizer 不能丢弃它们。

## 后果

普通 Natural 对话保留原始 surface 请求和事件序号。第一次显式 Context 编辑承担少量持久初始化开销，使 Undo 能重建初始状态。从未编辑的 fork 保留虚拟的 revision-one Plan，不记录未使用的重置。模型工具需要 preset 显式挂载，Host service 仍提供 Context graph 与 Client controls。

## 测试

原生测试覆盖启动和 graph 读取不改变日志、作用域目录隔离、缺少 Host 或禁用 consumer、作用域销毁、有效 Branch 请求、第一次编辑的历史、child reset 及可选 lineage 接纳。浏览器回放保留已提交的模型录制，精确比较其持久 Session 输出。

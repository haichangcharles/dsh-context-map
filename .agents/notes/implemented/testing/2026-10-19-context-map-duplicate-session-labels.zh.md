# Agent Note: Context Map同名Session夹具

Status: implemented

[English](2026-10-19-context-map-duplicate-session-labels.md) | 中文

## Problem

父、子工作区行可能具有同名标题。组装后的Context Map测试按标题全局定位父菜单，分支标题回显的中间状态会匹配两行，在执行归档前失败。显示顺序和生成标题不能标识原生父Session。

## Decision

[所属回放](../../../../apps/web/tests/contextify-map.e2e.ts)先观察原生子Session生命周期条目为Active，再刻意赋予其与父行相同的显示标题；父归档过程中保留两个同名菜单。父菜单限定在未选中的Session行，当前子行仍为选中状态。测试验证动作前仅一个匹配父行、归档注册表包含准确的原生父ID但不包含子ID、父行消失且仍保留一个同名子菜单。原有编译Context、批准、Undo和重载断言不变。

## Alternatives considered

选择第一个匹配依赖工作区顺序；分别重命名夹具或等待自动标题后缀会绕开同名情况。仅为此测试新增生产DOM标识会扩大发布约定；在这个双Session场景中，已有原生生命周期与选中状态足以区分两个角色。

## Consequences

该碰撞可确定性复现，限定范围前会产生原来的严格定位失败。没有新增睡眠、重试、延长超时、替换快照、产品行为或模型调用。设置标题是工程夹具准备，不是偏好证据或模型决策。

# Agent Note: DeepSeek 最终发送授权

Status: implemented

[English](2026-09-28-deepseek-final-dispatch-authorization.md) | 中文

## Problem

在 DeepSeek 适配器运行前检查 `GenerateOptions`，无法识别最终发送给提供方的确切 JSON。适配器默认值、图片表示和请求扩展都可能改变该 JSON。异步请求准备还允许人在早期准入与 `fetch` 之间编辑上下文。

## Decision

直接创建 `DeepSeekAdapter` 的消费者可以提供 `authorizeDispatch`。适配器在生成完整 chat JSON 载荷之后、每次 `fetch` 之前同步调用它。回调接收载荷、session id、purpose 和中止信号，但不接收标头或凭据。抛错或返回任何值（包括 Promise）都会以 `REQUEST_NOT_AUTHORIZED` 停止发送。成功授权与 `fetch` 之间没有 `await`。随产品交付的插件默认不安装策略。

## Alternatives considered

**适配器之前的请求检查。** 它无法证明最终提供方请求体，也可能在异步准备期间过期。

**异步最终回调。** 等待结果会在发送前产生新的编辑间隙；忽略 Promise 则会在授权完成前发送。同步回调加运行时返回值校验避免这两种情况。

**只拦截 `fetch`。** 它能在测试中展示风险，却没有为直接创建适配器的消费者提供明确的授权点。

## Consequences

DeepSeek 官方 chat-completion 路由具备确切载荷的授权点。原生双子 Agent 测试显示，它能拒绝已排除来源并保留干净的独立请求，也能发现其他方面可准入的子 Agent 从环境指令夹带已排除来源。后一种情况会拒绝子 Agent，而不会修复其输入。回调尚未作为 Contextify 默认策略接线，不覆盖 PiAi SDK 路由，也无法撤销 chat 序列化前发生的 Files API 上传。合成哨兵测试不能证明语义不干扰或任务质量提升。

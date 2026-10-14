# Agent Note: 在 CI 中对外部 DeepSeek API 运行真实 API e2e

Status: implemented

[English](2026-06-19-real-api-e2e-ci.md) | 中文

## 问题

无密钥回放不能证明真实提供方行为。[ACP inject 事故复盘](../../../../docs/postmortem/0001-acp-default-export-drops-inject.zh.md)展示了单元测试未发现的产品故障。真实套件通过模型调用、工具执行、多轮对话、恢复和取消驱动已交付 profile，而无凭证贡献者需要独立覆盖。

## 决策

[e2e.yml](../../../../.github/workflows/e2e.yml)中的显式真实 job 在产物构建后通过 Node 24 对外部 DeepSeek API 运行 `test:e2e`。[CI 预算决策](2026-10-13-explicit-ci-api-budget.zh.md)负责触发规则并推翻自动模型消费；普通事件运行录制会话与浏览器回放。真实验证限制 worker 数量、重试次数和超时，预检拒绝空凭证，不接受全部跳过的套件。[取消策略](../process/2026-09-09-cancel-superseded-ci.zh.md)取消同一工作流/ref 上被新运行取代的验证。

### 凭证隔离

仓库密钥 `DEEPSEEK_API_KEY_EXTERNAL` 只在预检和真实测试步骤中映射为 `DEEPSEEK_API_KEY`。Checkout、设置、安装和普通 CI 不会收到它。`contents: read` 限制 token 权限，`DEEPSEEK_BASE_URL=https://api.deepseek.com` 固定被测提供方。预检只打印凭证是否存在，不打印值或长度。

### 信任

绝不通过 `pull_request_target` 让不受信任的 PR 代码使用基础仓库密钥。手动 dispatch 显式选择并授权仓库 ref；有写权限的用户能够修改工作流，仍属于密钥信任范围。公开仓库可见性不授权自动暴露凭证。密钥处理、仓库写权限及 environment reviewer 控制仍是运维职责。

## 考虑过的替代方案

**不预检就运行真实套件。** 缺少密钥时套件会自行跳过，绿色结果将掩盖缺失的覆盖。

**在安装或普通无密钥 CI 中暴露凭证。** 依赖钩子和每次自动运行都会收到不需要的能力。步骤局部凭证与显式真实 dispatch 保持两者的范围分离。

## 后果

模型质量证据需要已授权的真实运行；普通 CI 验证已保存的执行与产品行为。凭证只有一处由仓库负责的映射，密钥配置错误会明确失败。自动触发策略独立保存在预算决策中，因此凭证卫生不代表允许消费。

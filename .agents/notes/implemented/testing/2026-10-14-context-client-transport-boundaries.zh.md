# Agent Note：Context Client transport 与回调边界

Status: implemented

[English](2026-10-14-context-client-transport-boundaries.md) | 中文

## 问题

浏览器交互测试通过，并不意味着已经覆盖 Context Client 的许多 transport 失败和注册回调。严格的 Linux 覆盖率报告暴露了取消、迟到审核结果、编辑器转移守卫和偏好操作的验证缺口。失败或过期的请求不能修改 Context，也不能清掉较新的审核。

## 决策

公开控制器测试验证分页图读取、轮询所有权、重叠写入、修改失败、过期 proposal、明确拒绝项、归档，以及迟到的取消和关闭结果。浏览器插件测试挂载真实 Cordis SlotRegistry，在确定性 Remote fixture 上调用注册的操作接口。它们验证精确 Session 所有权、Profile 设置注册、草稿 identity、原生分支边界，以及操作被拒绝后没有修改。Remote 错误使用协议真实的失败类。

控制器保留全部公开失败守卫。已加载值守卫同时用于初次视图准入，以及 ready 审核所需的图。初次加载失败时总会发布错误，因此移除了不可达的兜底错误字符串。Refresh 对其唯一任务去重，没有第二个发布者；该任务无条件清理自己的 in-flight 引用。没有新增依赖、轮询间隔变化、proposal 验证规则变化或模型请求。

## 考虑过的替代方案

- **将浏览器验收当成完整覆盖。** 这样会漏掉 transport 失败和临时状态所有权竞态。
- **Mock 控制器私有状态。** 这样的状态绕过了需要验证的准入路径。
- **降低覆盖率门槛或忽略分支。** 严格门禁保持不变。

## 后果

测试通过公开方法检查控制器，通过已注册的服务回调检查插件。它们验证本地 Client 契约，不验证 provider 质量或真实用户个性化。[已审阅操作决策](../feature/2026-10-13-context-steward-reviewed-actions.zh.md) 继续负责产品流程与性能证据；本记录不取代它。

## 测试

三个所属测试文件通过 79 个 keyless 测试。控制器与 Client assembly 在定向报告中的 statements、branches、functions、lines 分别达到 100%。整个 UI 包和完整 Linux 测试还有各自的待完成门禁；这份证据不声称它们已经通过。

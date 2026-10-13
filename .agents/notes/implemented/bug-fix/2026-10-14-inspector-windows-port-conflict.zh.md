# Agent Note：重试 Windows Inspector 端口绑定冲突

Status: implemented

[English](2026-10-14-inspector-windows-port-conflict.md) | 中文

## 问题

原生 Windows CI 测试保留了一个已占用的起始端口，但 Inspector 报出 `listen EACCES: permission denied 127.0.0.1:60617`，没有继续寻找可用的下一个端口。端点仅将 `EADDRINUSE` 识别为端口冲突。[Microsoft 的独占地址文档](https://learn.microsoft.com/en-us/windows/win32/winsock/so-exclusiveaddruse)说明，独占绑定冲突既可能产生 Winsock 的地址占用错误，也可能产生访问被拒绝错误。

## 决策

Worker 内部的绑定错误分类器在所有平台接受 `EADDRINUSE`，仅在 Windows 接受 `EACCES`。其平台参数默认使用真实进程平台，同时允许显式的操作系统矩阵测试。输入仍必须是 Error 对象。现有端点循环继续递增候选端口，随机端口请求（`port: 0`）绑定失败时仍报错，且搜索仍在端口 65535 终止。

## 考虑过的替代方案

**在所有平台重试所有访问被拒绝错误。** POSIX 权限错误不能证明端口已被占用，仍应立即报错。

**修改 socket 独占策略或放宽端口占用断言。** 保持原生 socket 策略和测试对所选地址的要求。

## 影响

仅失败的 Windows 候选绑定增加已有的有限后继端口搜索。其他原生错误码仍向上传播；不改变 socket 复用设置、权限、监听地址或发现协议。分类器无法区分 Windows 独占冲突与其他 Windows `EACCES` 绑定失败，因此搜索耗尽后仍报错，不覆盖原生权限限制。

## 测试

Windows 矩阵用例在旧分类逻辑下失败，在修复后通过。本地全部 11 项所属测试通过，其中包括启动真实 Inspector 并验证发布的 HTTP、DevTools 和 Client 地址的原始端口占用测试。Lint 通过。这些本地原生及操作系统矩阵验证不代表托管 Windows 重跑或完整 CI 已验收通过。

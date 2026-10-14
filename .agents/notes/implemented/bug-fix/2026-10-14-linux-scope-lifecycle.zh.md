# Agent Note：完成已取消 Linux scope 的生命周期

状态：已实现

[English](2026-10-14-linux-scope-lifecycle.md) | 中文

## 问题

托管 Linux 的立即销毁诊断证明：原生 user-systemd scope 在 TERM、重放的 TERM 和 KILL 请求均成功后，仍在 90 秒内保持 loaded、active。直接子进程已经退出。该操作自有的确切 cgroup 存在，`populated=0`、`TasksCurrent=0`，直接成员中的存活、僵尸、死亡和不可读进程计数均为零。这是空 scope 的 manager 生命周期仍保持 running，既不是缺少升级信号，也不是 fallback containment 的结果。

## 决策

最终 SIGKILL 请求成功后，[原生 owner](../../../../packages/subprocess/subprocess-local/src/linux-scope.ts) 为自己的确切私有 scope 入队 `systemctl --user stop --no-block`。scope 延迟建立时的取消重放也包含这项生命周期请求。单独的 TERM 保留既有宽限期和最终升级。没有取消请求的自然完成不会入队 stop。

[systemctl 手册](https://raw.githubusercontent.com/systemd/systemd/main/man/systemctl.xml) 将 stop 定义为停用，将 `--no-block` 定义为提交任务而非等待完成。[manager 接口手册](https://raw.githubusercontent.com/systemd/systemd/main/man/org.freedesktop.systemd1.xml) 区分 StopUnit 与 KillUnit；后者向空 cgroup 发信号时也可以成功。因此，stop 提交成功或直接子进程退出都不会结算 `waitForExit()`：仍必须由既有的权威 manager 状态观察证明受管范围完全停稳。

## 影响

范围退出尚未得到证明时，被拒绝的生命周期请求仍保持可观察。已回收或已 inactive 的 scope 仍是有效退出证明；单独的 stop 目标不存在并不是证明。宿主退出最终清理即使此前 kill 抛错，也会尝试相同的有界同步提交，分别包含每个自有范围的失败，且不声称范围已经完全停稳。

## 考虑过的替代方案

**用直接结果替代范围等待。** 这会放弃对子孙进程的 ownership。

**禁用原生 containment 或增加超时。** 记录的 cgroup 已证明是真实原生 containment；两者都不能完成生命周期。

**直接写 cgroup 或停止无关 unit。** 层级由 systemd 管理。请求只针对该操作的私有 unit。

## 测试与限制

公开 launch-owner 回归在实现前失败，因为最终信号没有发出 stop 请求。现在它证明：stop 确认和直接退出发生后，范围仍保持 pending，直到 manager 状态结果到达。全部 44 个所属 scope 测试通过；完整 scope 模块的 204 条语句、178 个分支、40 个函数和 182 行均达到 100% 覆盖率。用例保留确切信号顺序、延迟建立重放、意外 bootstrap 失败、自然退出行为、stop 请求拒绝、成功恢复、已回收 unit 和宿主退出错误。

这些平台 seam 测试在开发主机上运行，不调用模型提供方。它们验证 owner 语义，并不验证真实托管 systemd 对新请求的响应。在声称销毁失败已解决前，仍须完成托管原生诊断和完整 CI 复测。

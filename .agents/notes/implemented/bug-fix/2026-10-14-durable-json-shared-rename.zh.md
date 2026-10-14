# Agent Note：通过共享 rename 所有者持久发布 JSON

Status: implemented

[English](2026-10-14-durable-json-shared-rename.md) | 中文

## Problem

一个 Windows projection-cache 用例观察到当前 live 标题已更新，但磁盘和缓存标题仍旧过时。创建时的写入已提交，轮次结束的 checkpoint 却报告 EPERM。原诊断只保留错误码，未保留 syscall，因此实际失败的文件系统阶段仍未证实。另外，源码检查发现 JSON 存储的原子发布使用直接 rename，而 settings 与 credentials 已有有界的 Windows 替换重试。

## Decision

从 [atomic-write](../../../../packages/util/atomic-write/README.zh.md#publishing-a-prepared-file) 导出现有 `renameAtomicTemp` 边界，不改变重试策略。[JSON 存储](../../../../packages/storage/storage-json/src/atomic.ts) 在独占创建临时文件、完整写入、文件 fsync 和关闭句柄之后调用它。同一个完整临时文件始终作为 rename 来源。Windows EACCES、EBUSY、EPERM 保留原有最多八次重试及 20–200 ms 退避；其他错误码和平台立即失败。POSIX 目录 fsync 与最终失败后的临时文件清理由存储继续负责。

消费者不重放创建、写入、fsync、领域更新或缓存 checkpoint，也不会为了 rename 成功而删除旧目标。最终错误向上传播；既有领域回滚及缓存 fail-soft 报告保持不变。[用例诊断](../../../../packages/session/session-projection-cache/tests/fixtures.spec.ts) 只增加固定的 syscall 分类或 unknown，不输出原始路径或警告内容，使原生 Windows 证据可以定位尚未处理的阶段。

## Alternatives considered

- **重试缓存 checkpoint 或延长五秒断言等待。** 这会重复领域工作或掩盖持久写入失败，而不是在发布所有者处处理。
- **整段 JSON 写入改用 writeFileAtomic。** 该函数明确不提供 fsync，会改变存储持久性契约。
- **再写一个重试循环或先删除目标。** 复用既有所有者；删除目标会破坏读者的原子可见性。

## Consequences

两种 JSON 布局共享已有替换策略，同时保留持久性和失败语义。导出的 rename 函数不负责创建、同步或清理调用方的临时文件。本修改补上已知维护缺口，并不证明该次 EPERM 由 rename 引起，也不证明原生 Windows CI 已通过。归档的重试说明保持冻结，之前的策略继续由有效的 [atomic-write README](../../../../packages/util/atomic-write/README.zh.md) 负责。

## Testing

接入共享边界之前，四个消费者回归用例失败。接入后，公开测试验证完整、已同步、已关闭的输入，旧目标与最终错误的保留、临时文件清理、独占 open 错误立即失败，以及两种布局中记录保持不变。既有 utility 测试使用原有 OS 模拟覆盖有界重试码及耗尽；不增加 OS 伪装，也不把这些测试当作原生 Windows 证据。原 projection-cache 用例及五秒断言保持不变。范围测试四个文件的 54 个用例通过；四个 JSON 存储源码与 atomic-write 的覆盖率均为 100%（331 个语句、135 个分支、65 个函数、298 行）。原始错误阶段仍以真实 Windows 诊断为准。

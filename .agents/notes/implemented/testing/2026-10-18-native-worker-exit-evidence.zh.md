# Agent Note: 原生测试工作进程退出证据

Status: implemented

[English](2026-10-18-native-worker-exit-evidence.md) | 中文

## Problem

Windows 原生测试通道可能丢失 Vitest 进程，却不报告断言失败。Vitest 4.1.8 丢弃退出回调的退出码与信号，因此通用错误无法区分运行时崩溃和测试被终止。多次运行在不同数量的已完成用例后结束。本机通过不能解释 Windows 原因。

## Decision

[E2E 工作流](../../../../.github/workflows/e2e.yml)中主动选择的 `runtime-diagnostics` 任务迁移 [Vitest PR 10587](https://github.com/vitest-dev/vitest/pull/10587) 的退出码与信号报告方式。它只改变该诊断任务所安装依赖的错误文字，要求预期处理器恰好出现一次，依赖改变时明确失败。原子替换文件避免改动 pnpm 存储硬链接。依赖版本、产品代码、普通测试任务和断言均保持不变。

该任务使用详细输出和至多两个工作进程运行四个原生生命周期测试文件。[回归测试](../../../../scripts/worker-exit-diagnostics.spec.ts)在私有假包目录中执行内联补丁，检查 Windows 大退出码和信号被保留，并检查未知处理器被拒绝且文件未修改。回归测试不改动开发机器已安装的依赖。

Windows 通过 [WER 按应用配置](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps)在一次性运行器上保留至多两个 Node 小型转储。探测后的步骤在失败时仍执行，报告应用崩溃事件；SDK CDB 可用时，使用匹配的公开 Node 符号读取异常栈。不上传转储。该步骤移除自己的注册表配置，不覆盖已有 Node 转储配置。没有转储或 CDB 时，原因仍未分类。

手动选择 `worker_import_probe=pure` 会用[独立工程替身](../../../../scripts/reproduce-worker-import.mjs)替换项目探测，跳过依赖安装与原生构建。`diagnostic_node` 仅为此诊断选择 Node 22 或 24，默认仍为 `project` 和 24。每组在至多 256 个顺序 Worker 中导入私有 ESM 或 CommonJS 模块，观察就绪，并等待终止后才继续。CommonJS 组经过 Node 的[原生 CJS 转换器](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/modules/esm/translators.js)，不加载 Vitest、tsx 或 DSH。`worker_import_probe=tsx` 则安装锁定依赖，在明确为 ESM 的私有包内，用 TypeScript enum 替身分别比较 128 次 ESM-only 和双 hook 启动。它加载 tsx，但不加载 DSH 服务。两者均为工程替身；有界探测通过不能排除原崩溃。

可选 CLI 阶段 `online` 在 Node 启动事件发生时终止，不等待替身执行；输出标注该阶段，不声称导入已完成。手动 tsx 探测在完成导入的对照之后使用此阶段，隔离启动时取消。不通过固定延迟安排取消。

`worker_import_probe=cancel-case` 使用 Vitest 的 `repeats` 机制，将既有“取消后 worker 死亡”原生用例执行 32 次，不重试或修改断言。[项目配置包装](../../../../scripts/native-worker-repro.config.mjs)保留仓库的初始化文件，仅选择[诊断 runner](../../../../scripts/worker-death-repeats.ts)。[API 入口](../../../../scripts/reproduce-worker-death.mjs)要求恰好一个通过的选中用例、`repeatCount=31` 且没有未处理错误；目标改名或缺失时失败。它缩小到已观察 Windows 故障中最后未完成的状态转换，但不证明该转换导致崩溃。

单独主动选择 `native_debugger=true` 的任务在 [Microsoft CDB](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/cdb-command-line-options) 下按原顺序运行四个文件，跟踪子进程，并使用匹配的 Node 符号只记录第二次机会访问异常。它保留普通依赖安装方式，不修改 Vitest。校验器同时检查调试器日志和捕获的控制台输出，拒绝未处理错误，并要求四个不同文件中的原有 68 个用例完整存在（67 个通过、一个跳过）。回显的调试命令不算异常标记。这是堆栈捕获，不替代必需 CI，也不声称已修复崩溃。

若启动时调试改变时序，`native_debugger_mode=postmortem` 会正常运行 Node，并在一次性运行器上注册 [AeDebug](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/enabling-postmortem-debugging)。仅未处理崩溃才启动 CDB；`.jdinfo` 恢复原始异常上下文，不通过继续执行来重现瞬时故障。`finally` 块恢复原有 Debugger/Auto 值及类型，校验恢复结果，并只移除自己新建且为空的键。两种模式保留相同的完整报告和控制台错误校验。

[显式 CI 预算决策](2026-10-13-explicit-ci-api-budget.zh.md)继续有效：手动诊断要求 `runtime_diagnostics=true`，清空模型凭据，并保持 `real_api=false`。它不授予模型调用授权。此机制补充诊断证据，不替代既有测试或预算决定。
## Alternatives considered

**重试直到变绿或增加超时。** 进程崩溃不是超时，成功重试也不解释之前的崩溃，因此否决。

**观察退出前就更换 Node、关闭 JIT 或改变工作流终止。** 这会在尚未确定原因时修改疑似责任方，因此否决。

**升级或永久修补整个 Vitest 依赖。** 此次调查只缺诊断输出，因此采用有界的主动诊断适配，保持已有依赖图和普通判定。

## Consequences

适配明确绑定已安装的处理器，Vitest 变化时需要重新检查。它暴露退出证据，不修复底层运行时故障，也不证明原生崩溃不再发生。诊断运行与必需的原生 CI 判定分开。首次失败和之后的结果独立保留。

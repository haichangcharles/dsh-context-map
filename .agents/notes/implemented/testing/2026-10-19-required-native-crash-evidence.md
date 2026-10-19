# Agent Note: Required Windows native crash evidence

Status: implemented

English | [中文](2026-10-19-required-native-crash-evidence.zh.md)

## Problem

A required Windows Vitest fork previously exited with access violation `0xC0000005`. Separate bounded diagnostics did not reproduce it. A later passing diagnostic does not fix or replace the failed required verdict. Capture must follow the actual required runner, Node selection, pnpm environment and test invocation.

## Decision

The required native and coverage jobs in [ci.yml](../../../../.github/workflows/ci.yml) call [the Windows wrapper](../../../../scripts/run-windows-native.ps1). Its default native lane preserves the original four files, `pnpm exec`, default reporter, serialization and timeout. The coverage lane runs the original `pnpm run check:ci:coverage` once, retaining partition, worker, reporting and timeout configuration. Each invocation propagates failure. No dependency, runtime flag, assertion or production behavior changes. Coverage also produced an unexpected fork exit without an assertion failure; it is not classified as the earlier access violation without exception evidence.

On disposable GitHub-hosted Windows only, [debugger preparation](../../../../scripts/prepare-native-debugger.ps1) uses the official signed Microsoft SDK and matching public Node symbols. [AeDebug](https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/enabling-postmortem-debugging) starts CDB only after an unhandled crash. `.jdinfo` selects the original exception context; the log contains a stack and module inventory, not a memory dump. A standalone fault marker also fails the wrapper even if the test command returned zero.

The [registry owner](../../../../scripts/native-postmortem-registry.ps1) saves and restores only Debugger/Auto values with their original types and raw values, including case-insensitive names and unexpanded strings. Its `finally` restores settings after success, failure or partial setup. A six-case private HKCU fixture checks normal and throwing callbacks for absent keys, unrelated values and lowercase expanded-string/DWord settings. Self-hosted runners run the original command without debugger setup or machine-registry changes. Model credential variables are blank for both keyless jobs; each lane has its own diagnostic log.

The hosted wrapper also uses [OS process-exit notifications](../../../../scripts/windows-process-exit-evidence.ps1) to report descendants' numeric exit status when no unhandled-exception stack appears. Private CIM subscriptions buffer [process starts](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/krnlprov/win32-processstarttrace) and [stops](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/krnlprov/win32-processstoptrace); OS-time ordering resolves ownership from the wrapper PID and revokes reused PIDs. Logs contain process names, IDs, times and exit status, without arguments, environment or dumps. The summary is explicitly best-effort: late/missing notifications can omit exits, decoding is capped at50000notifications, and32nonzero details retain omission counts. Expected nonzero child exits do not fail a passing command. Setup/collection failures warn, the original callback still runs once, and private subscriptions/events are cleaned up on every path. Pure fixtures check ownership, ordering, reuse, bounds and callback failure propagation after partial observer setup. Actual CIM delivery is a Windows CI observation, not proved by those fixtures.

## Alternatives considered

Retrying until green or changing Node/JIT/termination without a fault stack would obscure the cause. Running all tests under an attached debugger changes timing. Postmortem capture leaves normal execution uninstrumented until failure, but SDK/symbol availability is an additional hosted-runner dependency.

## Consequences

This is observability, not a claimed runtime repair. The original failure remains recorded. Native execution of the wrapper must be checked by the required CI itself; fixture and diagnostic passes cannot substitute for that result. No model API, training or paid workflow is authorized.

# Agent Note: Native worker exit evidence

Status: implemented

English | [中文](2026-10-18-native-worker-exit-evidence.zh.md)

## Problem

The Windows native test lane can lose its Vitest process without reporting an assertion failure. Vitest 4.1.8 discards the exit callback's code and signal, so its generic error cannot distinguish a runtime crash from a terminated test. Repeated runs ended after different numbers of completed cases. A passing local run cannot identify the Windows cause.

## Decision

The opt-in `runtime-diagnostics` job in the [E2E workflow](../../../../.github/workflows/e2e.yml) adapts the exit-code and signal reporting from [Vitest PR 10587](https://github.com/vitest-dev/vitest/pull/10587). It changes only the installed diagnostic job's error message, checks that the expected handler occurs exactly once, and fails if the dependency has changed. Atomic file replacement avoids mutating pnpm store hardlinks. Dependency versions, production code, ordinary test jobs and assertions remain unchanged.

That job runs the four native lifecycle test files with verbose output and at most two workers. The [regression](../../../../scripts/worker-exit-diagnostics.spec.ts) executes the inline patch in private fake-package directories, verifies that Windows-sized exit codes and signals survive, and verifies that an unfamiliar handler is rejected without modifying its file. No installed dependency on the developer's machine is patched by the regression.

The [explicit CI budget decision](2026-10-13-explicit-ci-api-budget.md) remains authoritative: this manual diagnostic requires `runtime_diagnostics=true`, clears model credentials, and leaves `real_api=false`. It grants no model authorization. This is additive diagnostic evidence and supersedes no existing test or budget decision.

## Alternatives considered

**Retry until green or increase timeouts.** Rejected because a process crash is not a timeout and a successful retry does not explain an earlier crash.

**Change Node, disable JIT or alter workflow termination before observing the exit.** Rejected because these would change the suspected owner without evidence identifying it.

**Upgrade or permanently patch the entire Vitest dependency.** Rejected for this investigation because only diagnostic output is missing; the bounded opt-in adaptation preserves the existing dependency graph and ordinary verdict.

## Consequences

The adaptation is intentionally tied to the installed handler and must be rechecked when Vitest changes. It exposes the exit evidence but does not fix the underlying runtime failure or prove that a native crash has become impossible. A diagnostic run remains separate from the required native CI verdict. Original failed attempts and later outcomes remain recorded independently.

# Agent Note: Preserve Linux cancellation before bootstrap consumption

Status: implemented

English | [中文](2026-10-14-linux-prelaunch-cancellation.zh.md)

## Problem

A caller can cancel a Linux scope before its one-shot bootstrap consumes the launch request. Treating every unconsumed request as an unexpected startup failure turns short timeouts, aborts and provider disposal into launch errors. Coverage instrumentation makes this ordering more likely. It also loses the requested termination signal in consumers that expect a killed result.

## Decision

The [Linux scope owner](../../../../packages/subprocess/subprocess-local/src/linux-scope.ts) retains its requested termination signal. Ordinary and PTY outcomes share resolution: a reported startup error remains authoritative; an unconsumed request after explicit termination settles with null exit code and the requested signal; an unrequested unconsumed exit remains an error. Once the bootstrap consumes the request, the actual target outcome remains authoritative. Range quiescence and protocol cleanup continue independently.

Fake PTY lifecycle fixtures explicitly select the fallback owner they model. They cannot consume a real native bootstrap request. Dedicated Linux scope and PTY owner fixtures continue to test native selection and ownership.

## Alternatives considered

**Wait for bootstrap readiness before allowing cancellation.** This delays caller timeouts and disposal, allowing a command to start after cancellation intent.

**Ignore every unconsumed request.** This conceals bootstrap crashes and genuine launch failures that have no cancellation request.

**Increase timeout or test limits.** This changes the race probability without preserving the required cancellation result.

## Consequences

Signal intent belongs to the existing operation owner rather than a second cancellation controller. No command is replayed, no timeout is raised and no scope membership check is removed. Unexpected bootstrap exits and startup diagnostics still fail closed. The local platform-seam tests establish outcome ordering; real systemd behavior remains covered by Linux CI.

## Testing

The [scope tests](../../../../packages/subprocess/subprocess-local/tests/linux-scope.spec.ts) cover pending SIGTERM and SIGKILL, launcher exit codes without Node signals, PTY cancellation, request cleanup and startup-error precedence. Negative cases retain unexpected unconsumed-exit rejection and unknown scope-state errors. The scope, runtime, spawn and terminal suites pass 185 tests without provider calls or relaxed timing assertions.

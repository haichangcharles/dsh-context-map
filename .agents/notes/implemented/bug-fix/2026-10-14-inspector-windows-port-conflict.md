# Agent Note: Retry Windows Inspector bind conflicts

Status: implemented

English | [中文](2026-10-14-inspector-windows-port-conflict.zh.md)

## Problem

The native Windows CI test reserved an occupied starting port, but Inspector failed with `listen EACCES: permission denied 127.0.0.1:60617` instead of advancing to its available successor. Its endpoint recognized only `EADDRINUSE` as a port collision. [Microsoft's exclusive-address documentation](https://learn.microsoft.com/en-us/windows/win32/winsock/so-exclusiveaddruse) explains that an exclusive bind conflict can produce the Winsock access-denied error as well as address-in-use.

## Decision

The worker's internal bind-error classifier accepts `EADDRINUSE` on every platform and `EACCES` only on Windows. Its platform argument defaults to the actual process platform and permits explicit operating-system matrix tests. It still requires an Error object. The existing endpoint loop continues to advance its candidate port, rejects a failed random-port request (`port: 0`), and stops at port 65535.

## Alternatives considered

**Retry every access-denied error on every platform.** A POSIX permission failure is not evidence of an occupied address and remains an immediate error.

**Change socket exclusivity or relax the occupied-port assertion.** The native socket policy and the test's selected-address requirements remain unchanged.

## Consequences

Only failed Windows candidate binds gain the existing bounded successor search. Other native error codes still propagate; no socket reuse setting, elevated permission, host address or discovery contract changes. The classifier cannot distinguish Windows-exclusive conflicts from other Windows `EACCES` binds, so exhaustion still fails rather than overriding native permissions.

## Testing

The Windows matrix case failed under the previous classification and passes after the fix. All 11 owning tests pass locally, including the original real occupied-port test that boots Inspector and verifies its published HTTP, DevTools and Client addresses. Lint passes. These local native and operating-system matrix checks do not claim a successful hosted Windows rerun or complete CI acceptance.

# Agent Note: Keep native request boundaries explicit

Status: implemented

English | [中文](2026-10-14-native-request-boundaries.zh.md)

## Problem

The coverage gate exposed untested public compiler, sandbox and final-dispatch boundaries. The Agent compiler also read mutable phase coordinates after asynchronous route preparation, with a fallback zero that its sole private caller could never use.

## Decision

The admitted Agent step passes its captured turn and step into request construction. Its running-phase check, cancellation checks and missing-compiler rejection remain unchanged. Native regressions exercise malformed JavaScript compiler output, empty native assistant messages, registration disposal, missing durable compiler plugins, sandbox policy and runner diagnostics, and synchronous dispatch authorization through local HTTP fixtures.

## Alternatives considered

- **Ignore uncovered branches.** This would leave public failure behavior unverified.
- **Manipulate private Agent phases.** Such fixtures would violate the admitted-step contract.
- **Relax final-dispatch return validation.** An asynchronous callback would reopen the context-edit interval before dispatch.

## Consequences

Compiler selection uses the same execution coordinates as route preparation and native step events. Invalid public inputs still fail before dispatch. These keyless tests use local mock servers and establish request-boundary behavior, not model quality or research results.

## Testing

The complete compiler, Agent-loop, search-tool and DeepSeek suites pass all 985 cases with all four owning source files at 100% coverage. An untouched surface compiler remains transparent on the native request header. The cancellation case verifies the public ABORTED error retains its original cause and emits no request. The sandbox case uses a real native Session for policy projection. A real PTY settles and delivers output without overriding the host platform. Public PowerShell executor fixtures distinguish foreground timeout from upstream cancellation using controlled subprocess outcomes. Local shell suites pass 368 cases, with 39 existing platform skips; Bash and subprocess source coverage is 100%. The local host has no PowerShell, so its existing coverage exemption prevents a local claim of full PowerShell source coverage.

## Related

- [Agent request assembly](../../../../packages/core/agent-loop/src/agent.ts)
- [Compiler regressions](../../../../packages/context/context-compiler/tests/registry.spec.ts)
- [DeepSeek dispatch regressions](../../../../packages/llm/llm-deepseek/tests/adapter.spec.ts)

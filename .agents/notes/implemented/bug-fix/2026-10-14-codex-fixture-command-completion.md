# Agent Note: Observe real fixture command completion

Status: implemented

English | [中文](2026-10-14-codex-fixture-command-completion.zh.md)

## Problem

The optional Codex adapter's isolated bypass test used a fixed localhost response script: request a filesystem write, then answer that work was complete. Real Windows Codex returned an `exec_command` result after 10.0133 seconds with a live session and no output. The script answered immediately while that command was still running, so the real file-existence assertion failed. Its assertion diagnostic also printed the entire request history, including unrelated developer instructions.

## Decision

The private Responses fixture accepts a request-aware script alongside its existing fixed scripts. The isolated command script reads only the latest `function_call_output`. A real running-session result selects the advertised `write_stdin` function with that actual session id, empty input and the default yield. Only a successful process-exit result permits the final response. The same existing 60-second test deadline includes startup and every continuation. Diagnostics retain only the recent tool output.

## Alternatives considered

- **Increase tool yield or test timeout.** A running session is a legitimate tool result and still needs explicit observation.
- **Ignore the missing file or synthesize success.** This would remove the permission and filesystem behavior the real-product test verifies.
- **Change the Windows shell command.** The captured result showed a running command, not a path or shell error; there was no evidence to justify a product or command change.

## Consequences

The test still executes the real binary with a localhost model stub and an isolated temporary workspace. File existence, exact content, selected permissions and whole-process quiescence remain real assertions. The adapter stays optional; this changes no ContextMap agent runtime, model provider, shell configuration or product permission policy. Actual Windows rerun remains necessary to establish that the observed native failure is resolved.

## Testing

Seven private-fixture cases cover repeated live-session continuations, misleading earlier/developer text, missing or failed output, unsafe session ids, the unchanged absolute deadline and request-aware localhost serialization. All seven real-product cases also pass locally, including the isolated write and default permission denial: 14 tests pass in total. The three changed test files pass lint and whitespace checks.

## Related

- [Private response fixture](../../../../packages/subagent/subagent-codex/tests/responses-fixture.ts)
- [Real-product permission and filesystem tests](../../../../packages/subagent/subagent-codex/tests/real-product.spec.ts)
- [Continuation regressions](../../../../packages/subagent/subagent-codex/tests/responses-fixture.spec.ts)

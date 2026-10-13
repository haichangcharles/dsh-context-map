# Agent Note: Publish PowerShell terminals after their owned prompt

Status: implemented

English | [中文](2026-10-14-pwsh-terminal-bootstrap.zh.md)

## Problem

PowerShell terminal startup decided whether to submit its encoding and prompt setup from the previous viewport length. An empty silence settlement resubmitted setup. A backend stdin-read result could also publish an empty viewport or the original PowerShell prompt before the controlled prompt was installed. Linux CI exposed both schedules; one transcript contained duplicated setup source.

## Decision

Startup records submission separately from output and writes setup exactly once. It publishes only after stdin-read readiness and the existing parser has observed both the owned OSC marker and the exact controlled prompt. LocalPtySession exposes that pair of parser facts through a read-only getter. Empty startup observation continuations retain partial owned-prompt evidence across silence settlements; any actual input or submission resets it even if continuation is requested. Ordinary sends, cancellation, the absolute startup deadline and environment scrubbing retain their contracts.

## Alternatives considered

- **Increase startup timeouts.** More time does not identify which prompt produced stdin-read readiness.
- **Accept source text containing the prompt literal.** Setup echo contains the same literal without proving setup execution.
- **Wait for any nonempty output.** The original PowerShell prompt is nonempty and still precedes setup.

## Consequences

A published terminal has reached its own prompt instead of an earlier shell input wait. Empty and echoed startup captures cannot trigger another setup submission. This does not establish general command completion from prompt text; foreground inspection remains the stdin-read authority. The existing real PowerShell persistence and secret-scrubbing assertions remain unchanged and require an installed PowerShell host for validation.

## Testing

The backend regression covers empty inferred-idle, empty stdin-read, original PowerShell stdin-read, and echoed setup captures. Three cases fail before the fix and pass afterward. Native parser tests retain split-marker behavior and verify readiness is false before the marker, false before prompt text, and true after both. A real session over a public terminal fixture also covers an owned marker whose printable prompt arrives after a silence bridge. It fails before continuation retains the marker and passes after the fix. Input and submission cases still clear prior evidence. The complete index and session suites pass 75 cases.

## Related

- [Startup orchestration](../../../../packages/terminal/terminal-bash/src/index.ts)
- [Owned prompt evidence](../../../../packages/terminal/terminal-bash/src/session.ts)
- [Real terminal regressions](../../../../packages/terminal/terminal-bash/tests/local.spec.ts)

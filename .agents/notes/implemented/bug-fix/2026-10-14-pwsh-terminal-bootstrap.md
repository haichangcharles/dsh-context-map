# Agent Note: Publish PowerShell terminals after their owned prompt

Status: implemented

English | [中文](2026-10-14-pwsh-terminal-bootstrap.zh.md)

## Problem

PowerShell terminal startup decided whether to submit its encoding and prompt setup from the previous viewport length. An empty silence settlement resubmitted setup. A backend stdin-read result could also publish an empty viewport or the original PowerShell prompt before the controlled prompt was installed. Linux CI exposed both schedules; one transcript contained duplicated setup source. Failure-only native diagnostics later identified an earlier boundary: setup was written before the initial cursor-position reply, then echoed without any owned marker despite a native stdin wait. The initial console negotiation had not completed when setup was submitted.

## Decision

PowerShell startup first waits for nonempty initial output, drained terminal-protocol replies and native stdin-read readiness; silence cannot settle this initial phase when exact stdin-wait capability is supported or unknown. Foreground facts now expose optional `stdinWaitSupported`, supplied by the actual inspector and ABI rather than the host OS guessed by a consumer. Explicitly unsupported macOS, Windows, unsupported Linux ABIs and E2B retain nonempty, protocol-drained output silence for the initial phase only. A false `inputWaiting` alone is not an unsupported-capability signal; final publication always retains the owned marker and exact prompt requirement. It then records submission separately from output and writes setup exactly once. It publishes only after stdin-read readiness and the existing parser has observed both the owned OSC marker and the exact controlled prompt. LocalPtySession exposes that pair of parser facts through a read-only getter. Empty startup observation continuations retain partial owned-prompt evidence across silence settlements; any actual input or submission resets it even if continuation is requested. An empty observation need not depart from an already-existing stdin wait, because it submitted no input. Actual input and submission still must establish their own post-write readiness. Cancellation and environment scrubbing retain their contracts. One absolute startup deadline covers both initial console readiness and controlled-prompt installation; each phase does not receive a fresh timeout.

## Alternatives considered

- **Increase startup timeouts.** More time does not identify which prompt produced stdin-read readiness.
- **Accept source text containing the prompt literal.** Setup echo contains the same literal without proving setup execution.
- **Wait for any nonempty output.** The original PowerShell prompt is nonempty and still precedes setup.

## Consequences

A published terminal has reached its own prompt instead of an earlier shell input wait. Empty and echoed startup captures cannot trigger another setup submission. This does not establish general command completion from prompt text; foreground inspection remains the stdin-read authority. The existing real PowerShell persistence and secret-scrubbing assertions remain unchanged and require an installed PowerShell host for validation.

## Testing

The backend regression covers empty inferred-idle, empty stdin-read, original PowerShell stdin-read, and echoed setup captures. Three cases fail before the fix and pass afterward. Native parser tests retain split-marker behavior and verify readiness is false before the marker, false before prompt text, and true after both. A real session over a public terminal fixture also covers an owned marker whose printable prompt arrives after a silence bridge. It fails before continuation retains the marker and passes after the fix. Input and submission cases still clear prior evidence. A public terminal fixture reproduces the native schedule: early input is echoed without executing setup, a delayed cursor-position reply is drained before input, and setup is withheld until the original console reports stdin readiness. That regression fails before the two-phase fix and passes afterward. The shared-deadline test spends 80 ms in the initial phase and allows only the remaining 20 ms for setup retries under a 100 ms deadline. Empty observations can settle the existing wait; the separate actual-command regression still requires departure and re-entry. The same public fixture covers supported, explicitly unsupported and unknown capabilities without changing the host platform. Native inspector and PTY tests check capability detection and forwarding; mock E2B tests retain the explicit unsupported contract. All 99 applicable terminal tests pass locally, with four installed-PowerShell tests skipped; both changed sources retain 100% statement, branch, function and line coverage. Real Linux PowerShell validation is still required before claiming the native failure resolved.

## Related

- [Startup orchestration](../../../../packages/terminal/terminal-bash/src/index.ts)
- [Owned prompt evidence](../../../../packages/terminal/terminal-bash/src/session.ts)
- [Real terminal regressions](../../../../packages/terminal/terminal-bash/tests/local.spec.ts)

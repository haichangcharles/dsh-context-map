# Agent Note: DeepSeek final-dispatch authorization

Status: implemented

English | [中文](2026-09-28-deepseek-final-dispatch-authorization.zh.md)

## Problem

A policy that checks `GenerateOptions` before the DeepSeek adapter runs cannot identify the exact JSON sent to the provider. Adapter defaults, image representation, and request extensions can change that JSON. Asynchronous request preparation also permits a human context edit between early admission and `fetch`.

## Decision

Direct `DeepSeekAdapter` consumers can supply `authorizeDispatch`. The adapter calls it synchronously after producing the complete chat JSON payload and immediately before each `fetch`. It passes the payload, session id, purpose, and abort signal without exposing headers or credentials. A thrown error or any returned value, including a Promise, stops dispatch with `REQUEST_NOT_AUTHORIZED`. No `await` separates successful authorization from `fetch`. The shipped plugin installs no policy by default.

## Alternatives considered

**Pre-adapter request checks.** They cannot attest to the eventual provider body and can become stale during asynchronous preparation.

**An asynchronous final callback.** Its awaited result creates another edit interval before dispatch; ignoring its Promise sends before authorization finishes. A synchronous callback with runtime return validation avoids both cases.

**Fetch interception alone.** It can demonstrate the hazard in a test but does not give a direct adapter consumer an explicit authorization point.

## Consequences

The official DeepSeek chat-completion route has an exact-payload authorization point. Native two-child tests show it rejects an excluded source while preserving a clean independent request, and catches an excluded source copied into an otherwise admissible child's ambient instructions. In the latter case it rejects the child rather than repairing its input. The callback is not wired to Contextify as a default policy, does not cover the PiAi SDK route, and cannot undo Files API uploads that precede chat serialization. Synthetic sentinel tests do not establish semantic noninterference or task-quality improvement.

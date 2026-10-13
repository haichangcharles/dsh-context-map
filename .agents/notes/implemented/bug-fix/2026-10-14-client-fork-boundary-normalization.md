# Agent Note: Normalize Client fork boundaries consistently

Status: implemented

English | [中文](2026-10-14-client-fork-boundary-normalization.zh.md)

## Problem

ClientSessions accepts numeric graph anchors, including fractional flow-ordering positions used by interrupted Chat turns. The inclusive atSeq path floored its anchor before constructing the integer SessionSeq wire value. The exclusive beforeSeq path directly branded the number, so an existing public regression with 42.8 failed before reaching the Host.

## Decision

Both Client boundary options floor a supplied anchor before integer branding. The Host still owns their different inclusive and exclusive cut semantics. Negative, non-finite and unsafe values remain rejected before any fork request, and omitted boundaries remain omitted.

## Alternatives considered

- **Change the regression to accept an error.** This loses the Client numeric-anchor contract and disagrees with atSeq.
- **Allow fractional SessionSeq values.** This weakens the native wire boundary throughout the Harness.
- **Round to the nearest integer.** This can advance a fractional graph anchor into the next event.

## Consequences

The Client consistently resolves its display-level numeric anchors to real native event positions. This does not change the Host fork operation, rename policy, or publication and selection lifecycle.

## Testing

The existing exclusive 42.8 boundary regression fails before the fix and passes with an exact wire value of 42. The original fractional atSeq regression remains intact. Both options reject negative, NaN, infinite and unsafe values without contacting the Host; the complete Client Sessions regression suite passes.

## Related

- [Client Sessions service](../../../../packages/api/session-controller/src/client/sessions/service.ts)
- [Client Sessions tests](../../../../packages/api/session-controller/tests/sessions-service.client.spec.ts)

# Agent Note: Unicode-safe Context review budgets

Status: implemented

English | [中文](2026-10-14-unicode-review-budget.zh.md)

## Problem

The complete recommendation projection shrinks message content until its serialized JSON fits the input budget. It compared UTF-16 lengths but sliced Unicode code points. For an emoji-heavy message, the next slice could exceed the existing code-point count, leaving the content unchanged and blocking the Host indefinitely.

## Decision

Use code-point counts consistently for longest-content selection, the 160-code-point floor and each reduction. Keep the serialized JSON budget, all graph identities and topology, and the existing explicit rejection when topology alone exceeds the budget. ASCII projection behavior remains unchanged.

The Fast candidate projection also carries original graph order and breadth-first distance beside each item. It avoids nullable lookups for values created in the same traversal. Branch preview extraction accepts only the two message event types its caller has already validated. Unknown external decisions, source URLs and graph endpoints retain their validation.

Compaction and native provenance assertions use [tiny-invariant](https://github.com/alexreardon/tiny-invariant), retaining type narrowing without requiring the unsupported `node:assert/strict` Worker builtin. Both native and packed Worker deployments use the same compiler checks.

## Alternatives considered

**Slice UTF-16 code units.** This can split a surrogate pair and produce malformed text. The initial projection already promises code-point truncation.

**Raise the input budget.** This leaves the non-progressing reduction unchanged for larger conversations.

## Consequences

Each reduction either shortens content or rejects the remaining topology budget. Graph identities and the minimum content floor remain stable. Code-point counting adds bounded local work to the complete projection; Fast review retains its smaller candidate packet.

## Testing

The regression constructs 120 long emoji messages and verifies bounded JSON, complete graph retention, truncation and intact Unicode. Oversized topology fails explicitly. Additional cases cover incomplete Turns, visible images, duplicate Deep submissions, failed submission correction, cleanup failures and candidate-capacity limits. All use deterministic local fixtures without provider calls.

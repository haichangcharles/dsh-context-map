# Agent Note: Durable Branch suggestion choices

Status: implemented

English | [中文](2026-10-08-durable-branch-choice.zh.md)

## Problem

Contextify persists the suggestion produced after a Turn but the Branch card's Keep action used only local React state. A reload could show the same suggestion again, and the Session contained no direct evidence that the user rejected it. A successful relocation could be inferred from other events, but Keep and Move did not share one explicit choice record.

## Decision

The source Session records `contextify/branch-choice` after an explicit Keep click or a successful Move. The event stores the suggestion id, the completed Turn boundary, and `keep` or `move`. The shipped Client declares `uiOrigin: contextify-client` for either action; an unmarked Remote call remains distinguishable, while the marker does not authenticate the actor. Host validation rejects stale or contradictory choices; a repeated identical action produces no second event. `get` omits a decided suggestion after reload. The Client waits for the Host to record Keep before hiding the card and leaves it visible when recording fails.

The choice event is log-only. It does not change the family graph revision or the model-visible Context Plan. It represents an explicit action, not an impression: a generated suggestion without a click is not labeled as a rejection. Existing `contextify/plan` revisions remain the source for manual Include/Exclude changes; this record alone does not measure folding preferences.

## Alternatives considered

- **Continue with local dismissal** — rejected because the choice disappears on reload and cannot form a reliable per-user feedback history.
- **Infer Keep from the absence of relocation** — rejected because the card may never have been seen, or the user may simply have left the page.
- **Write a free-text `feedback/record` event** — rejected because a structured Contextify decision should retain its suggestion identity and typed choice in its owning Session vocabulary.

## Consequences

The existing card now yields a durable route-choice label with no new visible UI. It does not establish that a personalized policy works: no participant history or held-out choices have yet been collected, and the current UI still has no direct per-node `fold` action. Focused Host and Client tests cover idempotence, contradictory choices, reload projection, and recording failure.

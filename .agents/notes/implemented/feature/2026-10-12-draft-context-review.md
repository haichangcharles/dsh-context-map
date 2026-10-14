# Agent Note: Draft-bound Context review

Status: implemented

English | [中文](2026-10-12-draft-context-review.zh.md)

## Problem

Reviewing Context only after a model reply cannot prevent the next request from seeing irrelevant or superseded history. A review of the current Session without the unsent draft also has too little information about which older branch evidence the next answer needs.

## Decision

The Contextify Client adds an explicit review entry above the composer when its draft is nonempty. A click sends that draft as the objective to the existing bounded Fast Contextify review through DSH Remote and opens the Context Map after a successful review. The draft remains in the composer; the Agent does not receive it as a user message. The Client compares the editor revision and text after the asynchronous call and clears advice produced for a changed draft. The existing Context Plan review remains the only way to apply a recommendation.

The entry invokes no model automatically while the user types. It reuses the DSH Agent and native Session family rather than adding a browser-side model route. Fast review may append an independent, conservative Session route card for an explicit Return, prior-branch resume, or new topic. The route policy reads the same frozen graph and reviewed draft without a second model call. Ambiguous requests and short corrections stay on the current Session; the completed-Turn Branch review remains available.

The Context Map's manual Branch from Here action uses `ctx.conversation.moveDraft` after the native fork and before switching Sessions. The Conversation service compares the source text and editor revision with the reviewed draft, requires an empty destination, and transfers attachments with file-upload rebinding. A failed comparison keeps the source selected, so an asynchronous fork cannot silently strand an edited draft in the old branch. After a successful transfer, the Client records one `contextify/manual-branch` event as explicit positive Branch-policy evidence. An assembled-Web replay verifies both the transfer and event.

The completed-Turn Branch suggestion uses the same draft handoff before opening its relocated child Session. Its proposal and native relocation remain separate from the next unsent draft: accepting the previous Q&A's move does not submit or rewrite that next message.

Accepting a draft route rechecks the graph and Plan revisions, exact draft, and destination before moving the composer text and attachments. A successful transfer is followed by a native Session switch; rejecting the card keeps the current Session. A `contextify/route-choice` event records only an explicit accepted or rejected card. The `stewardProfile` projection learns Navigate, Return, and Branch preferences from those events and aggregates confirmed policy observations across Sessions in the same DSH Profile. Semantic route scoring is not yet shipped.

## Alternatives considered

**Intercept every Send and force a Context review.** Rejected because this adds latency and model cost to every turn, including short corrections, and existing composer delivery modes and queued messages have distinct semantics.

**Run review on every draft change.** Rejected because typing would create many stale model calls and make the expense unpredictable.

**Let the browser score Context candidates itself.** Rejected because DSH owns model routing, Session provenance, and Context Plan validation.

## Consequences

Users can inspect and correct Context and accept an explicit Session route before the next response without sending the draft. The explicit click keeps API spend bounded. Route advice is still a conservative lexical fallback, not a demonstrated accuracy gain; Release automation and held-out preference evaluation remain separate work.

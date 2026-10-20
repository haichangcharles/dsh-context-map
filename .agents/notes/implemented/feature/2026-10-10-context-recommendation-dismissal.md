# Agent Note: Context recommendation presentation and dismissal

Status: implemented

English | [中文](2026-10-10-context-recommendation-dismissal.zh.md)

## Problem

The Context review sheet previously cleared a proposal without a Session event. A personal Context policy could observe accepted edits but could not distinguish a rendered proposal and explicit closure from silence, cancellation, an error, or a proposal that never reached the Client.

## Decision

When a current sheet renders in a visible Client document, it calls `presentRecommendation` with the exact proposal. The Host logs `contextify/recommendation-presented` once per still-current proposal. The close button calls `dismissRecommendation`; the Host rejects an unavailable or different proposal, appends `contextify/recommendation-dismissed` with its mode, revision-scoped base and selected node actions, then consumes the pending proposal. Neither event changes the Context Plan or graph revision. The Client declares `uiOrigin: contextify-client`; this identifies the Client path, not an authenticated person. Clearing an error and cancelling a running review continue to clear only transient state. [Selective review](2026-10-10-selective-context-review.md) preserves explicitly declined item IDs and their bounded objective for policy learning; bare closure provides no preference label.

Each admitted Host recommendation owns one opaque `recommendationTraceId`. Existing auxiliary request, presentation, reviewed, dismissal and route-choice events carry that identifier; Goal and Jev stages share it, and Carry retains it across source and destination Sessions. The existing proposal metadata owns the value, and private helpers receive it explicitly so cancellation cannot attach an old request to the next operation. It is absent from model prompts and the public proposal, does not change graph/Plan revisions or learning weights, and supplies no new permission. Older records can omit it; Local/Deep operations may lack an auxiliary request record.

The identifier names the pending proposal consumed by the Host, not the original Client click. Two successive proposals can be deeply equal, allowing a delayed equal Client payload to consume the current pending proposal under existing checks. Such a callback receives the current Host identifier; its original display/click attempt remains unknown. Native correlation does not certify human identity, attention or a complete cross-Session input snapshot.

## Alternatives considered

**Infer an impression from proposal generation.** A generated proposal may never reach a visible Client sheet, so generation cannot establish exposure.

**Treat closure as rejection of every action.** The user can close a sheet to postpone review; this would manufacture negative item labels.

## Consequences

A Client-declared sheet presentation and an explicit closure are separate durable events, while the original recommendation remains review-only. Presentation stores node IDs and actions; dismissal also retains the reviewed draft only when an item was explicitly declined. A stale or lost proposal does not produce a presentation or dismissal event and must be re-reviewed. Rendering in a visible document does not prove the person saw or read the sheet. Closure can mean postponement; it is not a negative label for every proposed node action. Learning neither infers an impression from generation alone nor infers item-level dislike from closure alone.

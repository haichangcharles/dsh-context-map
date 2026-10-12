# Agent Note: Context recommendation presentation and dismissal

Status: implemented

English | [中文](2026-10-10-context-recommendation-dismissal.zh.md)

## Problem

The Context review sheet previously cleared a proposal without a Session event. A personal Context policy could observe accepted edits but could not distinguish a rendered proposal and explicit closure from silence, cancellation, an error, or a proposal that never reached the Client.

## Decision

When a current sheet renders in a visible Client document, it calls `presentRecommendation` with the exact proposal. The Host logs `contextify/recommendation-presented` once per still-current proposal. The close button calls `dismissRecommendation`; the Host rejects an unavailable or different proposal, appends `contextify/recommendation-dismissed` with its mode, revision-scoped base and selected node actions, then consumes the pending proposal. Neither event changes the Context Plan or graph revision. The Client declares `uiOrigin: contextify-client`; this identifies the Client path, not an authenticated person. Clearing an error and cancelling a running review continue to clear only transient state. The existing personal policy does not yet treat dismissal as a negative training case.

## Alternatives considered

**Infer an impression from proposal generation.** A generated proposal may never reach a visible Client sheet, so generation cannot establish exposure.

**Treat closure as rejection of every action.** The user can close a sheet to postpone review; this would manufacture negative item labels.

## Consequences

A Client-declared sheet presentation and an explicit closure are now separate durable events, while the original recommendation remains review-only. The events store node IDs and actions rather than message content. A stale or lost proposal does not produce a presentation or dismissal event and must be re-reviewed. Rendering in a visible document does not prove the person saw or read the sheet. Closure can mean postpone or reject the whole sheet; it is not a negative label for every proposed node action. Future learning must neither infer an impression from generation alone nor infer item-level dislike from closure.

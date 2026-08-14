# Agent Note: Pinned conversation details share the Tool column

Status: implemented

English | [中文](2026-08-14-pinned-conversation-details-slot.zh.md)

## Problem

Session-scoped interfaces such as a context graph need to remain visible while the user reads and writes Chat. Replacing the `details` occupant would take ownership of the complete right column and remove the existing Tool-result renderer; placing the interface in another view would prevent simultaneous context control and conversation. The details column therefore needs an additive region whose lifetime follows the conversation shell while preserving transient Tool inspection.

## Decision

The `details` registration in `ui-conversation` declares the session-scoped list slot `conversation.details.pinned` beside the existing single `conversation.details.tool` slot. Optional plugins contribute one self-contained pinned panel through slot declaration injection, so activation order and reload follow the slot declaration rather than a package-specific service dependency.

`DetailsPanel` observes pinned-slot occupancy through a framework-bound observable hook backed by the slot ledger. With no contribution, it renders the existing Tool details tree and close behavior. With a contribution, the pinned region consumes the available height when no Tool call is selected; selecting a Tool call opens a lower drawer capped at 45 percent of the column. Closing that drawer clears the shared chat selection and leaves the details column and pinned panel open. A pinned contribution owns its own header and may close the whole column through its plugin's `ctx.layout` inject face.

The Tool selection remains in the shared per-session chat store. Pinned business state belongs to its contributing plugin's session data, observable source, or declared store; `ui-conversation` owns only placement and coexistence.

## Alternatives considered

**Replace the top-level `details` slot.** This gives a context plugin the whole column but collapses `conversation.details.tool`, so context control and Tool inspection cannot coexist.

**Add a Contextify-specific slot to the layout package.** Layout owns geometry, not conversation-domain composition. A feature-named slot would couple the core shell to one plugin and make other persistent session panels require another layout change.

**Put the context graph in a conversation tab or modal.** Both placements hide either Chat or the graph during editing and defeat the simultaneous control requirement.

**Poll `slots.entries()` from the component.** A plain read does not publish late registration, disposal, or crash abdication to React. The slot-ledger observable uses the framework's single hook-binding path and follows those lifetimes.

## Consequences

Conversation plugins gain one generic persistent right-column seat without importing Contextify. Tool details retain their existing full-height behavior in compositions with no pinned contribution, while compositions with one or more pinned entries trade part of the column height for simultaneous inspection.

The details shell carries an occupancy subscription and a two-region layout. Pinned entries must provide their own title, close action, scrolling, and error presentation; the shell cannot coordinate feature-specific state. Component and assembly tests pin empty-slot compatibility, late occupancy changes, drawer coexistence, and close semantics.

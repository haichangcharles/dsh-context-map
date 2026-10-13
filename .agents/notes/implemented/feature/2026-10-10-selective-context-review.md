# Agent Note: Selective Context review feedback

Status: implemented

English | [中文](2026-10-10-selective-context-review.zh.md)

## Problem

An all-or-nothing recommendation sheet could not express that one old Chat constraint should be removed while a nearby current constraint should remain. Treating an unaccepted sheet as negative feedback would also confuse silence with an explicit Context preference.

## Decision

Each proposed Context change has a Keep-current control. The Client submits the exact accepted mutations and declined node IDs against the pending proposal and graph revision. The Host rejects foreign or duplicate declines, verifies that accepted mutations are exactly the remaining proposal actions, and records one `contextify/recommendation-reviewed` event with the full selection and its accepted/declined partition. A fully declined sheet records the choice without a Plan revision. A partially accepted sheet commits only its accepted mutations. Closing a sheet preserves explicitly declined node IDs and the bounded reviewed objective in `contextify/recommendation-dismissed`; only those items provide rejection evidence, while undecided items remain unlabeled.

Fast review recovers Client-declared confirmed sheet choices from the Session family. Accepted actions retain their mode. Declining Include or Exclude rejects that proposed change without inventing an affirmative opposite action. The policy estimate reads explicit declines from both Apply and closure; the same-draft repeat filter suppresses their exact action-node keys. Each labeled item has weight one divided by the full sheet size, so a partial closure contributes at most one total observation. The style-memory ranker and model-visible examples use affirmative edits only. Legacy accepted `node-choice` events remain readable; a reviewed event prevents counting its adjacent `node-choice` twice.

## Alternatives considered

**Apply or dismiss the entire sheet.** This loses the useful items whenever one proposed change is wrong and yields no item-level correction.

**Learn a negative label from every dismissed item.** Closing a sheet can mean postponement, so only items explicitly marked Keep current provide rejection evidence.

## Consequences

Users can correct a recommendation without losing its useful items, and the next Fast review can suppress a repeated suggestion opposed by an explicit Keep-current choice. The Plan remains authoritative and no recommendation changes the next model request before confirmation. These events describe a Client path, not authenticated human identity; local behavior tests and a 30-turn browser replay establish the mechanism, not population-level personalization gains.

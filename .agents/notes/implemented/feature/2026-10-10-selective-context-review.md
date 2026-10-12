# Agent Note: Selective Context review feedback

Status: implemented

English | [中文](2026-10-10-selective-context-review.zh.md)

## Problem

An all-or-nothing recommendation sheet could not express that one old Chat constraint should be removed while a nearby current constraint should remain. Treating an unaccepted sheet as negative feedback would also confuse silence with an explicit Context preference.

## Decision

Each proposed Context change has a Keep-current control. The Client submits the exact accepted mutations and declined node IDs against the pending proposal and graph revision. The Host rejects foreign or duplicate declines, verifies that accepted mutations are exactly the remaining proposal actions, and records one \`contextify/recommendation-reviewed\` event with the full selection and its accepted/declined partition. A fully declined sheet records the choice without a Plan revision. A partially accepted sheet commits only its accepted mutations. Closing a sheet can preserve toggled node IDs in the dismissal event, but dismissal is not used for preference learning.

Fast review recovers Client-declared confirmed sheet choices from the Session family. Accepted actions retain their mode; declining an Include means keep Exclude, and declining an Exclude means keep Include. One sheet has total weight one across all its items. The bounded Fast packet carries fractional weights so the classifier can see reviewed examples, while the deterministic personal residual also consumes them. Legacy accepted \`node-choice\` events remain readable; a new reviewed event prevents counting its adjacent \`node-choice\` twice.

## Alternatives considered

**Apply or dismiss the entire sheet.** This loses the useful items whenever one proposed change is wrong and yields no item-level correction.

**Learn a negative label from every dismissed item.** Closing a sheet can mean postponement, so the policy only learns from a confirmed review.

## Consequences

Users can correct a recommendation without losing its useful items, and the next Fast review can suppress a repeated suggestion opposed by an explicit Keep-current choice. The Plan remains authoritative and no recommendation changes the next model request before confirmation. These events describe a Client path, not authenticated human identity; local behavior tests and a 30-turn browser replay establish the mechanism, not population-level personalization gains.

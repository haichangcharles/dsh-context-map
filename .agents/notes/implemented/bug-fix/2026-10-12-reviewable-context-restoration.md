# Agent Note: Reviewable restoration of temporary Context exclusions

Status: implemented

English | [中文](2026-10-12-reviewable-context-restoration.zh.md)

## Problem

In a long Chat, a user may accept an Agent suggestion to defer an old source while working on another stage, then return to a task that needs it. The Context Plan correctly preserves the Exclude, but the recommendation validator treated this temporary Agent-origin exclusion like a direct user ban. Even a relevant Include proposal could not reach review, and personal calibration could reinforce the earlier deferral.

## Decision

Contextify reconstructs the latest mutation of each currently excluded source from native Session events. An exclusion is eligible for a later Include proposal only when a Client-declared review accepted an Agent recommendation for that source and the matching review event follows its recorded Plan mutation. The bounded Fast packet marks such a node `reviewableExcluded`; the validator permits its Include proposal, and personal calibration does not suppress that same-source restoration because of the older exclusion. Direct Excludes, archived replacements, and sources without this review provenance remain protected. The Plan changes only after the user accepts the new proposal.

## Alternatives considered

- **Treat every Exclude as permanent for Agent review.** This loses a source when a temporarily deferred task returns.
- **Let the Agent reverse every Exclude.** This makes a direct user boundary indistinguishable from a temporary, accepted suggestion.
- **Restore automatically when task terms overlap.** Lexical overlap cannot establish user consent or whether an old constraint is still valid.

## Consequences

The Agent can manage the lifecycle of deferred Context without overriding direct user choices. Eligibility is reconstructed from logged Client-declared review provenance rather than inferred from model text; the marker does not authenticate a human or prove that the sheet was seen. A relevant source still depends on candidate routing and the classifier to produce an Include; the service regression proves the accepted restoration reaches the next compiled request, not that every long-chat return is detected automatically.

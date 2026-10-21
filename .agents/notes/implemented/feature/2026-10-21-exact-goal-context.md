# Agent Note: Exact task Context from a validated goal

Status: implemented

English | [中文](2026-10-21-exact-goal-context.zh.md)

## Problem

A complete task-preservation request and a per-source relevance review serve different purposes. The [Goal plus Jev reviewer](2026-10-18-goal-context-composition.md) admits source exceptions after resolving a native preservation base. Users who want exactly that base need a distinct choice that does not depend on a second model preserving every member.

## Decision

The optional `goal-model-native` Fast reviewer uses the existing Goal request and validated categorical assignment, then the native ownership/lineage resolver, route planner and Context compiler. It makes at most one chat-model request, resolves no Jev credential and sends no Jev request. Unit route values encode categories, not provider confidence. The default reviewer and existing Goal+Jev source-exception semantics are unchanged.

Only complete task-owned or task-lineage policies proceed. Unknown or relevance policies, unavailable provenance and recognized individual-source exception requests abstain. Natural-language exception recognition remains model-dependent; an incorrectly classified task-owned result still preserves that complete base. A new task-owned branch has empty history; its parent determines placement. Other destinations require the same exact draft accepted by the route planner. Missing, empty or truncated drafts cannot authorize a new-task scope without its Branch.

The Host retains the initial complete base independently of later planning. Before publishing it checks the final set, unavailable destinations and selected replacements. A manual choice or route conflict cannot silently weaken the exact scope. Approval, cancellation, stale-state validation and existing Undo/reset evidence remain authoritative. There is no new event, memory store, model provider, permission or preference weight.

The method borrows the operation-first decomposition from [SOM-DST](https://aclanthology.org/2020.acl-main.53/); it does not use its neural tracker or claim replication. The reusable implementation is the existing native product service.

The shared Goal input discloses a positive omitted-task count when the existing eight-candidate cap hides other native tasks. Both Goal reviewers receive the partial-inventory instruction. This retains the existing slate and legal IDs; it does not recover an omitted destination or certify that the model will abstain correctly. A missing count in a legacy packet is not proof of global completeness.

## Alternatives considered

**Clamp existing Jev output.** Rejected because source exceptions are supported behavior and no deterministic verifier certifies natural-language exception intent.

**Rely on stronger per-source prompts.** Rejected because they cannot guarantee a complete set. The native compiler already owns deterministic membership.

**Change the default or bypass approval.** Rejected because categorical task assignment can still be wrong, and exact preservation is a user-selected policy.

## Consequences

Supported reviews need no second auxiliary request and preserve the complete base beyond the scoring slate. The trade-off is loss of fine-grained borrowing and exclusions in this mode. Unknown or conflicting cases require another reviewer or manual management. These are scope and call-count guarantees, not measured improvements in semantic Branch/Return accuracy, latency, monetary cost, answer quality or authentic personalization. Inspector and historical proof rules do not change.

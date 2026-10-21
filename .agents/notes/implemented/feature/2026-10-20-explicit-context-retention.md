# Agent Note: Explicit Context retention before source exceptions

Status: implemented

English | [中文](2026-10-20-explicit-context-retention.zh.md)

## Problem

Task destination does not specify how much history to retain. Independent relevance scores can discard unrelated material despite an explicit preservation request, while a new task's parent can incorrectly contribute its Natural history. A bounded source slate cannot describe a complete large task scope.

## Decision

The existing opt-in goal request returns one categorical retention policy: relevance, task-owned, task-lineage or unknown. This adapts the operation-before-value decomposition in [SOM-DST](https://arxiv.org/abs/1911.03906); it does not reproduce its neural implementation or benchmark. DSH still owns the loop and native Session/Plan owns persistence. No extra inference call or persona store is introduced.

The Host computes preservation from the same frozen family inspections. Owned sources must belong to their owner's verified non-inherited event suffix. Lineage follows the complete immutable parent-header chain, not display parents that can collapse a fork at an inherited boundary. Missing or cyclic required provenance abstains before Jev. New task-owned has an empty historical base; the parent supplies placement only.

For preservation, admitted source questions ask final membership after explicit requested exceptions. Low answer relevance alone cannot remove base material; relevance alone does not request outside borrowing. Unasked base sources remain retained. The complete resolved set, including reviewed exceptions, governs active Continue and route scope. An explicit route conflicting with the assigned destination or new/existing category abstains from the whole automatic combination. Existing native validation preserves manual choices, replacement checks, cancellation, graph revisions and explicit approval. Unrelated statistical calibration cannot change a preservation proposal. Relevance retains fine-grained review; standalone Jev retains its separate wholeTask behavior.

Partial historical edits and owner relations do not identify a complete retention preference. The categorical request treats them as evidence, not an exhaustive mask. Existing confirmed-operation projection, Undo, disable and reset remain authoritative. New goal outputs require the retention field; saved historical model records are not reparsed or migrated.

## Alternatives considered

**Add an independent owned-only score beside wholeTask.** Rejected because simultaneous high scores leave the retention policy ambiguous.

**Use only per-source ranking or the bounded candidate mask.** Rejected because neither preserves unasked sources in a complete task. Allowing generated source IDs would also bypass native authority.

**Run a separate retention agent.** Rejected because the existing goal request can express the categorical operation without another loop, owner or model call.

## Consequences

The known-goal request changes; fresh provider quality remains unmeasured. Native fixtures exercise complete scopes beyond32 sources, Continue/Return/new-task composition, original ancestry, explicit borrowing and exclusions, and Undo. These are engineering acceptance, not real-user preference learning or improved real-data joint accuracy. The optional reviewer and all defaults retain their existing deployment policy.

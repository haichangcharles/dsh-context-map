# Agent Note: Reviewed Context scope handoff

Status: implemented

English | [中文](2026-10-16-context-scope-route-handoff.zh.md)

## Problem

A user who inspects a proposed Context before navigating to another task otherwise has to inspect it again at the destination. A second model review can change the source set and adds inference cost. Copying a source Plan directly is unsafe because its event sequences, natural membership and manual choices belong to its original Session.

## Decision

[Contextify](../../../../packages/context/contextify/README.md) supports explicit approval of the complete proposed Context together with Navigate, Return or a native fork under a reviewed parent. The Host revalidates the original route and family revision, reconstructs the desired set from canonical source IDs, and uses the destination's existing recommendation validator and atomic Plan operation. A missing source, a selected replacement in either Plan, conflicting destination Include/Exclude, busy or unavailable Agent, existing destination review, or concurrent revision change prevents the scope change. After its final storage read, the operation synchronously checks both live Agents, Plan revisions, source approval ownership and live family changes before committing. The deterministic operation DAG orders parent navigation, fork and scope application. Native parent metadata, rather than a rendered inherited-pivot parent, validates creation. A sibling scope starts from its selected parent’s Plan plus reviewed changes and explicit source Include/Exclude choices; the Client previews it separately from the current-branch proposal.

The [Client](../../../../packages/client/ui-contextify/README.md) retains the route-only action and provides a separate carry-Context button. Partial Keep-current decisions or destination replacements disable whole-set carrying while preserving draft-only routing. The destination approval log records `sourceBase`, identifying the original decision rather than claiming another inference. Standard reviewed-choice ownership and Undo remain on the destination. Historical examples remain management input and never become answer Context.

Jev's concrete placement and the native-validated proposed Context can corroborate an existing destination. When the Host identifies a joint Choice, matching placement scores and visible owned Context sources allow the existing Profile destination threshold to govern the review suggestion. Other inferred intents retain their generic threshold, and New-task keeps its stronger intent check. This is a consistency check, not multiplication of independent probabilities. Native visibility, supersession, competition, revision and human-review protections remain authoritative. The [personal decision cases note](2026-10-15-personal-context-decision-cases.md) owns historical evidence extraction.

## Alternatives considered

**Run another model review after every navigation.** Retained for route-only use, but unnecessary after the user approves an unchanged source set; it can introduce selection drift and extra cost.

**Copy the source Plan or apply it before moving.** Rejected because event sequences and natural membership differ across Sessions, and editing the source first invalidates the reviewed route revision. The desired source-ID set is revalidated at the destination instead.

**Override destination pins or silently carry Context with every route.** Rejected because a source review does not revoke an explicit destination choice or imply approval of Context edits. Conflicts stop the scope change, and carrying requires its own explicit action.

## Consequences

Carrying an accepted scope avoids a second inference for existing or new destinations, while preserving any errors already present in that scope. It does not establish semantic answer quality or personalization gains. Only the destination Plan change is atomic: the editor may already have moved the unsent draft when a scope conflict is reported; the Client attempts an exact-revision draft transfer back to the source on approval failure, preserving the destination draft if concurrent edits prevent restoration. A failed operation can leave an unused native child. An accepted route’s finished recommendation does not block a later reactivation; undecided reviews do. Native and Client tests cover scope preservation, provenance, idempotence, conflicts, concurrent changes, cleanup, and explicit approval; the assembled Web replay exercises the actual button and Remote operation without a provider API.

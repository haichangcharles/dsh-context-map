# Session Archive Restore Design

English | [中文](2026-08-18-session-archive-restore-design.zh.md)

**Status:** Approved for implementation

**Scope:** Add a native archived-Session list and reversible restore operation while preserving Workspace accounting, Session lineage, Context Plans, and Context Map viewing state.

## Product outcome

Users can inspect archived Sessions in the sidebar and restore one without interrupting the current conversation. Restore returns the same Session identity to the active Workspace tree and its connected Context Map family; it never creates a copy or replays an archive-time snapshot.

Archive remains a per-Session visibility operation. Archiving a parent does not archive its descendants, and descendants may continue receiving messages or gaining branches while the parent remains archived.

## Authoritative state

The registry-global `archivedSessionIds` set remains the only durable archive state. Session logs, `parentSessionId`, Context Plans, and Workspace `sessionIds` accounting remain authoritative in their existing owners.

`unarchiveSession(sessionId)` is the serialized inverse of `archiveSession(sessionId)`. For an archived Session, it verifies that the Session is still known and atomically removes only that ID from the archive set. A Session absent from the archive set is an idempotent success, which makes repeated restore and stale-tab actions safe. A known archive entry whose Session is unavailable fails without changing the set.

The RPC response and `host/archived-sessions-changed` frame continue carrying the complete committed archive set. The Host emits a frame only when membership changes. Concurrent archive, restore, Workspace, and registry operations use the existing registry operation queue; the last committed operation determines membership.

## Archived list

The Workspace sidebar header exposes an Archived Sessions control with the current count. It opens a browser-owned sidebar subview with Back navigation, a local title filter, and a list grouped by current Workspace accounting. Sessions whose Workspace registration was deleted appear under Ungrouped.

Rows show the Session title and parent title when available. The list is flat within each Workspace because only some members of a native lineage may be archived; indentation without visible ancestors would imply a false tree. Most recently archived IDs appear first according to Host archive order.

Each row has one Restore action. Restore disables only that row while pending. Success removes the row after the authoritative archive-set echo and returns it to the ordinary tree; it does not open the Session or change the current selection. Failure keeps the row available and shows a retryable inline error. A missing summary falls back to the stable Session ID so a damaged list projection does not make an archive entry impossible to inspect.

## Tree and Workspace placement

Restored Sessions use their current durable accounting rather than an archive-time placement snapshot. A retained Workspace slot returns the row to that Workspace and its shared order. If the Workspace registration was deleted while the Session was archived, the row returns under Ungrouped. Later Workspace reorder or accounting changes win over the historical location.

Native `parentSessionId` metadata restores lineage. An archived parent whose child stayed active returns above that child; a child created or extended during the archive interval remains attached. Restoring one Session does not restore any archived parent, child, or sibling.

## Context Map reattachment

Contextify continues loading the complete native Session family from live and persisted headers and logs. Archive filtering remains a client projection. Removing an ID from the archive set reprojects the complete family, restores canonical owners and edges, and includes any messages or branches created during the archive interval.

Canonical node IDs remain the original owner Session ID plus event sequence, so restore does not remap Context Plan entries. Include, Exclude, Natural, Undo, and Redo state stays in the original Session log and is never copied from another branch.

The Context Map store reconciles canvas selection against visible nodes but retains position overrides for every node in the complete family. Archiving therefore clears hidden nodes from transient batch selection without deleting user-arranged positions. Restore reuses those positions. Nodes that disappear from the complete family, rather than only from the archive projection, remain eligible for ordinary position cleanup.

## Conflict behavior

| Change while archived or restoring | Required result |
| --- | --- |
| Descendant receives messages | Restore adds the parent to the latest family without discarding descendant messages. |
| A new descendant branch is created | Restore uses persisted lineage and displays the new branch under the restored family. |
| Context Plan changes in a live descendant | Each Session keeps its own Plan; restore neither copies nor rewrites it. |
| Workspace is reordered or Session accounting changes | Restore follows the latest durable Workspace account and order. |
| Workspace registration is deleted | Restore places the Session under Ungrouped. |
| Two tabs restore the same Session | The first membership change wins; the second resolves idempotently from the full set. |
| Archive and restore race | Registry serialization commits both in order; the last committed membership is authoritative. |
| A stale `workspace.list` response arrives after a restore echo or frame | The existing generation guard prevents the stale archive set from replacing newer state. |
| Session becomes unavailable | Restore fails and leaves the archive entry intact. |
| Restored Session is not current | The current conversation and details panel remain unchanged. |

## Testing

Workspace-domain tests cover restore durability, idempotence, unavailable Sessions, restart recovery, and ordered archive/restore races. API tests cover schema validation, full-set responses, event emission only on membership changes, and reconnect baselines.

Client-runtime tests cover unary echoes, cross-tab frames, stale list responses, current-selection stability, and error propagation. Workspace UI tests cover grouping, filtering, missing summaries, row-local pending and retry behavior, Workspace deletion, and returning to the ordinary native lineage.

Context Map tests cover restoring an archived parent after descendant messages and new branches, canonical owner and edge recovery, unchanged Context Plans, preserved node positions, cleared hidden selection, and immediate reprojection while an unarchived descendant is active. A keyless assembled browser test exercises archive, descendant evolution, restore, tree placement, and Context Map navigation through the real Host and client composition.

## Acceptance criteria

1. Archived Sessions are discoverable and restorable from a dedicated sidebar list.
2. Restore changes only archive membership and never automatically opens a Session.
3. The same Session ID, log, Context Plan, native lineage, and current Workspace accounting survive archive and restore.
4. Descendant messages and branches created during the archive interval appear in the restored family.
5. Concurrent, repeated, cross-tab, and stale-baseline operations converge on the Host's complete committed archive set.
6. Restore failure never removes the archived row or publishes a false active state.
7. Context Map positions survive archive visibility changes, while hidden nodes leave transient canvas selection.
8. A deleted Workspace causes restored Sessions to appear under Ungrouped without recreating the Workspace.

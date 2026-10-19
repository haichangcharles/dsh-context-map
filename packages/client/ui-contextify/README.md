---
description: "Pinned Context Map for controlling Contextify conversation history"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-contextify

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-contextify` contributes an interactive Context Map tab to the upstream right sidebar. The map and message-level Chat controls share one Session-scoped controller and operate on the same durable Context Plan. The Start guide lists Context Map alongside Files; choosing an entry replaces the guide with that page.

## Table of Contents

- [User experience](#user-experience)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="user-experience"></a>
## User experience

Nonempty native Sessions, including ordinary forks, open the Map automatically. Addressed execution-detail subagents keep their own conversation controls and do not automatically open the native family Map.

The right subpage renders the connected native Session family with React Flow in one fixed top-to-bottom tree; no alternate layout mode is exposed. Each genuine user input, native Web observation, worker report, and completed Turn's final visible assistant output is one card; copied Session prefixes are de-duplicated, while intermediate assistant steps, incomplete output, reasoning, and non-Web tool events stay out of the graph. Each card has one effective-context checkbox: checked means the message enters the next model request, and unchecked means it does not. Natural derives that result from the active Session path; changing the checkbox away from that result writes the corresponding Include or Exclude override, while changing it back removes the override. Off-path Web results can be included only when their native call provenance and text content are available; off-path worker results and unbound Web results stay disabled. Selection mode remains a separate canvas operation with additive click, a visible Shift-drag marquee, and batch actions. Dragged nodes follow the pointer continuously and persist their final position only after release. Canvas selection and dragged positions are viewing state only and do not affect model input.

The first measured graph is framed once. Each React Flow card then reports its real bounding box back to Dagre, so the next rank starts below the prior card's actual bottom even for long outputs. After that, polling, font-driven remeasurement, and ordinary graph updates preserve the user's current pan and zoom; only search/Map focus requests deliberately move the viewport. `Re-layout` clears all manual drag positions, restores the deterministic tree coordinates, and frames the complete graph, providing an explicit recovery action when the canvas becomes difficult to read.

Programmatic viewport fitting preserves an open node menu; actual user movement, pane clicks and Escape dismiss it. This keeps delayed search or initial framing from removing an action during pointer interaction. See the [movement ownership decision](../../../.agents/notes/implemented/bug-fix/2026-10-14-context-map-move-ownership.md).

Controls, accessibility names, and count templates use the typed Client locale. Switching language refreshes graph-card labels without translating conversation text, Agent-authored reasons, or saved action values. Measured card dimensions survive graph refreshes. Search waits for its target to be measured, and only a new search or Map request moves the viewport after the initial framing; unrelated card remeasurement preserves the current pan and zoom.

Following the standalone canvas, node actions live in an opaque right-click menu: Locate in Chat, Branch from Here, Archive node, Restore automatic when a manual override exists, and Show original/Restore node after Archive. Branch calls Harness native `sessions.fork` at the message's completed Turn boundary, moves an unchanged unsent draft and its attachments into the empty child composer, records the successful manual fork and bounded transferred draft as a Context-policy choice, then opens the child. If the draft changed during the fork or the child cannot receive it, the current Session stays selected. Locate opens the owning native Session, switches to Chat, loads older history when required, and scrolls to and highlights the exact durable message. Batch mode includes, excludes, or restores multiple canvas-selected nodes in one plan revision. Clear manual changes removes every Include, Exclude, and Archive overlay without resetting graph layout; Undo and Redo operate on durable plan history.

The primary `Recommend` action runs zero-model Local review. Its adjacent `Recommendation mode` menu explicitly selects Local, Fast, or isolated Deep review; there is no automatic escalation. All modes use a Current → Proposed sheet over the visible graph, with separate source, route and lifecycle choices. Checkboxes retain current selection until confirmation. The user can keep any source item unchanged; one Apply accepts only selected items, and keeping every item leaves the Plan revision unchanged. Undo restores the previous selection. Archive remains per-node confirmation of a server-owned empty placeholder, with original content retained and restorable. Rendering records presentation rather than attention. Closing records only explicitly marked Keep-current items as partial rejection evidence, not a rejection of the whole sheet. Draft, graph or Plan changes invalidate old advice, and the Host rechecks before mutation.

Each manual recommendation first refreshes the native family and Plan. Failed reads and pending Plan writes prevent dispatch, even if an earlier graph remains visible. A newer request or cleared draft discards an older request still waiting for that read; an already-running reviewer refuses overlapping requests. Host revision checks still reject changes occurring after the read.

The composer shows **Review context for draft** for nonempty unsent text. Its default Local review makes no model call; the adjacent draft-mode control explicitly chooses Fast or Deep. Clicking review preserves the unsent draft and opens the Map. A changed draft discards the old proposal. A route card can propose Return, Navigate or Branch; acceptance transfers the unchanged draft and attachments through native services before switching, while Stay is an explicit rejection. A new-branch card can select a different parent, preview its proposed Context and apply both in one confirmation. If Host approval fails, the Client attempts to restore the unchanged transferred draft and attachments to the source; a concurrent edit that prevents restoration leaves the draft at the destination. A created unused child can remain.

The recommendation sheet exposes the exact conditional rules and management workflows supplied by the Host, including activity/depth conditions, signed support, bounded task examples and native Session/event references. It displays omitted-item counts when the input budget drops items. These historical records do not select answer Context or execute workflow steps.

The map header’s **Preferences** control reads the Profile policy on demand. It shows review support, repeated action tendencies and recent explicit choices with owning Session/event references. **Refresh** rereads evidence after an action or Undo. **Reset learned preferences** clears the derived learning through logged Session watermarks while retaining raw records and the current Context Plan. The view stores no second client-side persona.

The **Branches** disclosure lists each native Session's task lifecycle separately from its Active/Inactive position. **Move draft here** explicitly transfers a nonempty unchanged draft to a different native Session; an occupied destination is rejected, and passive Locate records no preference. Complete, Park, and Reopen are reviewed UI actions that append a native work-state event and refresh the graph. Completion does not exclude the branch's messages or remove its evidence; it stops a generic new-task route from treating that branch as its default destination. Explicit Resume can still return to it. A later user turn authored on a completed branch reopens it in the graph projection.

When a completed Q&A is confidently off-topic or better represented beside the current path, a compact non-modal card appears next to its final output. `Keep here` dismisses the decision; `Move to new branch` performs the idempotent native relocation and opens the new Session. Any unchanged draft for the next turn, including its attachments, moves to the child composer before navigation; if it changes during relocation, the current Session stays selected. The source cards remain as structural Archive placeholders, so the original graph pivot is not severed.

Profile Settings contains a Contextify Prompt Dashboard with separate Context, Archive, and Branch sections. The shipped prompt is visible but read-only and gray. Additional instructions are the normal editable path; replacing the shipped base requires an explicit unlock confirmation, and restoring the base does not discard appended rules.

The map also subscribes to Harness's native Workspace archive set. Nodes and edges that belong only to archived Sessions disappear immediately. Their canvas selection is cleared, but user-dragged positions are retained against the complete native family; restoring the Session therefore brings its nodes back at the prior coordinates. Messages inherited by an unarchived descendant remain visible because they are still part of that Session's context, but their Locate, Branch, and context-selection targets are rebound to the visible descendant rather than the archived owner. Archiving the active Session follows the ordinary Harness behavior and clears the current conversation.

Ordinary Chat user and finalized assistant messages expose compact Auto/Use/Skip/Map controls. They use the same controller as the graph, so a change made beside Chat appears in the map and survives reload. Steering, reasoning, tool, and runtime-only rows do not receive Context Map controls.

The Workspace sidebar uses the upstream Session list. The map provides the detailed branch-family navigation surface.

The Context prompt settings let users select the current chat model, Jev, or goal-model-plus-Jev for Fast review, and enable or disable historical choice reuse. A review sheet separates the examples sent to the model from deterministic calibration and branch-threshold source records; accepted and rejected choices remain distinct. These records describe management advice and are not added to answer Context.

For existing destinations, “Move draft with proposed Context” explicitly approves the complete reviewed source set and avoids another model call. Partial Keep-current choices disable that action. Destination manual conflicts preserve the old Plan; the unsent draft remains available at the destination. The route-only action remains separate.

The optional goal-model-plus-Jev reviewer makes one chat-model request and at most one Jev request for a draft. Its settings explain the additional cost; uncertainty skips Jev and inferred Context edits. No request occurs merely by selecting the reviewer.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host-owned Contextify plan and compiler selected by the controls.

#### KV Cache effect

The UI adds no prompt prose. Auto follows the active Session history, Skip excludes one historical message, and Use includes a same-family off-path message; changing an earlier selected message can reduce prefix reuse from that message onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Family updates use bounded 1.5-second polling while Chat or the map is subscribed.
- Automatic Branch review is opt-in for fresh Profiles, one-shot, concurrent, and invisible in the subagent roster.
- Cross-map import is not exposed.
- Contextify placeholders remain overlays on their original nodes; unrelated compaction relationships are not expandable.

<a id="dev-note"></a>
### Dev Note

No invariant companion is published because the Agent Loop companion checks compiled requests and the plugin owns no independent runtime invariant.

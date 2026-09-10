---
description: "Pinned Context Map for controlling Contextify conversation history"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-contextify

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-contextify` contributes an interactive Context Map tab to the upstream right sidebar. The map and message-level Chat controls share one Session-scoped controller and operate on the same durable Context Plan.

## Table of Contents

- [User experience](#user-experience)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="user-experience"></a>
## User experience

The right subpage renders the connected native Session family with React Flow in one fixed top-to-bottom tree; no alternate layout mode is exposed. Each genuine user input and each completed Turn's final visible assistant output is one card; copied Session prefixes are de-duplicated, while intermediate assistant steps, incomplete output, reasoning, and tool events stay out of the graph. Each card has one effective-context checkbox: checked means the message enters the next model request, and unchecked means it does not. Natural derives that result from the active Session path; changing the checkbox away from that result writes the corresponding Include or Exclude override, while changing it back removes the override. Selection mode remains a separate canvas operation with additive click, a visible Shift-drag marquee, and batch actions. Dragged nodes follow the pointer continuously and persist their final position only after release. Canvas selection and dragged positions are viewing state only and do not affect model input.

The first measured graph is framed once. Each React Flow card then reports its real bounding box back to Dagre, so the next rank starts below the prior card's actual bottom even for long outputs. After that, polling, font-driven remeasurement, and ordinary graph updates preserve the user's current pan and zoom; only search/Map focus requests deliberately move the viewport. `Re-layout` clears all manual drag positions, restores the deterministic tree coordinates, and frames the complete graph, providing an explicit recovery action when the canvas becomes difficult to read.

Following the standalone canvas, node actions live in an opaque right-click menu: Locate in Chat, Branch from Here, Archive node, Restore automatic when a manual override exists, and Show original/Restore node after Archive. Branch calls Harness native `sessions.fork` at the message's completed Turn boundary and opens the new child Session. Locate opens the owning native Session, switches to Chat, loads older history when required, and scrolls to and highlights the exact durable message. Batch mode includes, excludes, or restores multiple canvas-selected nodes in one plan revision. Clear manual changes removes every Include, Exclude, and Archive overlay without resetting graph layout; Undo and Redo operate on durable plan history.

The primary `Recommend` action runs Fast review. Its adjacent `Recommendation mode` menu lets the user deliberately choose Fast or Deep tree review; there is no automatic escalation. Fast sends a bounded candidate set, while Deep lets a restricted Harness child inspect a temporary complete-tree file with Read/Grep. Deep shows inline `Inspecting tree…` progress and can be cancelled without affecting Chat. Both modes use the same Current → Proposed review sheet over the bottom of the still-visible graph. The sheet summarizes added and removed nodes; card checkboxes continue to show the current version until the user applies the replacement once. Harmless no-op actions disappear instead of failing the proposal, and one Undo restores the whole prior version. Archive has no bulk execution: each candidate must be reviewed, shows evidence and graph impact, and can only be confirmed as the server-owned empty placeholder. The resulting card keeps the same node ID and graph structure, renders an empty body with `Original retained`, and adds `Show original` and `Restore node` to its right-click menu. Empty placeholder bodies do not participate in Map search. Closing, cancelling, or dismissing recommendations changes no durable state. A plan change, active Session change, or append in any parent, sibling, or descendant marks the proposal stale, and the Host repeats that check immediately before mutation.

When a completed Q&A is confidently off-topic or better represented beside the current path, a compact non-modal card appears next to its final output. `Keep here` dismisses the decision; `Move to new branch` performs the idempotent native relocation and opens the new Session. The source cards remain as structural Archive placeholders, so the original graph pivot is not severed.

Profile Settings contains a Contextify Prompt Dashboard with separate Context, Archive, and Branch sections. The shipped prompt is visible but read-only and gray. Additional instructions are the normal editable path; replacing the shipped base requires an explicit unlock confirmation, and restoring the base does not discard appended rules.

The map also subscribes to Harness's native Workspace archive set. Nodes and edges that belong only to archived Sessions disappear immediately. Their canvas selection is cleared, but user-dragged positions are retained against the complete native family; restoring the Session therefore brings its nodes back at the prior coordinates. Messages inherited by an unarchived descendant remain visible because they are still part of that Session's context, but their Locate, Branch, and context-selection targets are rebound to the visible descendant rather than the archived owner. Archiving the active Session follows the ordinary Harness behavior and clears the current conversation.

Ordinary Chat user and finalized assistant messages expose compact Auto/Use/Skip/Map controls. They use the same controller as the graph, so a change made beside Chat appears in the map and survives reload. Steering, reasoning, tool, and runtime-only rows do not receive Context Map controls.

The Workspace sidebar uses the upstream Session list. The map provides the detailed branch-family navigation surface.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host-owned Contextify plan and compiler selected by the controls.

#### KV Cache effect

The UI adds no prompt prose. Auto follows the active Session history, Skip excludes one historical message, and Use includes a same-family off-path message; changing an earlier selected message can reduce prefix reuse from that message onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Family updates use bounded 1.5-second polling while Chat or the map is subscribed.
- Automatic Branch review is enabled for fresh Profiles, one-shot, concurrent, and invisible in the subagent roster; it can be disabled in Prompt Settings.
- Cross-map import is not exposed.
- Contextify placeholders remain overlays on their original nodes; unrelated compaction relationships are not expandable.

<a id="dev-note"></a>
### Dev Note

No invariant companion is published because the Agent Loop companion checks compiled requests and the plugin owns no independent runtime invariant.

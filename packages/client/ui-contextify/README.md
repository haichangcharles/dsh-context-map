# @deepseek-ai/dsh-client-ui-contextify

English | [中文](README.zh.md)

`dsh-client-ui-contextify` keeps an interactive Context Map beside Chat in the pinned right details column. The map and message-level Chat controls share one Session-scoped controller and therefore operate on the same durable Context Plan.

## User experience

The right panel renders the connected native Session family with React Flow. Each visible user or assistant message is one card; copied Session prefixes are de-duplicated, while reasoning and tool events stay out of the graph. The panel supports zoom, pan, search, and tree, mind-map, or timeline layouts. Each card has one effective-context checkbox: checked means the message enters the next model request, and unchecked means it does not. Natural derives that result from the active Session path; changing the checkbox away from that result writes the corresponding Include or Exclude override, while changing it back removes the override. Selection mode remains a separate canvas operation with additive click, a visible Shift-drag marquee, and batch actions. Dragged nodes follow the pointer continuously and persist their final position only after release. Layout, canvas selection, and dragged positions are viewing state only and do not affect model input.

Following the standalone canvas, node actions live in the right-click menu: Locate in Chat, Branch from Here, and Restore automatic when a manual override exists. Branch calls Harness native `sessions.fork` at the message's completed Turn boundary and opens the new child Session. Locate opens the owning native Session, switches to Chat, loads older history when required, and scrolls to and highlights the exact durable message. Batch mode includes, excludes, or restores multiple canvas-selected nodes in one plan revision. Clear manual changes removes every Include and Exclude without resetting graph layout; Undo and Redo operate on durable plan history.

The map also subscribes to Harness's native Workspace archive set. Nodes and edges that belong only to archived Sessions disappear immediately. Their canvas selection is cleared, but user-dragged positions are retained against the complete native family; restoring the Session therefore brings its nodes back at the prior coordinates. Messages inherited by an unarchived descendant remain visible because they are still part of that Session's context, but their Locate, Branch, and context-selection targets are rebound to the visible descendant rather than the archived owner. Archiving the active Session follows the ordinary Harness behavior and clears the current conversation.

Ordinary Chat user and finalized assistant messages expose compact Auto/Use/Skip/Map controls. They use the same controller as the graph, so a change made beside Chat appears in the map and survives reload. Steering, reasoning, tool, and runtime-only rows do not receive Context Map controls.

The Workspace sidebar separately renders native Session ancestry as a recursive collapsible tree. The map remains the richer navigation surface for dense branch families.

## Model Experience

Indirectly, through the host-owned Contextify plan and compiler selected by the controls.

#### KV Cache effect

The UI adds no prompt prose. Auto follows the active Session history, Skip excludes one historical message, and Use includes a same-family off-path message; changing an earlier selected message can reduce prefix reuse from that message onward.

## Known Limitations and Deferred Work

- Family updates use bounded 1.5-second polling while Chat or the map is subscribed.
- Include/exclude recommendations are manual; automatic progression is deferred.
- Cross-map import is not exposed.
- Compaction replacement relationships are not expandable in the graph.

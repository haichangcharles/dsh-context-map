# @deepseek-ai/dsh-client-ui-contextify

English | [中文](README.zh.md)

`dsh-client-ui-contextify` keeps an interactive Context Map beside Chat in the pinned right details column. The map and message-level Chat controls share one Session-scoped controller and therefore operate on the same durable Context Plan.

## User experience

The right panel renders the connected native Session family with React Flow. Each visible user or assistant message is one card; copied Session prefixes are de-duplicated, while reasoning and tool events stay out of the graph. The panel supports zoom, pan, search, and tree, mind-map, or timeline layouts. Normal-mode node click cycles the one meaningful Natural/Include/Exclude override. Selection mode provides additive click, a visible Shift-drag marquee, and batch actions. Dragged nodes follow the pointer continuously and persist their final position only after release. Layout, selection, and dragged positions are viewing state only and do not affect model input.

Each node offers Natural, Include, Exclude, Open, Locate, and Branch actions where valid. Its right-click menu exposes Locate in Chat, Branch from Here, and explicit context modes without adding another backend. Branch calls Harness native `sessions.fork` at the message's completed Turn boundary and opens the new child Session. Locate opens the owning native Session, switches to Chat, loads older history when required, and scrolls to and highlights the exact durable message. Batch mode changes multiple selected nodes in one plan revision; Reset, Undo, and Redo operate on durable plan history.

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

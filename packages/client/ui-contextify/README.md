# @deepseek-ai/dsh-client-ui-contextify

English | [中文](README.zh.md)

`dsh-client-ui-contextify` keeps an interactive Context Map beside Chat in the pinned right details column. The map and message-level Chat controls share one Session-scoped controller and therefore operate on the same durable Context Plan.

## User experience

The right panel renders the connected native Session family with React Flow. Each visible user or assistant message is one card; copied Session prefixes are de-duplicated, while reasoning and tool events stay out of the graph. The panel supports zoom, pan, drag position overrides, multi-selection, search, and tree, mind-map, or timeline layouts. Layout, selection, and dragged positions are viewing state only and do not affect model input.

Each node offers Natural, Include, Exclude, Open, Locate, and Branch actions where valid. Branch calls Harness native `sessions.fork` at the message's completed Turn boundary and opens the new child Session. Open navigates to the owning Session. Locate focuses the corresponding graph node. Batch mode changes multiple selected nodes in one plan revision; Reset, Undo, and Redo operate on durable plan history.

Ordinary Chat user and finalized assistant messages expose compact Auto/Use/Skip/Map controls. They use the same controller as the graph, so a change made beside Chat appears in the map and survives reload. Steering, reasoning, tool, and runtime-only rows do not receive Context Map controls.

The Workspace sidebar separately renders native Session ancestry as a recursive collapsible tree. The map remains the richer navigation surface for dense branch families.

## Model effect

The UI adds no prompt prose. Auto follows the active Session history, Skip excludes one historical message, and Use includes a same-family off-path message through a durable compiler snapshot. The changed plan takes effect on the next admitted model request and can change token count and KV-cache prefix reuse.

## Known limitations and deferred work

- Family updates use bounded 1.5-second polling while Chat or the map is subscribed.
- Include/exclude recommendations are manual; automatic progression is deferred.
- Cross-map import is not exposed.
- Compaction replacement relationships are not expandable in the graph.

# @deepseek-ai/dsh-client-ui-contextify

English | [中文](README.zh.md)

`dsh-client-ui-contextify` places the Context Map in the conversation's pinned right details column. It opens that column once when the Web client starts, loads the current session's durable Contextify view and bounded graph pages through `ctx.remote.contextify`, and refreshes while mounted so newly appended chat messages appear without leaving the conversation.

Each node shows its event sequence, role, path, and bounded preview. A user can keep natural selection, force inclusion, force exclusion, or create a lightweight branch from that node. Path chips switch the active branch, and the mainline control returns without creating a new Session. Every mutation carries the displayed plan revision; stale edits fail safely and the panel shows the Remote error.

## Model Experience

Indirectly, through the `contextify/*` Remote methods its controls invoke: each accepted mutation updates the durable Contextify plan, and the next admitted model request contains the active causal path plus explicit inclusions, minus explicit exclusions. Tool exchanges remain closed groups. The panel itself adds no prompt prose.

#### KV Cache effect

None until a later model request uses the changed plan. Keeping the same selected prefix preserves its reusable cache prefix; switching paths or changing an earlier override can invalidate reuse from the first changed message.

## Known Limitations and Deferred Work

- The first version uses a compact card graph rather than freeform zoom and pan.
- Live updates use a bounded 1.5-second refresh until a dedicated projection channel is added.
- Compaction replacement relationships are not yet expandable in the graph.

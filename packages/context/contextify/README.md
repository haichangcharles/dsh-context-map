# @deepseek-ai/dsh-contextify

English | [中文](README.zh.md)

`dsh-contextify` stores a lightweight conversation graph inside one Harness Session and registers the `contextify@1` Context Compiler provider. A branch is a durable causal path, not a new Session: messages, tool facts, and request headers remain in the original append-only log.

## Current behavior

On `agent/session-start`, the plugin creates the initial root plan when absent and selects the Contextify compiler. Each plan snapshot records path ancestry, the active and mainline paths, and explicit include/exclude overrides. Each route assigns one turn to a path and parent node. Compilation walks the active path to its root, applies overrides, and always restores messages from the current turn.

The `contextify` service exposes generated Remote reads and compare-and-set mutations for graph paging, branch creation, path selection, returning to mainline, and natural/include/exclude node modes. Mutations are accepted only for the exact live idle Agent and the current plan revision. Assistant tool calls and their tool results form one closed selection group, so an override can never send a broken tool exchange to the model.

The compiler rejects non-monotonic plans, duplicate or cyclic paths, missing active paths, duplicate routes, stale route revisions, missing route parents, and overrides that reference no message node. Root-only histories remain equivalent to the ordinary Harness surface.

## Model Experience

### Selected conversation history

#### What the model sees

The model sees messages on the active causal path plus messages marked `include`. Historical messages marked `exclude` are omitted. Messages already written for the current turn remain visible regardless of an imported or stale override.

#### Token effect

Branching and exclusion can reduce input tokens by omitting unrelated history. Explicit inclusion increases input tokens by restoring selected durable messages. The plugin adds no prompt prose.

#### KV Cache effect

Staying on a path preserves its stable prefix. Switching paths or changing an earlier override can invalidate cache reuse from the first changed message.

## Known Limitations and Deferred Work

- **Bounded refresh latency** — the Web panel refreshes the graph at a 1.5-second interval while mounted; a dedicated Contextify projection/event channel can replace this polling later.
- **Compaction projection pending** — replacement events are not yet represented as expandable shadow relationships.
- **In-repository incubation** — the package currently lives in the Harness fork so its compiler seam, Remote boundary, and replay rules can be verified together; it can be extracted to a plugin repository after the API stabilizes.

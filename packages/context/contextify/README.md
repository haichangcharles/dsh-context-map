# @deepseek-ai/dsh-contextify

English | [中文](README.zh.md)

`dsh-contextify` turns a connected family of native Harness Session forks into one message-level Context Map and registers the `contextify@2` Context Compiler. It does not create a second branch model: every branch is an ordinary Session whose `parentSession` and `seedLength` remain owned by Harness.

## Current behavior

On `agent/session-start`, the plugin selects the Contextify compiler and creates a Natural plan when no plan exists. A newly forked child inherits the parent's event prefix but starts with its own Natural plan; context edits are never silently inherited.

The family projector walks from the native root Session through every descendant. It de-duplicates copied prefix messages by their earliest owning Session and emits one node for each visible appended `user/message` or text/image `assistant/message`. Reasoning-only assistant events, tool calls, tool results, context injections, and other runtime events are intentionally absent from the map. Both user and assistant nodes resolve to their enclosing completed `turn/end`, which is the boundary accepted by native Session fork.

The durable plan has three modes:

- **Natural** keeps a message when it belongs to the active Session's inherited or local history.
- **Exclude** omits one Natural historical message from the next compilation.
- **Include** copies a message from another Session in the same native family into a local `context/compiler-snapshot` event and inserts it at a stable position.

Every plan mutation is compare-and-set by revision and records complete undo/redo state. Reset returns to Natural. Cross-family references, unavailable messages, stale revisions, unsupported transitions, and non-idle Agents fail without a partial plan change. Cross-map import is deliberately out of scope.

The `contextify` Remote namespace exposes `get`, paged `familyPage`, `setNodeMode`, batched `setNodeModes`, `reset`, `undo`, and `redo`.

## Context Compiler contract

The ordinary Harness transcript remains append-only. Contextify changes only the message list compiled for a later model request:

- active-family messages are selected in their existing order;
- explicit exclusions are removed;
- included sibling messages are read from durable compiler snapshots; and
- messages from the current turn are restored so an old plan cannot hide the request being answered.

The compiler adds no prompt prose. Exclusion can reduce input tokens; sibling inclusion increases them. Any earlier change to the selected prefix can reduce KV-cache reuse from the first changed message.

## Known limitations and deferred work

- The Web client polls the family at 1.5-second intervals while a surface is subscribed; a dedicated projection event can replace this later.
- Automatic recommendations for which messages to include or exclude are deferred.
- Cross-map import is deferred; only Sessions connected to the same native root are addressable.
- Compaction replacement relationships are not expanded into shadow nodes.
- The package remains in this Harness fork while its compiler, Remote, replay, and UI seams stabilize.

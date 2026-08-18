# @deepseek-ai/dsh-contextify

English | [中文](README.zh.md)

`dsh-contextify` turns a connected family of native Harness Session forks into one message-level Context Map and registers the `contextify@2` Context Compiler. It does not create a second branch model: every branch is an ordinary Session whose `parentSession` and `seedLength` remain owned by Harness.

## Current behavior

On `agent/session-start`, the plugin selects the Contextify compiler and creates a Natural plan when no plan exists. A newly forked child inherits the parent's event prefix but starts with its own Natural plan; context edits are never silently inherited.

The family projector walks from the native root Session through every descendant. It de-duplicates copied prefix messages by their earliest owning Session and reduces each Turn to genuine user inputs plus, after a successful `turn/end`, the last visible text/image assistant message. Assistant text stays out of the graph while a Turn is running; earlier ReAct steps, intermediate questions, failed or interrupted partial output, reasoning-only assistant events, tool calls, tool results, context injections, and other runtime events are intentionally absent. Retained user and final-assistant nodes resolve to their enclosing completed `turn/end`, which is the boundary accepted by native Session fork.

The durable plan has three modes:

- **Natural** keeps a message when it belongs to the active Session's inherited or local history.
- **Exclude** omits one Natural historical message from the next compilation.
- **Include** copies a message from another Session in the same native family into a local `context/compiler-snapshot` event and inserts it at a stable position.

Every plan mutation is compare-and-set by revision and records complete undo/redo state. Reset returns to Natural. Cross-family references, unavailable messages, stale revisions, unsupported transitions, and non-idle Agents fail without a partial plan change. Cross-map import is deliberately out of scope.

The `contextify` Remote namespace exposes `get`, paged `familyPage`, `setNodeMode`, batched `setNodeModes`, `reset`, `undo`, and `redo`.

## Model Experience

### Compiled Context Plan

#### What the model sees

The ordinary Harness transcript remains append-only. Contextify selects active-family messages in their existing order, removes explicit exclusions, reads included sibling messages from durable `context/compiler-snapshot` events, and restores current-turn messages so an old plan cannot hide the request being answered.

#### Token effect

The compiler adds no prompt prose. Exclusion can reduce conversation-history input tokens; sibling inclusion increases them by the selected snapshot content.

#### KV Cache effect

Any earlier change to the selected message prefix can reduce KV-cache reuse from the first changed message onward. Leaving every node Natural preserves the ordinary Session message order.

## Known Limitations and Deferred Work

- The Web client polls the family at 1.5-second intervals while a surface is subscribed; a dedicated projection event can replace this later.
- Automatic recommendations for which messages to include or exclude are deferred.
- Cross-map import is deferred; only Sessions connected to the same native root are addressable.
- Compaction replacement relationships are not expanded into shadow nodes.
- The package remains in this Harness fork while its compiler, Remote, replay, and UI seams stabilize.

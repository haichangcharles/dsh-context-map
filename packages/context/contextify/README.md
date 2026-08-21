# @deepseek-ai/dsh-contextify

English | [中文](README.zh.md)

`dsh-contextify` turns a connected family of native Harness Session forks into one message-level Context Map and registers the `contextify@3` Context Compiler. It does not create a second branch model: every branch is an ordinary Session whose `parentSession` and `seedLength` remain owned by Harness.

## Current behavior

On `agent/session-start`, the plugin selects the Contextify compiler and creates a Natural plan when no plan exists. A newly forked child inherits the parent's event prefix but starts with its own Natural plan; context edits are never silently inherited.

The family projector walks from the native root Session through every native descendant; Sessions marked `origin: subagent` are execution details, not chat branches, and are excluded. It de-duplicates copied prefix messages by their earliest owning Session and reduces each Turn to genuine user inputs plus, after a successful `turn/end`, the last visible text/image assistant message. Assistant text stays out of the graph while a Turn is running; earlier ReAct steps, intermediate questions, failed or interrupted partial output, reasoning-only assistant events, tool calls, tool results, context injections, and other runtime events are intentionally absent. Retained user and final-assistant nodes resolve to their enclosing completed `turn/end`, which is the boundary accepted by native Session fork.

The durable plan has three selection modes:

- **Natural** keeps a message when it belongs to the active Session's inherited or local history.
- **Exclude** omits one Natural historical message from the next compilation.
- **Include** copies a message from another Session in the same native family into a local `context/compiler-snapshot` event and inserts it at a stable position.

Plan v3 also supports reversible, per-message **Archive** overlays for a user input or finalized assistant output. Archive is deliberately independent from context selection: the service replaces only the model-visible semantics with the fixed marker `[Placeholder: intentionally empty]`, without accepting Agent- or client-authored replacement text. The same graph node, role, edges, native fork boundary, and original append-only Session event remain intact. Restore removes only the overlay. Reset clears Include, Exclude, and Archive overlays; Undo and Redo replay all three. Existing v2 plans are normalized in memory without writing during reads, and existing v3 replacement snapshots—including older custom text—remain readable and restorable.

Every plan mutation is compare-and-set by revision and records complete undo/redo state. Reset returns to Natural. Cross-family references, unavailable messages, stale revisions, unsupported transitions, and non-idle Agents fail without a partial plan change. Cross-map import is deliberately out of scope.

Native branch ancestry is canonicalized for navigation. Re-forking from a boundary inherited from a parent produces a sibling of the existing branch; forking from a boundary created inside a branch produces its child. The graph continues to show the real shared message pivot either way.

The `contextify` Remote namespace exposes `get`, paged `familyPage`, review-only `recommend`, `cancelRecommendation`, `setNodeMode`, batched `setNodeModes`, `archiveNode`, `prepareBranchSuggestion`, `acceptBranchSuggestion`, `restoreNode`, `reset`, `undo`, and `redo`.

`recommend` has two manually selected modes. Fast is the default: one bounded, tool-free classifier reviews likely included and off-path candidates. Deep is explicit: Contextify writes the complete tree snapshot to a private temporary file, starts one restricted Harness child with only exact-file Read/Grep and structured-submit tools, and removes the file and child on success, failure, cancellation, or timeout. Neither mode appends its prompt, reasoning, or result to the parent Session, and neither mutates context before Apply. The shared validator compares output with the current effective set, filters harmless duplicate/no-op Include or Exclude actions, rejects unknown nodes and contradictory actions, and returns one complete Current → Proposed replacement. Applying that proposal is one compare-and-set plan revision, so Undo restores the previous version as a unit. Conservative Archive candidates remain advisory and require individual confirmation.

Automatic Branch review is enabled for fresh Profiles and can be disabled in the Prompt Dashboard. The tool-free classifier starts concurrently from the first human input and is bound to the exact final Q&A only after a successful Turn completes, so the main answer never waits for it. Its bounded packet contains the new input, the current and ancestor objectives, at most three recent local Turns, branch depth/load, and at most four sibling intents—not the complete tree, reasoning, or tool events. A dynamic high-confidence threshold suppresses noisy suggestions; malformed, failed, disabled, low-confidence, or stale reviews are silent. The model-facing `request_context_branch` tool remains available when automatic review is disabled: an explicit direct-human request schedules the same post-Turn confirmation card and never claims the branch was already created. Accepting a visible suggestion first uses the Harness Host's native before-Turn fork path to create a complete Agent-backed child at the preceding balanced boundary, then replays the exact Q&A into that child and archives the source input and final output with deterministic placeholders. A bare live Session is rejected, preventing ordinary navigation from racing persistence resume. The relocation has a deterministic key and is idempotent; it is rejected if either conversation advanced or the native child does not match the suggested boundary.

All three review agents use Profile-owned settings. Package default prompts remain the read-only baseline; users normally append additional instructions and may explicitly unlock a full override. Context selection, Archive advice, and Branch routing have independent sections and use the same Harness provider/model path as the parent Agent.

## Model Experience

### Compiled Context Plan

#### What the model sees

The ordinary Harness transcript remains append-only. Contextify selects active-family messages in their existing order, removes explicit exclusions, substitutes confirmed placeholder snapshots, reads included sibling messages from durable `context/compiler-snapshot` events, and restores current-turn messages so an old plan cannot hide the request being answered.

#### Token effect

The compiler adds no prompt prose. Exclusion can reduce conversation-history input tokens; sibling inclusion increases them by the selected snapshot content.

#### KV Cache effect

Any earlier change to the selected message prefix can reduce KV-cache reuse from the first changed message onward. Leaving every node Natural preserves the ordinary Session message order.

## Known Limitations and Deferred Work

- The Web client polls the family at 1.5-second intervals while a surface is subscribed; a dedicated projection event can replace this later.
- Enabled Branch review adds at most one small auxiliary model call per eligible Turn; users who prefer zero background classification can disable it per Profile.
- Cross-map import is deferred; only Sessions connected to the same native root are addressable.
- Contextify placeholders are overlays on existing nodes; unrelated compaction relationships are not expanded into shadow nodes.
- The package remains in this Harness fork while its compiler, Remote, replay, and UI seams stabilize.

# Native Session Context Map Design

**Status:** Approved for implementation

**Scope:** Replace Contextify's same-Session virtual paths with a graph projected from native Harness Session forks, and let the active Session compile its model context from message nodes in that graph.

## Product outcome

Harness presents a collapsible Workspace and Session tree on the left, the existing conversation stream in the center, and a real interactive Context Map on the right. The map visualizes one connected native Session family. The middle stream and right map expose the same message-level Branch and context-selection actions, so a user can navigate and control context without leaving the conversation.

The feature reuses the independent Context Map implementation in `/Users/haichangli/Documents/ChatGPT/harness/context_map` for graph layout and interaction patterns. Harness remains authoritative for Session identity, lineage, logs, navigation, and model requests.

## Terms

- **Workspace:** The existing Harness workspace. It is the product-level container and replaces the independent Context Map project's `Project` object.
- **Session:** A native Harness Session with its own durable log and Agent lifecycle.
- **Session family:** One root Session and all descendants connected through `parentSession`.
- **Context Map:** The visualization of one Session family.
- **Message node:** One visible `user/message` or `assistant/message` event. Reasoning and tool events are not graph nodes.
- **Natural node:** A message on the active Session's inherited or locally appended history.
- **Included node:** A message from another Session in the same family that the active Session explicitly imports.
- **Excluded node:** A Natural message that the active Session explicitly omits from model context.
- **Context Plan:** The active Session's durable, revisioned Include and Exclude decisions.

## Product hierarchy

The left sidebar renders native Session lineage rather than parsing titles:

```text
Workspace A
├── Session A
│   ├── Session A.1
│   │   └── Session A.1.1
│   └── Session A.2
└── Session B
    └── Session B.1
```

`Session A` and its descendants form one Context Map. `Session B` and its descendants form another. Every Workspace, root Session, and Session row can be collapsed independently. Titles such as `Session A.1` remain ordinary display titles; `parentSession` defines the hierarchy.

The initial release does not select messages across disconnected root Sessions. It supports importing messages between sibling or cousin Sessions only when they belong to the active Session's family.

## Native Branch behavior

Contextify does not maintain a second branch model. Every Branch action calls the existing native `sessions.fork` operation and creates a new child Session.

A user may invoke Branch from a user or assistant message in the center stream or right map. The UI resolves the selected message to the containing completed turn and passes the completed turn boundary to `sessions.fork`. The child becomes a real Session with its own ID, log, Agent lifecycle, title, navigation entry, and `parentSession` metadata.

After a successful fork, the client opens the child Session and the Session family projection adds a branch edge. A failed fork leaves the active Session and map unchanged and displays the existing Harness error treatment.

The child inherits the native stable message prefix copied by `ctx.sessions.fork`. The child does not inherit the parent's explicit Include or Exclude decisions. Contextify appends a reset Context Plan revision after child creation, because the native seed may contain parent Contextify events.

## Message graph projection

### Input data

The graph projection reads Session summaries for family membership and the relevant Session event windows for visible messages and fork boundaries. It does not introduce a mutable graph database.

### Canonical messages

Native forks copy a stable event prefix into each child Session. Rendering every copy would duplicate nodes, so the projection assigns one canonical graph identity to every inherited visible message.

A canonical message reference contains the family root, owning ancestor Session, owning event sequence, role, content hash, and provenance needed to locate the message in any Session that inherited it. The projection walks from the root toward descendants and maps events within each child's `seedLength` back to the parent's canonical identities. Events after `seedLength` belong to the child.

The projection rejects inconsistent lineage from the graph view rather than guessing. A Session with a missing parent remains a root in the sidebar until its parent summary arrives. A copied-prefix mismatch produces a diagnostic and treats the first mismatching visible event as child-owned, preserving navigation without merging unrelated content.

### Nodes and edges

Each visible `user/message` or `assistant/message` becomes one graph node. Reasoning chunks, assistant chunks, tool calls, tool results, turn markers, step markers, goals, and other events remain outside the visible graph.

Edges connect consecutive visible messages along a Session path. A child edge leaves the canonical message at the resolved fork turn boundary and enters the first child-owned visible message. If a child has no child-owned message yet, the graph renders a lightweight Session endpoint so the new branch remains discoverable without inventing a message node.

The active Session path is emphasized. Other family paths remain visible with reduced visual weight. Selecting another branch does not change the active Session until the user invokes navigation.

## Context Plan semantics

The active Session owns one revisioned Context Plan. Both the center conversation stream and the right graph read and mutate this plan.

For a message on the active Session path:

- `natural` means the message follows default history selection.
- `exclude` means the compiler omits the message and records the explicit override.
- `include` is not stored because a Natural message is already included.

For a message outside the active Session path but inside the same Session family:

- `natural` means the message is not imported.
- `include` means the compiler imports a durable snapshot of the message.
- `exclude` is not stored because an off-path message is absent by default.

The node action cycles between Natural and the one meaningful override for its location. Batch actions expose Include, Exclude, Natural, and Invert. Invalid combinations are normalized at the service method, not only hidden by the UI.

Reset to Natural appends a new empty Context Plan revision. Undo and Redo append new full-plan revisions that reproduce the selected historical plan; they never delete or rewrite Session events.

## Durable in-family imports

The existing Context Compiler selects event sequences that already belong to the active Session. A sibling Session's message does not satisfy that rule, so the compiler contract must support a durable local representation rather than reading a sibling log during a model request.

An Include mutation first writes an immutable `context/compiler-snapshot` event into the active Session log. The event records a stable item ID, source Session ID, source event sequence, source canonical message ID, role, message, timestamp, and content hash. The following Context Plan revision selects that local snapshot event. Removing an Include changes the next full-plan revision but does not mutate older events.

The Context Compiler continues to return event sequences:

```ts
interface ContextSelection {
  readonly eventSeqs: readonly number[]
}
```

The Context Compiler registry accepts ordinary surface message events and `context/compiler-snapshot` events. It resolves a snapshot from the message frozen inside that exact local event. The provider cannot select an in-memory message without a current-Session event sequence, so every model-visible input remains reconstructable from the active Session log.

The Contextify compiler orders selected Natural events by active Session sequence. Included snapshot-event sequences retain explicit plan order and are inserted at their configured positions. The first implementation defaults newly Included snapshots to the position chosen by their source timestamp among visible messages and lets the user reorder selected nodes with the existing Context Map ordering interaction.

## Hidden tool and reasoning data

Reasoning and tool events are not graph nodes and cannot be selected directly.

Excluding an assistant message does not expose or separately select its reasoning. Reasoning remains governed by the existing message derivation policy. Importing a sibling assistant message imports only the durable assistant message content snapshot, not raw reasoning chunks.

Tool protocol validity remains a compiler responsibility. When selected active-Session messages contain tool calls, the compiler includes the required matching tool results or rejects a plan that would create an invalid model transcript. Sibling imports do not import tool calls in the first release; an assistant snapshot containing provider-specific tool-call parts is rejected with a user-visible explanation instead of producing an incomplete tool exchange.

## User interface

### Three-column layout

The existing pinned details area continues to host Context Map on the right. Its default and minimum width follow the independent Context Map's usable canvas proportions. The user can resize and collapse it. Collapsing the map does not discard selection, viewport, or Context Plan state.

### Real graph canvas

The right panel replaces the vertical card list with `@xyflow/react` and Dagre-based layout adapted from the independent repository. It provides:

- pan, zoom, fit view, center, and rearrange;
- tree, mind-map, and timeline layouts;
- draggable nodes without changing Session lineage;
- node search with next and previous result navigation;
- click, multi-select, and marquee selection;
- active Session path and fork-edge highlighting;
- Natural, Included, and Excluded states using text or icons in addition to color;
- Locate in Chat, Navigate to Session, Branch, Include, Exclude, and Natural actions;
- batch Include, Exclude, Natural, and Invert actions;
- Reset to Natural and Context Plan Undo or Redo.

The graph ports layout algorithms and interaction components, not the independent Zustand domain store. Harness Session data, slot composition, remote calls, and CSS tokens remain authoritative.

### Conversation stream integration

User and assistant message hover actions expose Branch, Context state, and Locate in Map. These actions call the same injected callbacks used by graph nodes. Context state updates appear in the map and stream from one reactive Contextify view; neither component mirrors external data into private React state.

Selecting Locate in Map opens the right panel when necessary, changes to the message's family map, focuses the canonical node, and preserves the current Chat Session. Selecting Navigate to Session explicitly changes the Chat Session.

### Sidebar integration

The sidebar derives a recursive tree from the existing Workspace and Session summary hooks. Collapse state is UI viewing state stored in a client plugin store. Business Session summaries and lineage remain in the client runtime object layer.

## Service responsibilities

### Session family projection

A pure projection module builds roots, parent-child relations, canonical messages, paths, and graph edges from Session summaries and event inputs. It has no Cordis or React dependency and is covered by deterministic fixtures for root, child, sibling, grandchild, empty child, delayed parent, and copied-prefix mismatch cases.

### Contextify service

The server-side Contextify plugin owns durable Context Plan mutations, compare-and-swap revisions, snapshot validation, reset-after-fork behavior, and compiler registration. It removes `ContextPath`, `pathId`, `createBranch`, `selectPath`, `returnToMainline`, and `contextify/route` because native Sessions own those responsibilities.

The service exposes reads and mutations in terms of the active Session and canonical message references. Cross-family Include requests fail before appending an event. A stale plan revision fails with the existing compare-and-swap conflict response so the client can refresh and preserve the user's pending selection.

### Remote API

The remote API exposes family graph reads, the active Context Plan, node-mode mutations, batch mutations, reset, undo, and redo. Native Branch and navigation continue through the existing Session APIs rather than Contextify RPC methods.

### Client plugin

The client plugin composes through Harness slots. Its store contains only viewing state such as panel width, active layout, selected graph nodes, search query, viewport restoration key, and collapsed sidebar rows. Live family data and Context Plan state arrive through framework-bound hooks or injected callbacks.

## Independent Context Map feature adaptation

| Independent feature | Harness behavior |
|---|---|
| Graph nodes and edges | Port to the Session family projection. |
| Tree, mind-map, and timeline layouts | Port layout algorithms and controls. |
| Search, locate, zoom, pan, center, fit | Port directly with Harness styling. |
| Select, multi-select, marquee | Port directly. |
| Include, Exclude, Natural, Invert | Apply to the active Session Context Plan. |
| Branch | Call native `sessions.fork`. |
| Re-Branch | Fork again from the selected completed turn. |
| Return to parent | Navigate through `parentSession`. |
| Undo and Redo | Append a full Context Plan revision. |
| Reset to Natural | Append an empty Context Plan revision. |
| Edit message | Offer Edit and Branch; never mutate an existing log event. |
| Delete node | Offer Exclude or presentation-only Hide; never delete a durable message. |
| Promote branch | Set a display preference or continue from that Session; never rewrite lineage. |
| Custom mainline | Store a display preference without changing native ancestry. |
| Pattern or SOP extraction | Operate on selected message snapshots through a later artifact provider; retain an extension action but do not block the graph release. |
| Automatic Include suggestions | Excluded from this implementation. |

The migration preserves user capabilities where Harness durability permits them. It replaces destructive graph mutations with append-only Session or Context Plan operations.

## Error handling

- A stale Context Plan revision refreshes the view and reports that the context changed before the operation completed.
- A cross-family Include request fails without appending an event.
- A missing source message or content-hash mismatch fails snapshot creation rather than importing changed content.
- An unsupported sibling tool-call message remains Natural and shows why it cannot be imported.
- A fork failure preserves graph selection and active Session.
- An unavailable descendant log renders the Session branch with a loading or unavailable endpoint; it does not remove known lineage.
- A malformed durable Context Plan prevents Contextify compiler selection and surfaces a diagnostic. It never silently falls back to a different context.

## Testing strategy

### Pure unit coverage

- Session family construction for roots, siblings, grandchildren, missing parents, and cycles.
- Canonical message de-duplication across one and multiple fork generations.
- Fork edge placement at user and assistant messages through completed turn boundaries.
- Natural, Include, Exclude, batch, Invert, Reset, Undo, and Redo plan transitions.
- Snapshot provenance, content hash, same-family checks, and stale-revision conflicts.
- Context Compiler event and snapshot validation, ordering, replay, and tool-protocol rejection.
- Child plan reset after a seed containing parent Contextify events.

### Component coverage

- Graph renders one node per user or assistant message and no reasoning or tool nodes.
- Search, selection, layouts, Locate, Navigate, Branch, and node-mode controls invoke the expected injected callbacks.
- Chat and map reflect one Context Plan update.
- The details panel and each Workspace or Session tree row collapse and restore correctly.
- Keyboard and pointer interactions remain usable with large families.

### Assembled browser coverage

A replay-backed E2E scenario creates a root conversation, forks two child Sessions from different messages, opens the map, verifies canonical shared-prefix nodes, changes context from both Chat and Map, navigates between branches, reloads the application, and verifies the same tree and Context Plan. The scenario then submits a child request and inspects the recorded model input to prove that Excluded Natural messages are absent and Included sibling snapshots are present.

The existing details lifecycle E2E remains green. Visible changes update a keyless web replay snapshot. The final verification ladder includes focused package tests, `pnpm run test:gui`, typecheck and lint for changed packages, `DSH_SNAPSHOT=replay pnpm run test:web`, documentation gates, and a production web build.

## Implementation boundaries

This implementation includes native Session family visualization, recursive sidebar hierarchy, graph and Chat actions, message-level context control, in-family imports, durable replay, and tests from service through browser.

It excludes cross-map imports, automatic context recommendations, physical Session-log edits or deletion, native lineage rewriting, and an artifact backend for Pattern or SOP extraction. The UI may retain disabled or extension-point affordances for later providers, but it must not present excluded behavior as available.

## Acceptance criteria

1. Contextify contains no same-Session virtual branch or route model.
2. Branch from a user or assistant message creates and opens a native child Session at the containing completed turn.
3. The left sidebar displays collapsible Workspace and recursive Session lineage.
4. The right panel uses a real interactive graph with one node per visible user or assistant message.
5. Shared fork prefixes appear once, and branch edges connect to the correct canonical message.
6. Reasoning and tool events do not appear as graph nodes.
7. Chat and Map mutate and display the same active Session Context Plan.
8. Natural, Include, Exclude, batch, Invert, Reset, Undo, and Redo survive reload.
9. A Session can Include message snapshots from another Session in the same family and cannot import from another family.
10. Every model-visible imported message is reconstructable from the active Session log.
11. A new child starts with a Natural Context Plan even when its fork seed copied parent Contextify events.
12. Unit, component, replay-backed E2E, GUI, type, lint, documentation, and production-build checks covering the changed behavior pass.

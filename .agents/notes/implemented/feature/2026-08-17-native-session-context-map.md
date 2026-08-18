# Agent Note: Native Session Context Map

Status: implemented

English | [中文](2026-08-17-native-session-context-map.zh.md)

## Problem

Long-horizon conversations need two related capabilities: navigating branches and deciding which historical messages enter the next model request. Harness already owns durable Session forks, while the earlier Context Map prototype owned an incompatible in-Session path model. Keeping both branch systems would make navigation, persistence, naming, and model context disagree.

## Decision

One native root Session and all descendants form one Context Map. A branch is always `sessions.fork` at a completed Turn boundary. The graph has one node per visible appended user or assistant message, de-duplicates copied prefixes, and excludes reasoning, tool, and runtime-only events.

Every Session owns a durable Context Plan. A child inherits the event prefix but resets the plan to Natural. Natural follows its Session history; Exclude removes an active historical message; Include snapshots a message from another Session in the same family. Cross-map import and automatic include recommendations are deferred.

The right-side React Flow map and per-message Chat controls share one controller. Both persist only Harness-native Natural/Include/Exclude. The map presents that contract as one effective-context checkbox: Natural resolves from active-path membership, while a result that differs from the path compiles to Include or Exclude. Returning the checkbox to the path result writes Natural and removes the manual override. The map additionally supports native Branch, Session navigation, search, three layouts, multi-select batch changes, clearing all manual changes, and plan Undo/Redo. The Workspace sidebar shows the same Session ancestry as a recursive collapsible tree.

The canvas ports the standalone prototype's interaction model without its domain store. The checkbox is the only ordinary click target that changes effective context; card clicks in normal mode do not mutate the plan. Selection mode owns additive card click and visible Shift-marquee selection, and a floating action bar applies effective include, effective exclude, or restore-automatic batch changes. Checkbox events are isolated from React Flow dragging and canvas selection. Right-click exposes Locate in Chat, Branch from Here, and Restore automatic only for a manual override. Node positions update in transient React state throughout a drag and enter the persisted viewing store only at drag completion.

Locate in Chat delegates to the conversation package through a native Session ID and durable message sequence. The conversation service opens the owning Session, switches its native view ring back to Chat, loads older history pages until the message anchor is available, scrolls that row to the center, and marks it with a temporary highlight. Contextify never queries or owns conversation DOM.

The client projects the graph through the Workspace runtime's native archive set. Archived-only paths are removed. A message inherited by a visible descendant remains in the graph, but its owner reference, lineage depth, and every action target are rebound to an unarchived Session; this preserves useful context without navigating back into a hidden Session. Archiving the active Session remains owned by the Workspace runtime and clears the current selection normally.

## Alternatives considered

**A second in-Session path model.** The standalone prototype used lightweight paths inside one Session, but retaining that identity alongside native Session forks would make persistence, navigation, naming, and context selection disagree.

**A separate Context Map page.** A full-page map offers more space, but it prevents users from reading Chat while deciding which history the next request receives. The pinned details column keeps navigation and compilation control beside the conversation.

**Cross-map imports in the first release.** Arbitrary imports would require a second discovery, authorization, and provenance design. Same-family Include proves the compiler and interaction model without expanding the initial data boundary.

## Append-only compatibility

Context changes never edit or delete transcript events. Include writes `context/compiler-snapshot`; plan changes write complete revisioned `contextify/plan` events. The `contextify@2` compiler selects model messages at request time, restores current-turn messages, and leaves the ordinary Harness surface intact.

## Testing

Pure projection and compiler tests cover canonical prefix de-duplication, native fork boundaries, Context Plan revisions, same-family snapshots, child reset, and runtime-context filtering. Client component tests cover effective checkbox projection, automatic override removal, optimistic failure rollback, checkbox event isolation, Selection clicks, Shift marquee, batch mutations, right-click actions, archive-aware path removal and owner rebinding, transient and committed drag positions, Session-and-sequence reveal, native Chat-tab activation, history paging, exact scrolling, and temporary highlighting. Browser-plugin tests pin Contextify's delegation to native Session, conversation, layout, and Remote faces. Web E2E archives a native parent while its child is active, then verifies map retention, Locate, plan mutation, and reload.

## Deferred

Cross-map import, automatic recommendations, compaction shadow relationships, and a push projection channel are intentionally deferred.

## Consequences

Harness has one branch authority and one context authority while the pinned canvas retains the standalone prototype's direct manipulation. Separating transient drag and canvas-selection state from Context Plan state prevents canvas gestures from creating durable model-input changes; routing message reveal through conversation keeps DOM ownership inside the package that renders it. The effective checkbox removes a three-state presentation from the frequent path, but the source distinction remains available through Restore automatic and Clear manual changes. This adds an in-memory reveal registry and exact message anchors to conversation, and a Locate request can page older history before it settles. Large Session families can still make the graph and polling projection expensive; bounded paging and subscriber-only polling limit that cost, but a push projection may still be required. Explicitly changing older messages can reduce KV-cache prefix reuse, so Natural remains the default and manual overrides persist until the user restores them.

# Agent Note: Native Session Context Map

Status: proposed

English | [中文](2026-08-17-native-session-context-map.zh.md)

## Problem

Long-horizon conversations need two related capabilities: navigating branches and deciding which historical messages enter the next model request. Harness already owns durable Session forks, while the earlier Context Map prototype owned an incompatible in-Session path model. Keeping both branch systems would make navigation, persistence, naming, and model context disagree.

## Decision

One native root Session and all descendants form one Context Map. A branch is always `sessions.fork` at a completed Turn boundary. The graph has one node per visible appended user or assistant message, de-duplicates copied prefixes, and excludes reasoning, tool, and runtime-only events.

Every Session owns a durable Context Plan. A child inherits the event prefix but resets the plan to Natural. Natural follows its Session history; Exclude removes an active historical message; Include snapshots a message from another Session in the same family. Cross-map import and automatic include recommendations are deferred.

The right-side React Flow map and per-message Chat controls share one controller. Both can apply Natural/Include/Exclude. The map additionally supports native Branch, Session navigation, search, three layouts, multi-select batch changes, and plan Reset/Undo/Redo. The Workspace sidebar shows the same Session ancestry as a recursive collapsible tree.

## Append-only compatibility

Context changes never edit or delete transcript events. Include writes `context/compiler-snapshot`; plan changes write complete revisioned `contextify/plan` events. The `contextify@2` compiler selects model messages at request time, restores current-turn messages, and leaves the ordinary Harness surface intact.

## Acceptance criteria

- Native Session lineage is the only branch identity.
- User and assistant messages can branch only through a completed `turn/end`.
- Reasoning and tool events never appear as map nodes.
- Chat and map changes update one durable, revisioned plan.
- Same-family sibling messages can be included; active-path historical messages can be excluded.
- Child plans reset to Natural and changes survive reload with undo/redo.
- The right map remains visible beside Chat, and the left Session tree is recursively collapsible.

## Deferred

Cross-map import, automatic recommendations, compaction shadow relationships, and a push projection channel are intentionally deferred.

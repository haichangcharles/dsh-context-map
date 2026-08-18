# Context Map Right Subpage and Final Output Design

English | [中文](2026-08-18-context-map-right-subpage-final-output-design.zh.md)

**Date:** 2026-08-18

**Scope:** Make Context Map a tree-only subpage of Harness's native details column and project only genuine user inputs plus one completed final assistant output per turn.

## Product behavior

The native right details column remains the only right-side container. When Context Map is installed, the column offers two mutually exclusive subpages: Context Map and the selected Tool details. Opening a Tool selects the Tool page; a Context Map locate action selects the Context Map page. Switching pages preserves the Tool selection and Context Map viewport/state. The native column border, resize handle, width concession rules, and close behavior remain owned by `client-ui-layout` and are not reimplemented.

Context Map always renders the top-to-bottom tree arrangement. No layout selector, mode name, or alternate-layout affordance is shown. Existing persisted `mindmap` or `timeline` values are ignored by the product surface, so every opening renders the tree.

## Canonical message nodes

The graph is derived from native Session turn boundaries rather than individual visible message events:

- A genuine `user/message` with `source.kind === "user"` remains the input node.
- While a turn is open, the input may appear immediately, but assistant events do not appear in the Map.
- On `turn/end`, the last visible `assistant/message` in that turn is the only assistant node retained when the turn completed successfully.
- Earlier assistant steps, tool-call narration, intermediate questions, reasoning-only messages, Tool results, plugin/system injections, and incomplete/aborted/error turn output never become graph nodes.
- The retained final assistant node and the input use the same completed `turn/end` sequence as their branch boundary.

This is a projection rule only. Context compilation continues to use the native Session log and Context Plan; the Map does not delete or rewrite Harness events.

## Native details navigation

`ui-conversation` owns a small, session-scoped, in-memory details-page registry with `pinned` and `tool` requests. Tool inspection requests `tool`; Contextify requests `pinned`. `DetailsPanel` renders only the active page but keeps the underlying state in its existing stores/controllers. When no Tool is selected, the Tool tab is disabled and the pinned page is selected. The registry is view state and is not persisted.

## Tests

- Contextify family projection proves multi-step assistant text collapses to the final completed output and open/failed turns do not leak partial output.
- Context Map component tests prove layout controls and layout-mode labels are absent even with an old alternate layout value in the store.
- Conversation assembly tests prove the pinned and Tool pages switch without clearing Tool selection.
- Contextify browser-plugin tests prove Map actions request the pinned page and Tool actions request the Tool page.
- Layout tests continue to prove the native details drag handle and width ownership; no Contextify code changes those files.

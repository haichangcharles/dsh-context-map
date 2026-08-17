# Context Map Canvas Interaction Design

English | [中文](2026-08-17-context-map-canvas-interactions-design.zh.md)

**Status:** Approved for implementation

**Scope:** Restore the independent Context Map canvas interaction model in the Harness right panel without introducing a second context, branch, or message-navigation backend.

## Product outcome

The right-side Context Map behaves like the independent Context Map canvas while every durable action remains a projection of native Harness state. Users can manipulate context directly on the canvas, select several message nodes, arrange the graph with live feedback, and locate a graph message in Chat. The canvas does not own Session lineage, message content, or Context Plan decisions.

## Interaction modes

The canvas has Normal and Selection modes.

In Normal mode, clicking a node cycles the meaningful Context Plan override for that node. A Natural node on the active Session path cycles to Excluded and back to Natural. A Natural node outside the active path cycles to Included and back to Natural. Nodes remain draggable in this mode.

In Selection mode, clicking a node toggles additive selection and Shift-drag draws a visible marquee that selects intersecting nodes. Node dragging is disabled so selection gestures cannot move the graph. A floating action bar applies Include, Exclude, or Natural to the selected nodes and can clear the selection. Invalid node-mode combinations are normalized by the existing Contextify service.

## Context menu

Right-clicking a message node opens a canvas menu positioned at the pointer. The menu offers Locate in Chat, Branch from Here, Natural, Include, and Exclude. It closes after an action, outside click, Escape, viewport movement, or panel close.

Locate in Chat opens the owning native Session when necessary, waits for the conversation view to render, scrolls the durable message sequence into view, and briefly highlights it. Branch from Here calls the existing native Session fork operation. Context-state actions call the existing Context Plan mutations.

The menu excludes Delete, custom mainline changes, and pattern extraction because Harness has no native operation with those semantics.

## Live graph manipulation

React Flow applies position changes to transient client nodes on every pointer movement, so a dragged node follows the pointer continuously. Drag completion writes the final coordinates to the existing Contextify viewing store. Context Plan and Session data never enter this transient state.

Changing layouts or resetting the canvas clears or replaces the applicable position overrides through the existing viewing-store actions. Undo and Redo continue to operate on Context Plan history, not node coordinates.

## Chat location contract

Graph-to-Chat navigation uses a narrow conversation UI contract keyed by native Session ID and durable message sequence. Contextify requests a reveal; the conversation package owns DOM anchors, scrolling, and highlight timing. Contextify does not query conversation DOM structure directly.

Every rendered user and final assistant message exposes a stable anchor for its durable sequence. A reveal request made before Session switching or message rendering remains pending until the matching anchor mounts, then expires after successful focus or a bounded timeout. Failure to find a removed or unavailable message leaves the current view usable and surfaces the existing non-blocking error treatment.

## State ownership

- Native Session APIs own Branch and Session activation.
- The Contextify service owns Natural, Include, and Exclude decisions.
- The conversation UI owns message anchors and scrolling.
- The Contextify viewing store owns layout, selection, and persisted position overrides.
- React-local canvas state owns drag-in-progress positions, marquee geometry, and the open context menu.

## Accessibility and input

The Selection toggle and batch actions are keyboard reachable and expose pressed or disabled state. Escape closes the context menu or clears the active marquee. Node cards expose their role, message preview, and state to assistive technology. Selection and context state use labels or icons in addition to color.

## Testing

Component tests drive the real canvas callbacks and first fail for missing behavior. They cover Normal-mode click cycling, Selection-mode additive click, Shift-marquee selection, batch mutations, context-menu actions and dismissal, live position updates before drag end, persisted coordinates after drag end, and disabled dragging during Selection mode.

Conversation integration tests prove that Locate in Chat opens the owning Session, waits for its message anchor, scrolls it into view, and applies temporary highlighting. Existing projection tests continue to prove that only user and final assistant messages appear and that actions mutate Harness Context Plan and native Session state.

The visible integration is verified with focused package tests, `pnpm run test:gui`, and a replay-backed web scenario that right-clicks a graph node, locates the matching Chat message, multi-selects nodes, applies a batch context state, and drags a node with intermediate visual movement.

## Acceptance criteria

1. Normal-mode node click cycles only the meaningful Harness Context Plan override.
2. Selection mode supports additive click and visible Shift-marquee multi-selection.
3. Selected nodes can be changed to Include, Exclude, or Natural from the canvas action bar.
4. Right-click exposes Locate in Chat, Branch from Here, Natural, Include, and Exclude.
5. Locate in Chat reveals and highlights the exact native user or assistant message, including after switching Sessions.
6. Node dragging updates continuously and persists only the final coordinates.
7. Selection mode prevents node dragging and does not mutate context until a batch action runs.
8. Canvas UI state does not duplicate Session lineage, message content, or Context Plan authority.

# Context Map Effective Selection Design

English | [中文](2026-08-18-context-map-effective-selection-design.zh.md)

**Status:** Approved for implementation

**Scope:** Replace peer-level Natural, Include, and Exclude controls in Context Map with one effective-context checkbox while preserving the native Context Plan representation.

## Product outcome

Each message node presents one primary fact: whether the message enters the next model request. Users can temporarily add an off-path message or remove an active-path message, keep that choice across several turns, and return to Harness automatic behavior without understanding Context Plan storage values.

## Two-layer state model

The visible checkbox represents the effective context result. A checked node enters model context and an unchecked node does not.

Harness continues to store an optional manual override. An absent override uses the automatic result derived from the active native Session path; an Include or Exclude override replaces that result. Natural therefore means absence of a manual override, not a third effective selection state.

| Automatic result | Manual override | Checkbox |
| --- | --- | --- |
| In context | None | Checked |
| In context | Exclude | Unchecked |
| Out of context | None | Unchecked |
| Out of context | Include | Checked |

## Checkbox behavior

The checkbox replaces the Natural, Include, or Exclude badge on each node. Pointer events on the checkbox do not initiate React Flow dragging or canvas selection.

Changing the checkbox away from the automatic result writes the required Include or Exclude override. Changing it back to the automatic result removes the override and returns the node to Natural automatically. Clicking an already resolved value is a no-op and never creates a redundant override.

The checkbox updates optimistically, becomes unavailable while its mutation is pending, and rolls back if the mutation fails. The panel displays the mutation error. Node dragging remains available outside the checkbox, so click-versus-drag arbitration cannot delay the context action.

## Manual override lifetime

A manual override belongs to the active native Session Context Plan and persists across turns, page reloads, and panel close or reopen. Harness never expires it after an implicit number of turns.

The user returns to automatic behavior by changing a node back to its automatic checkbox value, choosing Restore Automatic for that node, or clearing every manual override through Reset. These operations remove overrides; they do not force all nodes checked or unchecked.

## Reset and menu actions

Reset is labeled Clear Manual Changes and removes all Include and Exclude overrides in the active Session Context Plan. Undo and Redo continue to restore Context Plan revisions.

The node context menu keeps Locate in Chat and Branch from Here. It shows Restore Automatic only when the node has a manual override. Include and Exclude are not presented as peer-level node states because the checkbox already expresses the effective result.

## Canvas selection

Effective context state and canvas multi-selection remain independent. Checkbox state communicates model input. Selection mode uses a separate outline and the phrase selected nodes only for batch targeting.

The panel header reports the effective result as, for example, `6 / 8 in context`. Batch actions set the selected nodes in context, set them out of context, or restore automatic behavior. A batch action removes redundant overrides when its requested effective result already matches a node's automatic result.

## Native ownership

The Contextify service remains authoritative for automatic path membership, manual overrides, plan revisions, and compilation. The UI derives checkbox state from the active Session path plus the stored override and sends existing Natural, Include, or Exclude mutations. No second context-selection store or model-side classification step is introduced.

## Testing

Component tests cover automatic checked and unchecked nodes, checkbox event isolation from drag and canvas selection, optimistic pending state, rollback with a visible error, and automatic override removal when the checkbox returns to its default result.

Service and browser tests cover persisted manual choices across turns and reload, per-node Restore Automatic, Clear Manual Changes, Undo and Redo, batch normalization, and unchanged compiled context for equivalent native Context Plans.

## Acceptance criteria

1. Every message node exposes one effective-context checkbox instead of three peer-level state controls.
2. Checkbox interaction never initiates node drag, canvas selection, or branch navigation.
3. A value different from the automatic result persists as the correct manual Include or Exclude override.
4. A value equal to the automatic result removes the manual override and restores Natural.
5. Manual overrides persist until an explicit per-node or whole-plan restore operation.
6. Clear Manual Changes removes all manual overrides without changing layout, node positions, or Session lineage.
7. Pending mutations prevent duplicate writes, update optimistically, and roll back with a visible error on failure.
8. The header, batch selection, and node menu distinguish effective context from canvas multi-selection.

# Context Map Deterministic Empty Placeholder Design

English | [中文](2026-08-19-context-map-empty-placeholder-design.zh.md)

## Goal

When a user confirms removal of one Context Map message's semantics, retain the message node as a physical graph pivot while making it visually empty. Preserve its role, node identity, edges, native branch boundary, selection state, and ability to restore the original message.

## Decision

Contextify owns one constant model-facing marker:

```text
[Placeholder: intentionally empty]
```

The recommendation Agent may identify cleanup candidates and explain why they look obsolete, conflicting, or redundant. It cannot supply, edit, or rewrite placeholder content. After explicit user confirmation, the service constructs the marker itself and stores it in the existing role-preserving compiler snapshot overlay.

The client recognizes a replacement from durable Contextify replacement metadata and renders no message body for it. The card therefore contains only its existing `USER` or `ASSISTANT` chrome and controls. The marker remains model-visible because a non-empty message is more portable across model providers than whitespace-only content.

## Data and control flow

1. The isolated recommendation Agent returns a cleanup candidate containing a node ID, category, reason, and evidence node IDs. Placeholder text from model output is ignored and removed from the public cleanup contract.
2. The review sheet shows the original content and the fixed outcome “Empty placeholder”; it offers Keep original or Confirm empty placeholder. There is no placeholder text editor.
3. Confirmation calls `replaceNode` without user- or model-authored replacement text. The service writes the package-owned constant into a `context/compiler-snapshot` with the original message role.
4. The Context Plan records the existing reversible replacement overlay. It does not delete or rewrite the native Session event.
5. Graph projection retains the original node ID and topology, decorates it as a placeholder, and exposes the complete original only for Show original.
6. Context compilation substitutes the fixed marker. Restore removes the overlay and restores the original semantics while retaining Include/Exclude state.

## Compatibility

Existing version 3 replacements containing custom text remain readable and restorable. New replacements always use the fixed marker. The UI treats every replacement overlay as an empty placeholder, so old custom replacement text is not shown on the graph. No Session format or Context Plan version bump is needed because the stored shape is unchanged.

## Failure behavior

- Cleanup remains recommendation-only until explicit confirmation.
- A stale family or plan revision fails before writing the marker.
- Missing or role-incompatible source messages fail without a partial plan mutation.
- Restore continues to fail closed when the original source is unavailable.

## Verification

- Service test: Agent-authored placeholder text cannot affect the stored snapshot; confirmation always compiles the fixed marker with the original role.
- Client test: the placeholder node has an empty body, unchanged ID and edges, and retains Include/Exclude, Branch, Locate, Show original, and Restore.
- Client test: the cleanup review has no editable placeholder field.
- Regression test: legacy custom replacements remain readable and restorable.
- Assembled Web test: recommendation alone is inert; confirmation creates a visually empty node whose compiled message is the fixed marker; restoration returns the original.

## Out of scope

This change does not physically delete Session events, create paired Q/A nodes, allow Agent-authored summaries, or change native Harness branching.

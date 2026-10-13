# Agent Note: Natural Context choices supply preference evidence

Status: implemented

English | [中文](2026-10-14-natural-preference-evidence.zh.md)

## Problem

A long Chat can borrow evidence from another branch, release it with Natural, and borrow it again later. The Context Plan and the personal Context ranker recorded these changes correctly, but the Profile projection omitted every Natural choice. Recent choices and Include/Release support therefore hid a confirmed change that the Context ranker already learned.

## Decision

For one changed, Client-confirmed direct edit with a known graph target, the Profile interprets Natural by native Session membership: restoring active-path material supplies Include evidence; removing an off-path import supplies Release evidence. The observation retains its owning Session, event cursor, target node and source kind. An unknown target supplies no Natural label. Unchanged operations, unmarked calls and batch edits remain excluded; Undo retains the audit observation but removes its active support, and Redo restores it.

## Alternatives considered

- **Keep Natural out of policy memory.** This makes preference inspection disagree with the applied Context change.
- **Always label Natural as Include.** This reverses the meaning of releasing a borrowed branch source.
- **Infer membership for missing targets.** Parent recovery can change canonical node IDs; absent graph evidence must cause abstention.

## Consequences

Profile evidence and Context preference examples agree on the effect of explicit restoration. Context examples remain bounded in the Fast selection packet; its separate semantic route packet continues to carry route and lifecycle examples only. No automatic selection, graph mutation, model request, or persona claim is added.

## Testing

Native public-service regressions cover Include followed by off-path Natural and Exclude followed by active-path Natural. They verify Profile observations, owned event provenance, the bounded Context example packet, Undo/Redo and unchanged restoration. A real missing-parent recovery verifies abstention after a target acquires a different canonical owner. Existing policy boundaries retain batch and unmarked filtering.

## Related

- [Contextify](../../../../packages/context/contextify/README.md)
- [Native service regressions](../../../../packages/context/contextify/tests/service.spec.ts)

# Details Reveal Control Design

English | [中文](2026-08-18-details-reveal-control-design.zh.md)

**Date:** 2026-08-18

**Scope:** Restore a persistent way to reopen Harness's native right details column after the user closes Context Map or Tool details.

## Product behavior

When a non-blank Session is active and the native details column is visually closed, Harness shows one small floating left-arrow control on the right edge of the frame. Pressing it calls the existing native `openDetails()` action. The details column then reopens on its last selected subpage, so closing and reopening Context Map preserves its viewport and selection, while closing Tool details preserves the selected Tool.

The reveal control disappears while the details column is open. At that point the existing close button and resize handle remain authoritative. This makes the reveal control and resize handle mutually exclusive and prevents overlapping pointer targets.

No reveal control appears when no usable Session is active. An explicit open keeps details at its minimum width and lets the center column absorb the remaining deficit, so the arrow always produces a visible result in an ordinary narrow frame. Exceptionally tiny frames may concede details below its floor; this feature does not introduce an overlay drawer.

## Ownership

`ui-layout/AppFrame` owns the reveal control because it already knows the resolved details width and owns `openDetails()`, `closeDetails()`, and the resize handle. Contextify does not add a second floating overlay or duplicate layout state. Context Map remains a subpage supplied by `ui-contextify`, and Tool selection remains owned by `ui-conversation`.

## Accessibility and tests

The control is a real button with the accessible name `Open details panel`, keyboard focus styling, and a visible left arrow. AppFrame tests prove it appears only for a closed details column with an active Session, opens through the native action, disappears when open, and does not coexist with the details resize handle. The Details subpage is always clickable: without a Tool selection it shows the native empty-state guidance, and with a selection it shows the Tool detail while preserving that selection. Browser verification covers closing Context Map, reopening it from the arrow, and switching to Details.

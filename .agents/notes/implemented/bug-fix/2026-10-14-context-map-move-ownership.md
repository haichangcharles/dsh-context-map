# Agent Note: Preserve node actions during programmatic map movement

Status: implemented

English | [中文](2026-10-14-context-map-move-ownership.zh.md)

## Problem

Search marks a message focused before its delayed animated viewport fit starts. Initial framing is also delayed until measurements are ready. A user can open a node menu during that interval. The [panel](../../../../packages/client/ui-contextify/src/client/ContextMapPanel.tsx) dismissed every menu on React Flow's `onMoveStart`, including the null event from programmatic movement, so the subsequently scheduled fit detached an actionable menu. Hosted browser cases observed a detached Branch action and a missing Restore automatic action; the same complete cases passed locally, consistent with ordering-sensitive behaviour.

## Decision

A programmatic movement has no pointer event and retains the open menu. Actual user movement still dismisses it. Canvas pointer capture, pane clicks, Escape, and completed actions retain their existing dismissal behaviour. Viewport timing, search, node selection, context mutation, and native branching are unchanged.

The right-sidebar fixture separately awaits the frame's actual grid animation completion after closing the automatically opened Map. Its collapsed marker and expand button describe state before the transition finishes; reading two bounding boxes at different transition frames can reverse their required order. This readiness barrier precedes the original exact geometry assertions. It introduces no fixed delay, force click, relaxed threshold, or new golden.

## Alternatives considered

**Delay menu interaction until viewport movement ends.** This would impose a new interaction restriction and would not fix the ownership error when a user opens the menu before a scheduled fit.

**Suppress all movement dismissal.** This would leave menus open during genuine user panning. The existing pointer dismissal remains required.

**Relax geometry assertions or add a fixed sleep.** These conceal intermediate layout reads without establishing that the actual animation finished.

## Consequences

Menu lifetime follows user input rather than programmatic framing. No new state owner or event subscription is introduced. The sidebar fixture measures settled layout while retaining the product's default Map opening, animation, and original layout contract. The deterministic callback regression covers the ordering even when browser scheduling does not reproduce it.

## Testing and limits

The existing public canvas callback test failed when a null movement event followed right-click: the menu was absent. It now retains the menu through that event and still verifies dismissal for the following real pointer movement, pane click and Escape. All 79 panel tests pass. Panel coverage remains 100% across 378 statements, 329 branches, 155 functions and 301 lines; focused lint passes.

Before these changes, the three owning browser files passed all 17 cases against the exact existing build. That does not prove the hosted race absent. Fresh built-browser verification remains required after the patch; no recorded model response or expected product geometry is changed.

# Trajectory Inspector in the Native Right Sidebar

English | [中文](2026-08-18-trajectory-inspector-right-sidebar-design.zh.md)

**Status:** Approved interaction design; implementation pending.

## Goal

Move the existing Trajectory Inspector from the Trajectory view's internal split pane into Harness's native right details column. This change is for controlled comparison work: it changes only the Inspector's rendering location, not when records are selected or when the user switches between Context Map and Details.

## Experiment invariants

- Selecting a Trajectory row, request marker, timeline span, or keyboard-focused record updates the Inspector selection exactly as it does today.
- Selection never switches the native right column from Context Map to Details automatically.
- The user switches between Context Map and Details explicitly through the existing page tabs.
- Switching pages preserves the latest Trajectory selection, active Inspector tab, and applicable scroll state.
- The Inspector keeps its existing Summary, Preview, Raw, Source, Payload, Result, Schema, Timing, Hierarchy, request, compaction, and parent-navigation behavior.
- No duplicate Inspector remains inside the Trajectory ledger.

## Architecture

### Ownership boundaries

`ui-layout` continues to own the right-column geometry, collapse/reveal behavior, and resize handle. `ui-conversation` continues to own the right-column shell and the Context Map/Details page navigation. `ui-trajectory` continues to own Trajectory record identity, selection semantics, detail tabs, and Inspector rendering.

`ui-conversation` declares one session-scoped single slot for a native Inspector page. Its Details page renders that slot when occupied and retains the current Tool drawer as the fallback when no Inspector provider exists. `ui-trajectory` registers a stable Session-derived host into that slot without making `ui-conversation` understand Trajectory records.

### Stable slot-host portal

The native Inspector remains the same React instance owned by `TrajectoryTable`. A Session-derived host ID connects it to the right-column Inspector seat through `createPortal`. The Details host remains mounted while Context Map is visible and is hidden rather than destroyed. Therefore selected record/request identity, active detail tab, recent-tab preference, hierarchy navigation, streaming updates, and external inspect acknowledgements continue to use the existing Trajectory state machine without a duplicated store or renderer.

Standalone `TrajectoryTable` consumers that do not supply a native host keep the existing local Inspector fallback. The assembled Harness always supplies the Session host, so no duplicate Inspector appears inside its ledger.

### Rendering

The existing Inspector body is portalled from `TrajectoryTable` into the native Details page and uses the native right column's width and scrolling boundary. In the assembled host, its internal resize handle and local width style are omitted because `ui-layout` owns resizing. The standalone fallback retains them for compatibility.

The Inspector close action preserves its native meaning: it clears the active Trajectory selection. It does not switch to Context Map and does not collapse the whole right column. With no selection, Details remains available and shows a neutral Trajectory empty state.

## Data flow

1. A user selects a record in the ledger or timeline.
2. The Trajectory Inspector controller records the stable selection identity.
3. The ledger updates its selection rail and scrolling exactly as before.
4. The current right-column page does not change.
5. When the user manually opens Details, the Trajectory Inspector resolves the selected identity against the live Session projection and renders the existing detail experience.
6. Switching back to Context Map hides, but does not reset, the Inspector state.

## Compatibility and failure behavior

- Without `ui-trajectory`, the Details page falls back to the existing conversation Tool drawer.
- If a selected record is no longer in the loaded history window, Details shows a bounded unavailable/empty state rather than retaining stale content.
- Session changes use separate controller instances; no selection leaks across Sessions.
- Closing and reopening the native right column preserves the selected page and Trajectory selection, matching the current Context Map preservation behavior.
- Archive, restore, branch, and Context Map projection logic remain untouched.

## Verification

Automated tests will prove:

- selecting a ledger row no longer renders an internal `Event details` aside;
- selection does not request the Details page;
- manually choosing Details renders the same selected message, Tool, context, and request Inspector content;
- Summary/Preview/Raw and Tool-specific tabs still switch correctly;
- selection and active tab survive Context Map/Details page switches and right-column collapse/reopen;
- clearing selection produces the empty state without changing the active page;
- Session changes isolate selection;
- keyboard, timeline, hierarchy, and cross-view inspect paths still select and focus the correct record.

Browser verification will compare the existing Trajectory workflow before and after the move: the only visible behavioral difference should be that the Inspector occupies the native far-right column instead of splitting the Trajectory ledger.

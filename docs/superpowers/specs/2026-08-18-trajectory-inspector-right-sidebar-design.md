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

`ui-conversation` will declare one session-scoped single slot for a native Inspector page. Its Details page renders that slot when occupied and retains the current Tool drawer as the fallback when no Inspector provider exists. `ui-trajectory` registers the Trajectory Inspector into that slot without making `ui-conversation` understand Trajectory records.

### Session-scoped Inspector state

The selection state currently local to `TrajectoryTable` will move into a session-scoped Trajectory Inspector controller. It stores stable selection identities rather than duplicated rendered markup:

- selected record identity or selected request identity;
- active detail tab and recent-tab preference;
- externally requested focus/selection acknowledgements;
- the minimum UI state required to preserve Inspector continuity while switching right-column pages.

The ledger and the right-sidebar Inspector subscribe to the same controller. The ledger remains responsible for row expansion and scrolling. The Inspector derives its current content from the live Session projection, so streaming completion and history paging update the open detail without copying stale payloads into another store.

### Rendering

The existing Inspector body is extracted from `TrajectoryTable` into a Trajectory-owned component. The internal Trajectory split pane, its local width state, and its duplicate resize handle are removed. The extracted component renders inside the native Details page and uses the native right column's width and scrolling boundary.

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

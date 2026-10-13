# Agent Note: Context snapshot publication readiness

Status: implemented

English | [中文](2026-10-14-context-snapshot-publication-readiness.zh.md)

## Problem

A completed model turn reaches Chat before the asynchronous Context graph poll publishes all native message actions. Earlier browser goldens sometimes captured only the user controls. CI then observed the legitimate assistant controls and failed comparison. Waiting after collapsing the Map also let the pointer remain over its toggle long enough to expose a transient tooltip.

The official brand SVG exists inside an `aria-hidden` decorative wrapper of the accessible **New session** button. A default accessible-role query cannot find that decorative image.

## Decision

The public [browser helper](../../../../apps/web/tests/support.ts), `waitForMessageContextControls`, waits for each scenario's explicit native-message count and four Context buttons per message before capture. Feedback and skill scenarios await publication before collapsing the Map, move the pointer away and require the toggle tooltip to disappear. The queued-image case checks both its initial user controls and five final native messages; its aborted partial assistant remains outside the Context graph.

The built-boot test verifies the exact SVG attributes and decorative ancestor, plus membership of its owning button in the accessible New session controls. Multiple independent New session buttons are legitimate. Goldens add only inspected, legitimate Context controls. Original Session/model JSONL, replay packets, file content, image geometry, feedback release and queue-order assertions remain unchanged.

## Alternatives considered

- **Hide Context actions or filter snapshots.** This would conceal shipped behavior.
- **Add the hover tooltip to goldens.** The tooltip reflects fixture pointer position rather than the intended settled transcript.
- **Refresh recordings broadly.** No model-facing behavior changed.

## Consequences

These changes stabilize observation of the existing product. They do not change agent policies, model quality or personalization. The [reviewed-action note](../feature/2026-10-13-context-steward-reviewed-actions.md) and [browser replay architecture](../testing/2026-07-24-web-gui-browser-e2e-lane.md) remain active and are not superseded.

## Testing

Five owning files contain 19 keyless tests. The first focused run passed both built-boot tests and both SVG tests, while exposing pointer-hover and initial-publication races in the other files. After fixing those premises, the second focused run passed all remaining 15 tests across feedback-release, queue-image and skill-user-invoke. Owning lint and diff checks pass. A later CI run exposed the same final-reply publication race in steering and the legitimate second New session button in the official build. Explicit final-reply readiness and exact brand-owner membership fix those fixture assumptions; both owning files pass all eight tests in a further keyless run. No provider API was called; this scoped evidence does not claim the complete remote CI suite passed.

# Agent Note: Context snapshot publication readiness

Status: implemented

English | [中文](2026-10-14-context-snapshot-publication-readiness.zh.md)

## Problem

A completed model turn reaches Chat before the asynchronous Context graph poll publishes all native message actions. Earlier browser goldens sometimes captured only the user controls. CI then observed the legitimate assistant controls and failed comparison. Waiting after collapsing the Map also let the pointer remain over its toggle long enough to expose a transient tooltip.

The official brand SVG exists inside an `aria-hidden` decorative wrapper of the accessible **New session** button. A default accessible-role query cannot find that decorative image.

## Decision

The public [browser helper](../../../../apps/web/tests/support.ts), `waitForMessageContextControls`, waits for each scenario's explicit native-message count and four Context buttons per message before capture. Feedback and skill scenarios await publication before collapsing the Map, move the pointer away and require the toggle tooltip to disappear. The queued-image case checks both its initial user controls and five final native messages; its aborted partial assistant remains outside the Context graph.

Queue-action snapshots additionally wait for the admitted active user's Context controls before parking a prompt response. A model fixture's hang-ready marker proves model progress, not Client graph publication. The shared-page draft-review test clears through the existing `writeComposerDraft` keyboard path (click, editor-owned Select All, Backspace), then waits for empty editor `textContent`, disappearance of the draft-review action and a disabled Send button after clearing its draft; the next transcript snapshot therefore cannot inherit a not-yet-published draft. Lexical's empty paragraph may have a layout newline in `innerText`, while containing no text nodes. Playwright's empty fill instead selects a DOM Range and sends Delete; Lexical owns a separate editor selection and publishes drafts only on editor commits. The source paths differ, but the exact CI selection-event schedule remains unproved. The intended Copy tooltip is explicitly hovered and awaited before its original golden, while Queue setup moves the pointer off the native sidebar toggle and awaits only that incidental tooltip's disappearance.

The Web-observation fixture waits for its exact source article before reading the node-label list. Attaching a Session does not establish Client graph publication; the existing wait must precede the list assertion.

The built-boot test verifies the exact SVG attributes and decorative ancestor, plus membership of its owning button in the accessible New session controls. Multiple independent New session buttons are legitimate. Goldens add only inspected, legitimate Context controls. Original Session/model JSONL, replay packets, file content, image geometry, feedback release and queue-order assertions remain unchanged.

## Alternatives considered

- **Hide Context actions or filter snapshots.** This would conceal shipped behavior.
- **Add the hover tooltip to goldens.** The tooltip reflects fixture pointer position rather than the intended settled transcript.
- **Refresh recordings broadly.** No model-facing behavior changed.

## Consequences

These changes stabilize observation of the existing product. They do not change agent policies, model quality or personalization. The [reviewed-action note](../feature/2026-10-13-context-steward-reviewed-actions.md) and [browser replay architecture](../testing/2026-07-24-web-gui-browser-e2e-lane.md) remain active and are not superseded.

## Testing

Five owning files contain 19 keyless tests. The first focused run passed both built-boot tests and both SVG tests, while exposing pointer-hover and initial-publication races in the other files. After fixing those premises, the second focused run passed all remaining 15 tests across feedback-release, queue-image and skill-user-invoke. Owning lint and diff checks pass. A later CI run exposed the same final-reply publication race in steering and the legitimate second New session button in the official build. Explicit final-reply readiness and exact brand-owner membership fix those fixture assumptions; both owning files pass all eight tests in a further keyless run. A subsequent CI head exposed the initial queue-publication race and shared-page draft cleanup race. The focused queue-actions file passes three tests and message-actions passes five tests after the explicit readiness checks; every existing golden and recording stays unchanged. Head 986's complete E2E lane passed while its artifact lane exposed a retained draft after empty fill and an incidental sidebar hover. After switching to the existing native editor gesture and explicit tooltip premises, a further focused run passes both owning files' eight tests (18.04 seconds), including all four Queue replay calls; original goldens and Session/model records remain unchanged. The native Web-evidence file later exposed a list assertion preceding its existing article wait; moving that wait before the unchanged assertion passes all three owning cases. No provider API was called; this scoped evidence does not claim the complete remote CI suite passed.

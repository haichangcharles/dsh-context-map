# Agent Note: Make Profile feedback ordering regressions deterministic

Status: implemented

English | [中文](2026-10-14-profile-feedback-order-regression.zh.md)

## Problem

Windows passed every test but missed the Profile Branch-feedback sort's Session-id and event-sequence tie-break branches. Linux covered them incidentally: existing native events sometimes shared a millisecond there, while slower Windows appends received distinct timestamps. The runtime ordering remains necessary because its last-32 window can change a personalized Branch recommendation.

## Decision

Keep runtime sorting unchanged. Two native-service regressions pin Date.now only during synchronous historical Session appends and restore it immediately, before any harness wait. Two independent families are created in reverse lexical order. One owns 32 confirmed choices (24 Moves and 8 Keeps), the other one Move. With equal timestamps, Session-id ordering places that extra Move outside the real last-32 window; a generic Keep stays unchanged. With the other family's choice genuinely one millisecond newer, the first Keep leaves the window, the retained Move rate becomes 26/34, and the same generic Keep receives a reviewable personalized Branch card. Same-Session feedback also shares timestamps, exercising its native event-sequence ordering.

## Alternatives considered

- **Remove the tie-breaks.** Equal native event timestamps are valid, and catalog insertion order is not chronology.
- **Rely on faster test execution.** That would keep coverage dependent on machine speed and wall-clock resolution.
- **Relax coverage or spoof the host platform.** Neither verifies the behavior behind the missing paths.

## Consequences

No product source, model request budget, selection policy or lifecycle behavior changes. The tests check all 33 public evidence source cursors and their within-Session sequence order. They verify the actual bounded Branch window through different public recommendation outcomes, while leaving the distinct public evidence-list ordering contract unchanged. The fixed clock never changes async deadlines.

## Testing

All 29 Contextify test files and 471 tests pass. The owning index source has 100% statements (1083), branches (843), functions (210) and lines (958). The added classifier uses one local mock request per scenario and creates no branches automatically. Real Windows coverage still requires the next CI run.

## Related

- [Native service regression](../../../../packages/context/contextify/tests/service.spec.ts)
- [Profile-wide ordering](../../../../packages/context/contextify/src/index.ts)
- [Bounded Branch calibration](../../../../packages/context/contextify/src/personal-branch-policy.ts)

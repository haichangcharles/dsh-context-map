# Agent Note: Replay deferred layout follow when the reader returns to the tail

Status: implemented

English | [中文](2026-10-14-deferred-scroll-follow.zh.md)

## Problem

A native scroll back to the tail can finish against an outdated content height. Expanding a tool process or resizing the composer can grow the transcript while a reader scroll sample is pending. The resize observer postpones follow to protect the reader, but losing that notification leaves a gap after the sample restores bottom ownership. An End gesture followed by 22px of growth can therefore leave Chat 22px above its actual bottom.

## Decision

[ChatView](../../../../packages/client/ui-chat/src/client/chat/ChatView.tsx) records one deferred resize notification during a pending native scroll burst. When the sample settles, it applies that follow only if the reader moved toward the tail and entered the existing bottom-follow threshold. Explicit return-to-bottom actions clear the deferred notification. Settled upward movement and ordinary near-bottom scrolling retain their positions.

Layout cleanup also saves a pending reader sample before refs detach. An explicit own input bypasses the deferred-layout gate, so its jump survives even if an assistant reply arrives before the sample settles. These guards reuse existing sampling logic and add no per-scroll row reads.

This complements [immediate attribution of pinned deliveries](2026-09-07-pinned-scroll-delivery-before-layout.md): that decision handles browser layout movement while already pinned; this decision preserves a deferred resize while a reader returns from history. Both mechanisms remain active.

## Alternatives considered

**Snap every near-bottom sample.** This erases small upward gestures and violates the existing guarantee that entering the follow threshold alone does not move the remaining distance.

**Wait longer or repeat End in the browser test.** The resize notification is already lost when the native burst settles. Additional waiting cannot replay it, and repeated input would conceal the defect.

## Consequences

One boolean records postponed follow; the fix adds no per-scroll row measurements, keyboard handler, timer, or provider request. A pending-sample unmount performs one final existing semantic-position read. The 24px follow threshold, existing pixel rounding, 500ms sampling interval, away-reader protection, and immediate pinned-delivery handling remain unchanged. A pending resize may complete follow only after movement toward the tail; an upward gesture keeps its reading position.

## Testing

The [owning unit suite](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) passes all 94 tests. Its deterministic regression moves a reader from 500px to an old floor at 700px, grows the flow by 22px before `scrollend`, and requires the new floor at 722px. A paired negative case preserves a 10px upward gesture despite concurrent 5px growth. Two additional regressions first reproduce a lost final position on unmount and a fast reply hiding an own-send jump, then verify the minimal guards. Existing cases retain small-gesture accumulation, interval sampling, ordinary near-bottom scrolling, shrink/regrowth, and remount behavior.

The [keyless browser suite](../../../../apps/web/tests/chat-scroll-contract.e2e.ts) retains its seven original scenarios, 1px bottom assertion, keyboard input, and Map-open streaming fling case. No retry, timeout, or assertion is relaxed.

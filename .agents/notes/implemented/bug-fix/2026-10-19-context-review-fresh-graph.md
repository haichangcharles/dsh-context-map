# Agent Note: Refresh the native family before Context review

Status: implemented

English | [中文](2026-10-19-context-review-fresh-graph.zh.md)

## Problem

The [Client controller](../../../../packages/client/ui-contextify/src/client/controller.ts) retains its loaded graph between polling reads. A native fork, title update or workspace archive can change the family revision before the next poll. Manual review sends the retained revision, so the Host refuses the request before proposing Context or Branch changes. A failed later read also retains the old graph for display; that display is not evidence that review can safely dispatch.

## Decision

Manual Local, Fast and Deep review refresh the native family and Plan before dispatch. Pending Plan mutations and failed reads refuse review. The existing transient request counter owns this preflight as well as the classifier outcome: clearing a draft or requesting a newer review invalidates an older preflight before transport dispatch. The newest waiting request owns its objective and mode. Once a reviewer is running, overlapping requests remain rejected. A mutation taking ownership during the read also prevents dispatch.

Host revision validation remains authoritative for concurrent changes after the read. This is a fresh metadata read, not a model retry, automatic mode escalation or cached-response fallback. Deep cancellation still targets an actually dispatched review; clearing during the read invalidates an undispatched request locally.

## Alternatives considered

Waiting for the polling timer or retrying Host refusal adds timing dependence or another model attempt. Weakening graph-revision validation admits inconsistent family input. A separate preflight state owner duplicates the existing request ownership counter. Refreshing without capturing that counter lets a cleared draft reappear after the read resolves.

## Consequences

A manual review adds one deduplicated graph read and can report its read failure while the previous map remains visible. Out-of-band changes no longer wait for a polling interval before a review can use them. The exact-title-collision Loader replay covers parent archiving followed immediately by review, approval, Undo and reload; unit races cover failed reads, clear, concurrent requests and pending mutations. Engineering fixtures establish execution behavior, not new model accuracy or preference gains.

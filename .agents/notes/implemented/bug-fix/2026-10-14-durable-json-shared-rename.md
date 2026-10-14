# Agent Note: Durable JSON publication through the shared rename owner

Status: implemented

English | [中文](2026-10-14-durable-json-shared-rename.zh.md)

## Problem

A Windows projection-cache fixture observed a current live title while durable and cached titles stayed stale. The creation write committed, but the turn-end checkpoint reported EPERM. Its original diagnostic retained the error code without the syscall, so the exact failing filesystem phase remains unproved. Independently, inspection found that JSON storage's atomic publisher used a raw rename while settings and credentials already used bounded Windows replacement retries.

## Decision

Expose the existing `renameAtomicTemp` boundary from [atomic-write](../../../../packages/util/atomic-write/README.md#publishing-a-prepared-file), without changing its retry policy. [JSON storage](../../../../packages/storage/storage-json/src/atomic.ts) invokes it after exclusive temp creation, complete write, file fsync and handle close. The same complete sibling remains the rename source. Windows EACCES, EBUSY and EPERM retain the existing eight retries with 20–200 ms backoff; other codes and platforms fail immediately. Storage still owns POSIX directory fsync and temp cleanup after final failure.

The consumer does not replay creation, writing, fsync, domain updates or cache checkpoints. It never deletes the old target to make rename succeed. Final errors propagate; existing domain rollback and cache fail-soft reporting stay intact. The [fixture diagnostic](../../../../packages/session/session-projection-cache/tests/fixtures.spec.ts) adds only a fixed syscall classification or unknown, without raw paths or warning payloads, so native Windows evidence can identify an unhandled phase.

## Alternatives considered

- **Retry the cache checkpoint or increase its five-second assertion wait.** This repeats domain work or masks a failed durable write instead of handling the publication owner.
- **Call writeFileAtomic for the entire JSON write.** That helper deliberately omits fsync and would change the storage durability contract.
- **Add another retry loop or delete the target first.** Reuse the established owner; deletion would break atomic reader visibility.

## Consequences

Both JSON layouts share the existing replacement policy while retaining their durability and failure semantics. The exported rename helper does not create, sync or clean up a caller's temporary file. This closes a known maintenance gap; it is not evidence that rename caused the observed EPERM or that native Windows CI now passes. The archived retry note remains frozen, and the active [atomic-write README](../../../../packages/util/atomic-write/README.md) owns that earlier policy.

## Testing

Four consumer regressions fail before wiring the shared boundary. After wiring, the public tests verify complete/synced/closed input, preservation of the old target and final error, temp cleanup, immediate exclusive-open failure, and unchanged records in both layouts. The existing utility tests exercise bounded retry codes and exhaustion using their established OS simulation; no new OS spoof is added, and those tests are not claimed as native Windows evidence. Original projection-cache fixtures and their five-second assertions remain intact. The scoped run passes 54 tests across four files; all four JSON-storage sources and atomic-write have 100% coverage (331 statements, 135 branches, 65 functions, 298 lines). Real Windows diagnostics remain authoritative for the original error phase.

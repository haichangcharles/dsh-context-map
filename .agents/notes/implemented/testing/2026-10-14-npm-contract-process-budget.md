# Agent Note: npm contract child budget and safe timeout facts

Status: implemented

English | [中文](2026-10-14-npm-contract-process-budget.zh.md)

## Problem

Windows coverage's first local-registry npm contract hit its private 10-second child deadline. Cleanup completed at 12.4 seconds; the next two fresh consumers completed in 640 and 472 milliseconds. The lane grants 90 seconds. No registry-readiness, port/cache ownership, inherited npm-config or metadata-response defect was identified. The old error omitted exit and request facts, so the exact delay phase remains unknown.

## Decision

Only the three real-npm functional cases in [the owning spec](../../../../scripts/benchmark-npm-resolution.spec.ts) receive the existing lane's 90-second bound. Their child deadline uses public `TestContext.task.timeout` minus eight seconds: one for TERM grace, five for forced exit, two for owned registry/temp cleanup. An impossible, nonfinite or fractional budget fails preflight instead of launching unbounded work. Explicit case bounds override shorter CLI defaults under ordinary Vitest semantics; plain local unit execution remains usable.

The [benchmark](../../../../scripts/benchmark-npm-resolution.ts) records fixed numeric duration/request counts and actual child-close status/signal in deadline errors. No subprocess output, paths, registry addresses, package names or environment are added. Production's 300-second default, explicit CLI deadline, manual `--max-ms` SLA, performance gates and the original one-second termination regression remain unchanged.

## Alternatives considered

- **Retry npm or use a public registry fallback.** This changes isolation and repeats work rather than diagnosing the owned child.
- **Increase a performance threshold.** These cases verify archive avoidance, placement and configuration isolation, not a timing SLA.
- **Assume cold startup caused the delay.** First/next-call evidence suggests contention, but does not identify its phase.

## Consequences

The contract fixture no longer replaces its lane budget with an unrelated ten-second child limit. It retains a finite deadline, bounded termination and awaited cleanup. Future native failures distinguish metadata requests from child completion. This does not prove Windows CI now passes or establish the original delay's exact cause.

## Testing

The real one-millisecond npm deadline regression was RED without exit facts and GREEN after the change. Integration assertions retain registry traffic, zero archives, exact aliased versions and peer placement under hostile inherited configuration. Budget boundary cases reject impossible inputs. Scoped Node 24 tests use real local npm and loopback; no OS spoof, providers, test retries or assertion filters. Native Windows CI remains authoritative.

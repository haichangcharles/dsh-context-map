# Agent Note: Replay the current tool guard description

Status: implemented

English | [中文](2026-10-14-guard-description-replay.zh.md)

## Problem

The keyless headless CI replay failed only in the `cordis-inspect-jsdoc` scenario. Its current format-v3 expected Session contains the old `tools.guard` description, while the source and generated Cordis API catalog correctly document the second check immediately before dispatch. The second check protects tools whose permission state changes while queued or inside asynchronous execution wrappers.

## Decision

Update only that method description in the current [format-v3 expected Session](../../../../snapshots/session/cordis-inspect-jsdoc/session.v3.jsonl). Preserve historical format-v2 data, model recordings, event identities, tool schemas and every other expected field. Continue strict whole-Session equality and request-header verification. Do not remove the guard or normalize away API descriptions to satisfy replay.

## Validation

The remote failure's exact diff is the guard description. The expected text matches [the source JSDoc](../../../../packages/core/tools/src/index.ts) and [generated API catalog](../../../../packages/extensions/tool-cordis/src/api-catalog.ts). The owning keyless recorded scenario is rerun with no provider credentials; its result is recorded in the project acceptance report.

## Alternatives considered

**Remove the second guard check.** This would restore stale permission acceptance and contradict the existing dispatch regression.

**Ignore descriptions during replay.** This would conceal future API catalog drift. Matching the one accurately changed description retains the stronger oracle.

## Consequences

The current replay expectation follows the documented dispatch contract. Historical logs and model scripts remain unchanged; this is an expected-output documentation correction, not a Session format migration.

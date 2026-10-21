# Agent Note: Explicit Fast Web review fixture

Status: implemented

English | [中文](2026-10-19-explicit-fast-web-review.zh.md)

## Problem

The assembled Web preference test names the Fast recommendation path but omits its mode argument. The Host defaults to Local. Sharing a candidate builder concealed the mismatch; independent Local admission exposed a different slate and a failed expectation for the final Web source.

## Decision

The [owning test](../../../../apps/web/tests/research-contextify-web-evidence.e2e.ts) explicitly selects Fast and asserts the returned mode and exactly one request to its engineering adapter. The expected source exclusion, unchanged Plan before approval and compiled Context after approval remain intact. No provider is contacted. Local behavior and Fast candidate admission are unchanged.

## Alternatives considered

Changing the expected source or a snapshot would validate Local under a Fast test name. Changing the Host default or candidate ranking would alter product behavior for a test setup error. Selecting the documented mode fixes the owner of the mismatch.

## Consequences

An omitted mode fails the mode/request assertions rather than accidentally passing through another path. The unchanged original case reproduces the CI source mismatch; the repaired focused case validates the actual bounded classifier and preference calibration. This is an integration-test repair, not evidence of improved model accuracy.

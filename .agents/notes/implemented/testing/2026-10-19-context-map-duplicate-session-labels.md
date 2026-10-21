# Agent Note: Context Map fixture with duplicate Session labels

Status: implemented

English | [中文](2026-10-19-context-map-duplicate-session-labels.zh.md)

## Problem

Parent and child workspace rows can share a title. The assembled Context Map test locates the parent's menu globally by that title, so an intermediate fork-title echo resolves two rows and fails before the archive action. Display order and generated titles do not identify the native parent.

## Decision

The [owning replay](../../../../apps/web/tests/contextify-map.e2e.ts) first observes the native child's Active lifecycle entry, then deliberately assigns it the parent's displayed title. Two equal action labels remain throughout parent archiving. The parent menu is scoped to the unselected Session row; the active child remains selected. The test checks one matching parent row before action, the exact native parent in the archived registry, the child absent from that set, the parent row gone and one same-name child action remaining. Existing compiled Context, approval, Undo and reload assertions remain intact.

## Alternatives considered

Choosing the first match depends on workspace order. Renaming the two fixtures differently or waiting for an automatic title suffix avoids the duplicate case. Adding a production DOM identity solely for this test widens the shipped contract unnecessarily; existing native lifecycle and selected-row state identify both roles in this two-Session scenario.

## Consequences

The collision is deterministic and reproduces the original strict-locator failure before scoping. No sleep, retry, timeout increase, snapshot replacement, product behavior or model call is added. The title assignment is engineering fixture preparation, not preference evidence or a model decision.

# Agent Note: Context node-choice provenance

Status: implemented

English | [中文](2026-10-08-context-node-choice-provenance.zh.md)

## Problem

Contextify persisted plan states but not the action that selected them. A plan revision could follow a generated recommendation, a manual edit, or a programmatic Remote call. Treating all revisions as human preference would corrupt a context-selection feedback dataset.

## Decision

A successful `setNodeModes` call appends `contextify/node-choice` after the committed plan. The event records resolved node modes, prior and resulting plan revisions, graph revision, a semantic-change flag, and whether the call matched the current validated recommendation. A recommendation application also records the proposed selection and candidate node IDs. The Host accepts a graph-guarded application only when its modes match the cached reviewed proposal; a missing or stale proposal fails before mutation. A direct call is labeled `direct`, which identifies an invocation path rather than a human actor. The shipped Client declares `uiOrigin: contextify-client` when it invokes a visible node action; ordinary Remote calls leave this optional field absent. Generated but unapplied recommendations remain unlogged.

## Alternatives considered

- **Infer feedback from plan revisions** — rejected because revisions omit proposal identity and cannot distinguish no-op, direct, and recommendation-applied edits.
- **Log every generated recommendation** — rejected because a generated proposal is not evidence that it was displayed or accepted; the review operation remains read-only.
- **Label every direct call as human feedback** — rejected because Remote methods can also be called by programs.

## Consequences

The Session log can identify recommendation applications and actual mode changes without storing message text in the choice event. The Client marker separates the shipped UI path from unmarked Remote calls, but any Remote caller can declare it; the log cannot alone prove human identity, proposal exposure, or preference over an unoffered plan. Preference evaluation still needs held-out participant decisions. The cached proposal is process-local; after a restart, a guarded Apply requires a fresh recommendation.

# Agent Note: Source-bound Web import across Context branches

Status: implemented

English | [中文](2026-10-10-source-bound-web-import.zh.md)

## Problem

A Web observation discovered on a sibling Session can be visible in the Context Map but absent from the active model request. Copying its `tool/result` message alone loses the preceding tool call required by provider protocols. Refusing every such Include prevents people and the personal Context recommender from reusing a page across branches.

## Decision

The family graph marks a Web result importable only when it is successful, text-only, and cites exactly one matching native `web_search` or `web_fetch` `tool/call` event. A same-family Include verifies that relationship again, then writes a `context/compiler-snapshot` containing a `recall`-form user message. The logged text identifies the Web action, its original call arguments, and the quoted observation as untrusted data. Snapshot provenance records the source Session and result sequence. The current Plan selects that snapshot once at the node's stable insertion position; Natural, Undo, and Reset remove it without modifying the original Session. A malformed or unbound result cannot create a snapshot or advance the Plan.

Fast recommendation, ordinary recommendation validation, and the Context Map checkbox admit only off-path Web nodes carrying that importable action. The personalized source matcher distinguishes `web_search` from `web_fetch`; off-path worker reports remain unavailable. A direct restoration to Natural is recorded as positive feedback for active-path material and negative feedback for off-path material.

The opt-in source-bound delegation helper can also render a currently selected imported Web snapshot into a worker prompt. It checks that the recall message is text-only, came from Contextify, and still matches its recorded content hash, then records the active Session's snapshot sequence as the worker's dependency. The existing lineage check rejects that worker after the active Plan removes the snapshot.

## Alternatives considered

- **Copy the original tool result alone** — rejected because the model request would lack its assistant tool call and could violate provider protocol.
- **Copy the complete original assistant step** — rejected because one step can contain several calls and unrelated results; importing them changes the selected evidence set.
- **Keep every sibling Web result unavailable** — rejected because it leaves a core branch-reuse action outside the executable Context Plan.

## Consequences

The capsule preserves source identity and tool context for explicit branch reuse, but it is a rendered data message rather than a native replayed tool exchange. It does not defend against instructions embedded in hostile Web text or certify that the original sibling Session remains selected by another Plan. Selection and worker-read validation operate on the active Session's copied snapshot; removing it from the current Plan removes it from later compiled requests and invalidates workers delegated from it. Focused native Session tests cover import, worker dependency and revocation, Undo, repeated Include, missing call provenance, and client eligibility. A separate live child replay uses a controlled native `web_fetch` and confirms that the report derived from a sibling Web snapshot is quarantined and absent from the next parent model request after Undo. A full natural Web task evaluation is still needed before claiming an end-to-end user benefit.

# Agent Note: Opt-in revision-lineage runtime

Status: implemented

English | [中文](2026-10-10-opt-in-revision-lineage-runtime.zh.md)

## Problem

Contextify exported a lineage compiler and request-read-set helpers, but research replays installed their pre-step gate by hand. The request-consistency claim then depended on test wiring rather than a reusable Harness component. An unchecked upgrade of an existing Session could also remove earlier assistant messages whose read sets were never recorded.

## Decision

`ContextifyRevisionLineageRuntime` is an opt-in Service mounted after ContextifyService. At a Contextify Session's first pre-step, it selects a versioned lineage compiler only when all prior assistant steps already have read sets. A legacy Session with an unrecorded assistant answer stays on ordinary Contextify and continues working; it never receives a retrospective protection claim or a partial read set. On every protected step the runtime filters child messages whose delegation sources no longer satisfy the current Plan, records the exact accepted messages and selected history before provider dispatch, and retains at most 64 rejected messages per Session for inspection. Session disposal clears that memory. Shipped profiles do not mount this runtime by default.

The opt-in runtime also registers two model-facing tools. `list_context_sources` pages through at most 16 currently selected text-only human, native Web, or imported Web recall sources with bounded previews. `delegate_context_sources` accepts one to eight event sequences, validates them again against the current Plan, records a source slice, and starts a tool-free spawned child. In a protected parent, a guard rejects ordinary `subagent*` and `send_message` tool calls that could introduce unbound child input; legacy Sessions retain ordinary tool behavior. A separately exported runtime entry lets a Web profile patch mount this path without changing the default profile.

Native source references recursively validate assistant read sets and worker delegation slices, including references through intermediate structural events. Top-level selection and ancestor validity remain separate: ordinary compaction can hide valid historical dependencies, while explicit exclusions, replaced originals and released compiler snapshots invalidate derived content. Summaries of invalid answers or reports are omitted; independent evidence remains available. Re-activating a source restores valid descendants. Cycles spanning read sets and native references are rejected.

## Alternatives considered

- **Keep wiring in each replay** — leaves the central guarantee outside the product component.
- **Enable lineage unconditionally in ContextifyService** — changes existing Session semantics and would silently prune assistant history lacking read sets.
- **Admit old assistant history without a read set** — would claim provenance that was never observed.
- **Infer a free-text worker prompt's sources after launch** — cannot reliably identify which selected Web or human material it contains; the protected path instead constructs the child input from selected events.
- **Require every ancestor to remain visible** — rejects legitimate compacted answers because their original messages are hidden. Recursive dependency validation preserves them while enforcing explicit revocation and snapshot release.

## Consequences

The native sibling-Web worker test now uses the Service and observes a rejected late report in its quarantine. Replaying the same 30 held-out TopiOCQA fork cases with the Service preserves every visibility and request-count cell of the earlier hand-wired experiment; the independent A worker remains visible in 30/30 cases. The Service still observes only recorded inputs, cannot undo effects already started, does not persist or automatically replay quarantined messages, and is not installed in published profiles.

A real Agent Loop rollout test starts a Session before mounting the runtime, resumes it afterward, and confirms it keeps ordinary Contextify with no fabricated read sets. A fresh Session started after mounting selects lineage before its first provider request and records a read set. Ordinary `tool-subagent` reports remain unbound and are rejected by the protected path; the default Web profile still does not mount this runtime.

The source-bound tool entry is now implemented and keylessly tested in a Loader-composed Web app. Its schemas reach the parent's model request. With A and B workers in flight, excluding Web source B removes it from the source list, rejects a new B delegation, retains A's eventual report, and excludes B's eventual report from the next parent request. This does not prove complete child-input provenance: ambient prompts, non-tool service calls that steer a child, external reads, and already-started effects remain outside the recorded slice. The default Web profile stays unchanged until those paths and legacy restart behavior have product-level coverage.

The authored `contextify-lineage-provenance` recorded-session snapshot boots the shipped headless profile with source Contextify plugins. A test-only tool records fixed sources, a delegation slice, a synthetic worker report, its summary and a complete compaction lifecycle. The next assembled model request retains the valid checkpoint and current input while excluding the revoked source and derived carriers. A source-level negative control rejects the original compiler at that request assertion; restoring the fix passes keyless replay. The fixture does not launch a worker or measure model quality.

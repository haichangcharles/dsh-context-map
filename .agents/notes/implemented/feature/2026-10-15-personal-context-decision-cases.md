# Agent Note: Personal Context decision cases

Status: implemented

English | [中文](2026-10-15-personal-context-decision-cases.zh.md)

## Problem

Profile-wide choice statistics do not show a reviewer which earlier task justified a choice. Candidate-only personalization also cannot establish that the final Context or branch operation improved. Cross-project chat exclusions describe task context and can be unsafe as unconditional style rules.

## Decision

[Contextify](../../../../packages/context/contextify/README.md) reuses bounded, confirmed objective-to-choice examples and complete changed multi-node plans across native Session families in the same Profile. Owned event identities preserve undo and reset behavior. Candidate admission is independent of personalization. Cross-family chat edits inform the decision model; deterministic calibration keeps current-family edits and typed Web source habits. The service derives these views from native logs rather than maintaining another persona store.

Fast supports a Host-side Jev structured inference adapter alongside the existing parent-model path. The adapter asks separate selection, evidence and supersession questions. One joint Choice compares the active task, a new task under the active or a supplied parent, evidence reuse and concrete native destinations; selecting the parent means Return. This avoids contradicting an independently inferred abstract intent with a destination score. Historical route cases retain their reviewed objectives, signed choices and bounded source, target and selected-parent task text preceding the operation; foreign messages with equal timestamps are omitted. The adapter submits its result to native validation and revision checks. Its exact credential-free request is logged before dispatch. It makes one cancellable request with no retry or fallback and never owns an agent loop. The graph/compiler and Web client perform no provider HTTP calls. The [official API](https://docs.typesafe.ai/api) owns the provider protocol.

The review sheet distinguishes model-visible examples from the bounded source records available to local calibration and routing thresholds. Accepted and rejected choices keep their signs. Settings changes cancel in-flight Context and Branch reviews; policy reset cancels both and filters older evidence through owned event watermarks. Earlier case text is management input, never answer Context.

## Alternatives considered

**Personalize the candidate slate only.** Rejected because identical retrieval coverage can still produce different invalid selections or wrong branch destinations, and changing the slate confounds a decision-only comparison.

**Apply every cross-project chat choice as a global statistical rule.** Rejected because an earlier task-specific exclusion does not authorize excluding a new constraint. Bounded task examples leave the current objective visible to the reviewer.

**Add a separate memory database or agent runtime.** Rejected because native logs already own feedback, undo, reset and source provenance. Case retrieval and a replaceable inference adapter require neither another loop nor model fine-tuning.

## Consequences

Users can choose the Fast reviewer and inspect the historical choices that support its advice. Existing human review and native execution guards remain authoritative. Jev requires its own Host credential and can fail on provider limits; the service preserves the current Plan on failure. This engineering connection does not establish human preference gains, answer quality or statistical improvements on external conversations.

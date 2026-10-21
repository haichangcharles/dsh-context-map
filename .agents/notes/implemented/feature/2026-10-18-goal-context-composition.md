# Agent Note: Goal assignment and Context composition

Status: implemented

English | [中文](2026-10-18-goal-context-composition.zh.md)

## Problem

Independent task-fit scores can order a within-task reply above an actual new task on every Branch gate. Raising or lowering their shared thresholds cannot repair that ordering. A research-only scorer override also cannot establish that the shipped Host, preference projection and Web review work together.

## Decision

The optional `goal-model-jev` setting separates categorical task assignment from Context membership. The current chat model receives bounded native task evidence, the exact draft, organization policy and confirmed management examples. It returns a short goal, new/existing/unknown assignment, a supplied Session ID and an explicit retention category, governed by the [retention decision](2026-10-20-explicit-context-retention.md). The Host retains evidence and validates the complete JSON object, task inventory and successful model finish. Unknown assignment or retention makes no Jev request and bypasses inferred Context calibration; combined automatic routing also abstains, while direct native manual operations remain available. Known assignments reach the existing Jev request as quoted work-item data. Membership, evidence and supersession questions use that goal; their current-task evidence comes from the assigned existing task, or is empty for a new task. A new assignment identifies its parent, not a task to inherit wholesale. Each source question quotes ownership from the frozen native graph by exact source ID, including its relation to the assigned existing task or new-task parent. Missing provenance is unknown, not an exclusion. Inherited and borrowed sources remain eligible; neither active-path status nor ownership replaces relevance and review policy. The unchanged historical onActiveBranch feature means path membership, including inheritance, rather than local Session ownership. Confirmed Context examples separately expose native local, ancestor or other-task ownership relative to the original editing Session. This is derived from verified owned log suffixes and immutable parent headers; missing or unverifiable provenance stays absent, with no retention preference inferred. Undo, profile disable and reset retain authority over the evidence. The destination never grants source membership; explicit whole-task policy, manual choices and native validation retain authority. Known assignments combine with separately validated Jev membership and supersession evidence. Their Jev request omits task-fit, new-task, parent placement and wholeTask questions; the Host reuses its validated assignment rather than overwriting a second placement judgment. Model version and every source/evidence/supersession score are validated before composition; the Host resolves the explicit preservation base before Jev. Standalone Jev retains its original questions and decoder. Unit route scores encode the selected category, not calibrated confidence.

Task cards carry known native lifecycle state and its explicit or derived provenance into Goal discovery, including the active task. The frozen family projection owns these facts. Derived parked or open states do not establish organization preferences, and lifecycle evidence does not authorize Context selection, reopening or approval. Missing lifecycle provenance stays unknown. The exact request log retains the model-visible metadata; the parser and native operation checks retain authority.

This adapts known/new intent reuse from [IntentGPT](https://arxiv.org/html/2411.10670v1), dynamic natural-language task inventories from [Schema-Guided Dialogue](https://ojs.aaai.org/index.php/AAAI/article/view/6394), and the separation of semantic proposals from executable constraints in [SayCan](https://arxiv.org/abs/2204.01691). It does not reproduce their complete algorithms or benchmark claims. Native task cards replace the intent inventory; confirmed user operations provide examples. The existing event projection remains the user model, with disable, reset and Undo semantics rather than another opaque persona store.

The Host checks required Jev credentials before spending the goal call. Credential resolution participates in cancellation. A draft uses one current-model request and at most one Jev request within a 45-second overall bound, without retry or fallback. Non-draft Fast review uses Jev alone. Default Local review and the default parent-model Fast reviewer remain unchanged. The [Context Steward guide](../../../../docs/user/guide/context-steward.md) and bilingual settings disclose these choices and costs.

This partially supersedes the additional-router rejection in the [reviewed actions note](2026-10-13-context-steward-reviewed-actions.md). That note remains active for Local, ordinary Fast, Deep, lifecycle and review ownership. The [personal decision cases](2026-10-15-personal-context-decision-cases.md) and [scope handoff](2026-10-16-context-scope-route-handoff.md) decisions retain authority over provenance, manual pins, supersession, native operation DAGs, revisions and explicit approval. No persisted Session format changes.

## Alternatives considered

**Tune only the Branch thresholds.** Rejected for the observed reversed ordering; this cannot separate the positive from its dominating negative control.

**Always run another model or force a categorical answer.** Rejected because extra cost requires opt-in and uncertain evidence should abstain. The default path and non-draft Jev path retain their existing request counts.

**Let generated text own source IDs or bypass native policy.** Rejected because the model proposes a task assignment; graph membership, manual constraints, source provenance and approval remain Host responsibilities.

## Consequences

The extra goal call increases cost and latency. Existing cached examples are component integration evidence, not fresh validation of the new prompt, abstention or personalization effectiveness. Native runtime tests cover parent Branch scope, return/reactivation, confirmed-example disable/reset, malformed or truncated output, cancellation and abstention despite matching prior choices. The assembled Web test exercises the actual Loader, transport, draft transfer and approved scope with explicitly synthetic provider responses. Neither fixtures nor cached replay establish generalization or answer quality.

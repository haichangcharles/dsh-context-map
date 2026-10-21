# Manage a long conversation with Context Steward

English | [中文](context-steward.zh.md)

## Summary

Context Steward helps you keep planning, research, writing and brainstorming in one inspectable conversation family. You choose where the next turn belongs and which earlier material enters its request. Reviewed choices can guide later recommendations; the native conversation remains the evidence record.

## Table of Contents

- [Start a workspace](#start-a-workspace)
- [Choose context and a destination](#choose-context-and-a-destination)
- [Review Agent advice](#review-agent-advice)
- [Manage work and preferences](#manage-work-and-preferences)
- [Keep a management record](#keep-a-management-record)
- [Verify without an API](#verify-without-an-api)

<a id="start-a-workspace"></a>
## Start a workspace

Follow the [source installation](../../../README.md#run-from-source), then [select a workspace and configure a model](index.md). Context Steward runs in the shipped `web` profile. Use an isolated `DSH_HOME` when trying a runtime upgrade with existing Session data; the [migration limitation](../../../README.md#existing-session-data) applies.

Open the Context Map beside Chat. Each branch is a native Harness Session. Shared inherited messages appear once; each source retains its original owner. The current Session has its own Context Plan.

<a id="choose-context-and-a-destination"></a>
## Choose context and a destination

**Natural** uses messages on the current Session path. **Exclude** omits a selected path message. **Include** borrows a supported source from another branch. Returning an imported source to Natural stops using it in the current request while preserving its origin. Include it again whenever it becomes useful.

For example, research the launch date in one branch and draft a community website page in another. Include the date evidence while writing, return it to Natural when brainstorming unrelated wording, and Include it again for the final fact check. These are per-request selections, not deletion or task completion.

Use **Branch** for a separate task. Use **Move draft here** to transfer the unchanged unsent draft to an existing branch; the operation rejects a changed draft or a destination that already has a draft. The control requires a nonempty unsent draft. **Locate** only inspects a message and supplies no preference label. A route recommendation can separately propose Navigate to an existing branch or Return through native ancestry.

If you add a correction while an answer is running, the completed question/answer pair is not offered for relocation: that would omit your correction. Native Branch and Branch from here still preserve the complete conversation prefix.

<a id="review-agent-advice"></a>
## Review Agent advice

| Mode | Purpose | Additional model requests |
| --- | --- | --- |
| Local | Graph checks, explicit routing cues and confirmed-choice advice | Zero; default |
| Fast | Bounded semantic source and destination review | One tool-free request; optional goal-model-plus-Jev uses at most two |
| Deep | Deliberate review of an isolated full-tree snapshot | Explicit DSH review; default 3 requests, configurable 1–10, 45-second timeout |

Review a draft before sending it, or open the Map review menu. Advice never sends the draft, creates a branch or changes the Context Plan by itself. Destination relevance and evidence relevance are separate: a useful research branch may supply evidence while the conversation stays on the writing branch. Uncertain destination advice preserves the current branch. Local uses explicit cues, lexical overlap and confirmed choices; it does not establish general semantic understanding. Deep counts retries toward its request limit and caps each request at 1,200 output tokens.

Accept only the useful items. **Keep current** explicitly declines that item's proposed action; leaving an item undecided is not feedback. Closing a sheet records already selected declines without changing context. Apply changes the reviewed selection as one revision; Undo removes the corresponding learning evidence. A changed draft, graph or Plan invalidates old advice and requires a fresh review.

Automatic post-turn Branch classification is opt-in in the Prompt Dashboard. Enabling it can add one auxiliary request per eligible turn. The main Agent's explicit Branch request still produces a confirmation card when background classification is disabled.

<a id="manage-work-and-preferences"></a>
## Manage work and preferences

Park, Complete and Reopen describe a branch's task lifecycle. They do not delete its evidence or change context selection. Completed branches remain available as evidence and for an explicit Resume. A later human turn reopens that branch. A suggested work-state change is reviewed separately from Include, Exclude and Archive. Local requires an explicit Park, Complete or Reopen cue; Fast and Deep may suggest at most one graph-valid change. An explicit draft cue takes precedence over model advice.

The Preferences view summarizes repeated confirmed Context choices across native Session families in the same Profile. It conditions advice on the activity, source kind and branch relation where evidence exists. Sparse choices retain conservative defaults. Recent evidence identifies the originating Session event; passive viewing, unanswered cards and unmarked Remote calls do not train the profile.

Reset learning clears the derived preference projection using logged Session watermarks. It retains conversations, their original choice records and the current Context Plan. Later explicit choices can build fresh evidence. This policy memory describes Context-management habits, not general personality or personal facts.

In Context Map prompt settings, Fast Context reviewer selects the current chat model, Jev, Goal model + Jev Context, or Goal model + exact task Context. Jev requires `TYPESAFE_API_KEY` on the Host and may incur a charge; selecting it does not make a request. Learn from confirmed Context choices controls historical examples and personal calibration for future reviews. Expand a review sheet to inspect the model examples and the separate calibration records. A policy reset or settings change cancels running reviews that retain older evidence.

Goal model + Jev Context first identifies the exact draft's task and requested history. You can ask to retain only that task's messages or also its ancestor tasks; a new task's own history starts empty. For a preservation request, Jev reviews explicitly requested source exceptions: low relevance alone does not discard preserved messages, and relevance alone does not authorize borrowing from another task. The ordinary approval sheet shows the proposed selection before any change.

When the review displays **Only this task** or **This task and its parent tasks**, approving the complete changed scope can keep an example of that whole choice for later suggestions. Keeping any item unchanged records only partial feedback. Undo removes the complete-policy example; Redo restores it, and Reset learning discards it from future reviews. Empty scopes, unchanged selections and proposals with source exceptions do not create these examples. A displayed choice is not a claim about your general personality.

An uncertain task, retention request or required ancestry skips Jev and suppresses the combined automatic recommendation; manual choices remain available. A conflicting task destination or new/existing choice also suppresses it. Relevance review remains available for drafts without a preservation request. A draft uses one chat-model call and at most one Jev call; a non-draft Fast review uses Jev alone. The Host checks credentials before the first call and bounds the composite review to 45 seconds. This mode is optional, not a demonstrated accuracy guarantee.

Goal model + exact task Context uses at most one chat-model call and no Jev call or credential. Choose it to retain a complete task or its original ancestor chain, with no source exceptions. For individual sources, choose the other reviewers. A new task-owned branch starts with no historical Context. Uncertain tasks or policies abstain, as do manual, replacement or routing conflicts. Only an exact draft can propose another destination; without one, it reviews the current task. You still approve every change. Chat-model use may incur charges; this option guarantees the scope relative to the validated assignment, not that the model assigned the right task.

Open **Context preferences → Confirmed complete-policy examples** to inspect the latest four active historical modes, tasks and original event references. A review may instead include older relevant cases, so its recorded examples can differ from this recent-history list. These choices are examples for enabled personalized review, not permission for a current change. Refresh after Context Undo/Redo; Reset learned preferences refreshes the list and keeps the Context Plan.

<a id="keep-a-management-record"></a>
## Keep a management record

Pause activity, select the highest known Session in the conversation family, then use **Download session log** in its header menu or `/export`. The [existing log exporter](../../../packages/session-query/session-log-export/README.md) includes that Session and its known descendants. Exporting a child alone omits its ancestors and siblings. Sessions are read sequentially, so the archive is not an atomic snapshot of the whole family.

The archive contains original conversation text, logged requests, management choices, workspace paths and referenced attachments; it is not anonymized. Keep it local and inspect it before sharing. Undo and Reset learning preserve earlier raw choices while changing their eligibility for later recommendations. A reset recorded in another family requires that family's log for complete Profile reconstruction. Per-Session sequence numbers and explicit source references retain ordering; timestamps alone do not establish a total order across branches. Client-declared presentation or approval is not proof of a person's identity or attention, and an export does not contain every ephemeral review detail.

To verify selected fixture logs through the same export reader, official decoder and native Context compiler, run:

```sh
pnpm exec vitest run scripts/context-steward-export.spec.ts --maxWorkers=1
```

This isolated engineering check preserves approval references and checks Undo, Redo and Reset after restoration. It neither reads your saved conversations nor evaluates model quality or real user preferences.

<a id="verify-without-an-api"></a>
## Verify without an API

After the [source installation](../../../README.md#run-from-source) through `pnpm run build`, run these native workflow checks from the repository root. They need no model configuration or browser:

```sh
pnpm exec vitest run packages/context/contextify/tests/route-scope.spec.ts packages/context/contextify/tests/scope-policy-runtime.spec.ts --maxWorkers=2
```

The two suites use the actual Session, Contextify and Context Plan services in isolated temporary directories, with model and Jev responses supplied by engineering fixtures. They check:

1. Branch under a selected parent, Return without carrying the child’s Context, and later navigation that reactivates that Context.
2. Complete changed Context approval, its original event reference and its example in the next Host goal input. An unchanged scope supplies no complete-policy example.
3. JSONL restoration in a new service instance, Undo/Redo, and Reset learning that remains effective after another cold resume.

Both test files must pass. These are isolated engineering scenarios, not one continuous user session or a semantic-accuracy evaluation; they do not modify your saved conversations.

To inspect the constructed 30-turn fixture and its separate expectations, export its prefix-only packets:

```sh
node --import tsx/esm scripts/context-steward-replay.ts /tmp/context-steward-replay
pnpm exec vitest run scripts/context-steward-replay.spec.ts
```

The command writes `.visible.json`, `.gold.json` and `.summary.json`. Each visible packet contains only the graph and confirmed choices available before its decision. Expectations and controlled scorer outputs are kept out of that packet. The `actionPacket` field is the production bounded scorer input; the surrounding full fixture graph is debugging context, not an additional model request. The replay checks native fork identity, completed evidence, re-entry and route constraints without calling a provider. It is an engineering example, not a dataset of observed human preferences or a semantic-accuracy benchmark.

The assembled browser acceptance case exercises actual UI and compiled requests with keyless response replay after building the Client:

```sh
DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/contextify-long-horizon.e2e.ts
```

See the [Contextify package](../../../packages/context/contextify/README.md) for compiler, source-bound worker and revision limitations, and the [UI package](../../../packages/client/ui-contextify/README.md) for integration details.

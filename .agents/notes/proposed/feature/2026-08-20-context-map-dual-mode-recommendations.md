# Agent Note: Context Map dual-mode recommendations

Status: proposed

English | [中文](2026-08-20-context-map-dual-mode-recommendations.zh.md)

## Problem

Context Map reviews must serve two different user needs. Most reviews should return quickly from the current conversation objective and a small set of relevant branches. Some reviews need to inspect a large native Session family, follow topology, compare distant alternatives, and identify superseded messages before proposing a replacement context. One direct model request over the complete graph makes the common path slow, consumes a large prompt, and fails visibly when the model does not return valid JSON.

Automatic Branch review has a related but narrower problem. A completed Turn can be a local continuation, a detachable side investigation, or a parallel topic, but the current classifier sees only four recent message previews and the completed Q&A. It lacks the current branch objective, ancestor objectives, branch depth, and branch load that distinguish a useful branch from an unnecessary interruption.

The product needs an explicit fast/deep choice for Context recommendation while keeping Branch recommendation lightweight. Both Context modes must produce the same review-only proposal, preserve native Session and Context Plan ownership, and never mutate selection or archive state before user confirmation.

## Proposal

Context Map exposes two manually selected Context recommendation modes. Fast is the default and uses one bounded, tool-free model request. Deep is an explicit user action that starts a temporary Harness agent over a frozen Context Tree file. The system never upgrades Fast to Deep automatically and never uses Deep for Branch recommendation.

Both modes return the same selection and archive decision fields:

```json
{
  "exclude": [{ "nodeId": "...", "reason": "..." }],
  "include": [{ "nodeId": "...", "reason": "..." }],
  "archive": [{ "nodeId": "...", "reason": "..." }]
}
```

Contextify validates that every node belongs to the reviewed graph, rejects conflicting actions, removes harmless no-ops, computes the complete Current and Proposed node sets, and records no Context Plan event until the user applies the proposal. Apply remains one atomic selection replacement with the existing Undo behavior. Archive items remain advisory and require individual confirmation.

## Fast recommendation

Fast recommendation follows a topic-routing design rather than serializing the complete graph. Contextify builds a bounded review packet from the latest objective, the active branch objective, ancestor branch summaries, the three most recent completed Turns on the active path, every explicit Include or Exclude override, and a small deterministic set of off-path candidates ranked by lexical relevance and graph proximity. The packet preserves node IDs, roles, effective inclusion, active-path membership, and parent/child references for the included candidates.

One tool-free model request receives the packet and the effective Context recommendation prompt. The mode uses temperature zero, the route's lowest available reasoning effort, a strict output schema, and a bounded output budget. It may recommend only nodes present in the packet. A malformed or unavailable response leaves the current context unchanged and reports a compact failure without covering the canvas.

Explicit user selection has priority over automatic review. An explicit Include acts as a pin and an explicit Exclude acts as a block. Fast recommendation does not reverse either state. Reset removes those overrides and returns their nodes to natural active-path behavior.

## Deep recommendation

Deep recommendation freezes the complete visible Context Tree at one graph revision and one Context Plan revision. The snapshot contains only user input and final assistant output nodes already eligible for Context Map display; reasoning, tool calls, tool results, system injections, and runtime-only events remain absent. Each node record contains its stable node ID, role, full text, native Session ownership, active-path membership, effective inclusion, explicit override, archive state, and incoming and outgoing graph references.

Contextify creates a process-temporary directory outside the user's Workspace, writes the snapshot as one private JSONL file, and starts a one-shot in-process Harness child whose Session cwd is that directory. The directory uses mode `0700` and the file uses mode `0600` where the platform supports POSIX permissions. JSONL is an internal implementation choice; no durable or public file format is introduced.

The child receives only the native `read` and `grep` tools plus the structured-output tool attached by the subagent runtime. A child-scoped pre-execution policy resolves every requested path and denies access outside the exact temporary snapshot file. The child receives read-only sandbox and approval settings, cannot invoke Bash, write or edit files, access Web tools, start subagents, or inspect the user's Workspace, and cannot mutate the live Context Map.

The Deep prompt tells the child to inspect the current included set first for materially irrelevant or conflicting nodes, search the remaining tree for missing relevant nodes, and recommend archive only for content that is clearly obsolete or contradicted. The agent may make several bounded `grep` and `read` calls, then must submit the same structured result used by Fast. A configurable timeout and step budget bound latency and cost.

Contextify disposes the child and removes the temporary directory in one `finally`-owned lifecycle for success, invalid output, cancellation, timeout, stale state, and infrastructure failure. Application startup also removes Contextify temporary directories older than a bounded retention period so a process crash does not leave snapshots indefinitely.

## Shared prompts and validation

The Prompt Dashboard retains one Context recommendation policy shared by Fast and Deep. The read-only package prompt defines selection meaning; the ordinary editable field appends profile instructions; the existing explicit override replaces the package policy for advanced users. Mode-specific instructions, tool restrictions, untrusted-node handling, and the output schema remain package-owned suffixes that profile text cannot remove.

The validator, not the model, constructs the complete Proposed version. Returning an already included node under Include or an already excluded node under Exclude is a harmless no-op. Unknown IDs, duplicate archive items, and opposing selection actions for one node remain invalid. A proposal carries its mode and reviewed revisions for presentation and stale rejection, but mode does not change Apply semantics.

## Branch recommendation

Branch recommendation remains one lightweight, tool-free classifier. It starts in parallel with the main response after a user input is accepted and compares the input with the current local objective before considering ancestor or mainline objectives. Its bounded input contains the current branch objective, ancestor summaries, recent completed Turns, branch depth, active branch count, and recent sibling branch intents.

The default decision is Keep. The classifier suggests Branch only for a meaningful local topic change, detachable subtask, parallel alternative, or temporary detour likely to create follow-up turns. Higher branch depth and branch load raise the display threshold. Failure, invalid output, cancellation, an unsuccessful main Turn, or a changed Session silently resolves to Keep.

After the final assistant output is durable, a still-current Branch decision may render one inline suggestion attached to that Q&A. Acceptance moves the exact input and final output through the native Session fork and relocation path. Rejection and expiry do not mutate the conversation; their feedback remains available to the profile-owned Branch policy without starting a deeper agent review.

## Client interaction

The Context Map recommendation control offers Fast and Deep actions. Fast is visually the default on every invocation; the client does not persist the last choice and does not auto-upgrade. Only one recommendation may run for a Session family at a time. Deep exposes Cancel and a compact progress state that says the agent is inspecting the tree without rendering its internal tool transcript on the canvas.

Fast and Deep open the same Current/Proposed review sheet. The sheet labels the mode, shows added and removed nodes as one replacement version, keeps Archive suggestions separate, and preserves Apply, dismiss, and Undo behavior. Recommendation failures use a non-blocking notice and retain the prior ready proposal only when its reviewed revisions remain current.

## Error handling and verification

Every mode captures graph and plan revisions before analysis and rechecks both after analysis. A change anywhere in the native Session family makes the result stale. Tool access outside the Deep snapshot, an invalid structured result, or a missing model route fails closed without applying any action.

Package tests cover Fast candidate bounds and ordering, explicit pin and block preservation, shared no-op and conflict validation, Deep snapshot completeness, path denial, structured completion, cancellation, timeout, every cleanup path, and stale-family rejection. Client tests cover mode selection, Fast defaulting, Deep cancellation, progress, non-blocking failure, identical review rendering, Apply, and Undo. A keyless assembled Web replay exercises both modes through the real Context Map controls and confirms that recommendation alone is inert.

## Alternatives considered

**One complete-graph model request.** This keeps one code path but repeats the full graph in the model prompt, makes latency proportional to total tree text, and preserves the malformed-response failure that motivated the change.

**A permanent Context Tree query tool.** A stable tool API would avoid a temporary file, but it would add a public capability and maintenance contract for an internal review task. The temporary file lets the child use existing Harness tools and disappears with the run.

**Automatic escalation from Fast to Deep.** Automatic escalation could recover uncertain Fast decisions, but it makes latency, cost, and tool use unpredictable. Deep therefore remains an explicit user choice.

## Acceptance criteria

- Fast is the default manual Context recommendation and never starts a tool-using agent.
- Deep uses one frozen temporary Context Tree file, native `read` and `grep`, structured output, hard path restriction, and complete cleanup.
- Both modes produce one validated Current/Proposed selection version and separate advisory Archive items without mutating state before Apply.
- Explicit Include and Exclude overrides survive recommendation until the user resets or changes them.
- Branch recommendation uses the lightweight topic classifier, runs beside the main response, and fails silently to Keep.
- Focused package, client, and keyless assembled replay coverage pins the user-visible and lifecycle behavior.

## Risks

Fast candidate selection can miss a distant relevant node; Deep exists as the explicit full-tree alternative. Deep costs more time and tokens and can still make a poor semantic judgment, so its result remains review-only. Temporary snapshots contain conversation text; restrictive permissions, exact-path tool policy, bounded retention cleanup, and non-durable placement reduce exposure but cannot make process memory or a live child risk-free. Conservative Branch thresholds reduce interruption at the cost of missed suggestions.

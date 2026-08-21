# Lightweight Context Recommendations and Inline Branch Review

[English](2026-08-20-lightweight-context-recommendations-design.md) | 中文

## Outcome

Context Map recommendations become a short, tool-free model classification followed by deterministic Harness processing. The model returns only three action lists—`exclude`, `include`, and `archive`—while Contextify validates node identities, removes harmless no-ops, rejects ambiguous conflicts, and constructs one atomic Current → Proposed context replacement. Branch recommendations remain asynchronous and lightweight, but their decision UI moves into the completed turn's normal document flow so it never covers the answer or composer.

## Recommendation protocol

The model response is plain JSON with exactly three top-level arrays:

```json
{
  "exclude": [{ "nodeId": "session:seq", "reason": "..." }],
  "include": [{ "nodeId": "session:seq", "reason": "..." }],
  "archive": [{ "nodeId": "session:seq", "reason": "..." }]
}
```

Missing arrays normalize to empty arrays. Markdown fences around a single JSON object are accepted. The model does not calculate the proposed version, mutate the Context Plan, create placeholders, or call tools.

The system performs these rules after parsing:

- `exclude` is evaluated against the currently included set; already excluded nodes are discarded as no-ops.
- `include` is evaluated against the currently excluded set; already included nodes are discarded as no-ops.
- A node appearing in both `include` and `exclude`, an unknown node, duplicate archive entry, malformed item, or overlong reason rejects the result.
- The graph's stable order determines Current and Proposed node order.
- Apply submits all include/exclude changes as one native Contextify mutation. Existing Undo restores the previous version.
- Archive is advisory and never part of Apply. Each archive candidate requires separate user confirmation. Confirming uses the existing deterministic placeholder rule; the model never authors replacement text.

## Execution path and latency

`ContextifyService.recommend()` uses the existing Harness `llm.stream()` route of the latest assistant output. It is a single tool-free request with a compact system prompt, bounded graph JSON, and a small output budget. It does not spawn a child Session or run an Agent loop. Text blocks are assembled, the first complete JSON object is parsed, and the normal stale-plan/stale-graph checks run before returning a proposal.

Recommendation failure is shown once as a compact inline notice next to the map toolbar. It does not create both a top alert and an overlay sheet. A valid proposal keeps the existing review/apply experience.

## Branch recommendation

The post-turn branch classifier stays asynchronous and cannot delay the conversation response. It uses one direct, tool-free LLM request over the completed Q&A and a short recent-history window. Only a high-confidence `suggest_branch` result creates a suggestion.

The UI is registered in `conversation.chat.turnTail` and appears immediately after the matching completed assistant output. It contains the reason and two explicit actions: “Keep here” and “Move to new branch”. It occupies normal layout space, has a bounded readable width, and never renders inside the narrow assistant action row. Moving still delegates to the native Harness branch relocation/fork operation; this change only alters presentation and reduces classifier input/output budgets.

## Compatibility

No alternative conversation store, branch model, or Agent loop is introduced. Context selection, archive placeholders, branch creation, session navigation, Apply, and Undo continue to map to native Harness/Contextify primitives. Prompt Dashboard append rules remain part of the system prompts used by the two direct classifiers.

## Acceptance criteria

- A recommendation containing an already-included `include` item succeeds and filters that item.
- Unknown nodes and conflicting include/exclude actions fail closed.
- The recommendation path never calls `subagents.start()` and does not create a child Session.
- A valid recommendation produces a complete atomic Proposed version and remains unapplied until confirmation.
- An invalid response produces exactly one compact error notice and does not cover the canvas.
- A branch suggestion appears only after its matching assistant output, in normal flow, and both actions work.
- Existing Context Map selection, archive, placeholder, relocation, and undo tests continue to pass.

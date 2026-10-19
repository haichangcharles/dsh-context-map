# Agent Note: Conditional Context management memory

Status: implemented

English | [中文](2026-10-19-context-management-memory.zh.md)

## Problem

A short list of individual past choices cannot express repeated management sequences. Profile-wide summaries can also turn planning-specific decisions into global preferences. Separate persona storage would duplicate native event ownership and complicate Undo and reset.

## Decision

[Contextify](../../../../packages/context/contextify/README.md) derives conditional rules and repeated two- or three-action workflows from existing owned policy observations. It supplies one frozen projection to the Host decision packet, goal reviewer and inspectable proposal. All model-visible content follows existing request logging; historical examples never enter answer Context. The existing native operation DAG and approval checks remain the only execution authority. No additional memory store, inference call or agent loop is introduced.

Rules reuse prior-smoothed support while retaining known activity/source conditions and exact starting branch depth. The latest eighty owned observations supply at most eight rules and four workflows. Workflows require increasing owned cursors within a Session or a prior operation targeting the next Session with a strictly later event time. Undo and rejected terminal actions break the chain; mixed or insufficient support abstains. Each item retains signed effective support, at most six native references and at most two workflow examples of bounded objectives. The complete projection fits 16KiB UTF-8 by dropping whole items, never truncating event identities. Profile reset and personalization disable remove the corresponding evidence through existing Host ownership.

This adapts source-backed incremental contextual rules from [ACE](https://arxiv.org/abs/2510.04618) and reusable action sequences from [Agent Workflow Memory](https://arxiv.org/abs/2409.07429). It borrows their organization principles, not their reflector inference, training, executor or reported results. [PenguinHarness](https://github.com/Prism-Shadow/PenguinHarness) provides a useful comparison of these techniques; no external implementation is copied or installed.

## Alternatives considered

**Global preference prose without conditions or evidence.** Rejected because task-specific choices must remain inspectable and retractable, and cannot imply current authority.

**Persist a second persona or automatically execute retrieved workflows.** Rejected because native logs already own preference evidence, and historical sequences do not establish current legal steps or consent.

**Learn from every Agent proposal or concatenate adjacent cross-Session records.** Rejected because an unconfirmed suggestion is not a preference, and temporal proximity alone does not establish a shared workflow.

## Consequences

The current model can receive bounded reusable management evidence without extra calls. The Web review displays the same conditions, signed support and native references. Unit regressions cover causal joins, retraction, conditions and complete UTF-8 bounds; real Loader composition checks model/snapshot agreement and disable/reset through product services with engineering provider fixtures. These checks establish product behavior, not improved user modeling, model decisions or answer quality. Cross-Session events sharing a timestamp are omitted rather than assigned an invented order.

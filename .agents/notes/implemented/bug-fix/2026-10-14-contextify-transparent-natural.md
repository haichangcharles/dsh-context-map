# Agent Note: Transparent Natural context and preset-scoped Branch tools

Status: implemented

English | [中文](2026-10-14-contextify-transparent-natural.zh.md)

## Problem

Opening an ordinary Web conversation must not alter its request history before the user edits Context. A Host-registered Branch tool also leaks into the minimal preset, whose model contract is a fixed prompt and one persistent shell, and into the global catalog that the preset system deliberately leaves empty.

## Decision

Contextify projects an unedited Session using a detached Natural Plan. Agent startup and graph reads append no Plan or compiler selection. The first committed Context edit records the initial undo state, records the edited Plan, and selects Contextify from the surface compiler. Recorded Plans remain restorable, and native children reset inherited recorded Plans. An explicitly mounted lineage runtime can upgrade a fresh surface Session; legacy assistant history without read sets retains its existing compiler.

The optional `@deepseek-ai/dsh-contextify/branch-tool` consumer registers `request_context_branch` in its owning preset scope. Standard, cordis and PTC compose it; minimal does not. Its `enabled` config defaults to true. Without a Host Contextify service it registers nothing. The tool delegates to the same validated direct-human-Turn request operation and schedules confirmation without creating a branch.

## Alternatives considered

**Register globally and update every preset expectation.** This makes a minimal model contract depend on an unrelated Host service and bypasses preset ownership of model tools.

**Disable Contextify for historical browser replays.** This hides live graph and compiler behavior from those tests. Transparent Natural startup permits the original recorded model response and durable log to remain the oracle; separately pinned current tool schemas can explicitly include the new consumer.

**Filter Plan and compiler events from replay comparison.** These events determine later request selection and cannot be discarded by a normalizer.

## Consequences

Ordinary Natural conversations retain the original surface request and event sequence. The first explicit Context edit pays a small durable initialization cost so Undo can reconstruct the initial state. A previously unedited fork retains a virtual revision-one Plan rather than materializing an unused reset. Model tools require explicit preset composition, while Context graph and Client controls remain available from the Host service.

## Testing

Native tests cover unchanged startup and graph-read logs, scoped catalog isolation, absent-Host and disabled consumers, scoped disposal, valid Branch requests, first-edit history, child reset, and opt-in lineage admission. Browser replay keeps committed model recordings unchanged and compares their exact persisted Session output.

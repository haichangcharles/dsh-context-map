# Agent Note: Context Plan selection through compaction sources

Status: implemented

English | [中文](2026-09-28-context-plan-compaction-source-closure.zh.md)

## Problem

A physical Session checkpoint can summarize several historical messages. Excluding one of them from a Context Plan leaves the checkpoint selected, so its text can reintroduce the excluded message. A delegated child can likewise cite a checkpoint that remains selected even though one of its recorded sources is denied.

## Decision

[Contextify](../../../../packages/context/contextify/README.md) unfolds a compaction checkpoint into its recorded message sources when the current plan excludes or archives one of those sources. Selection and tool-call/result grouping then operate on the logical source messages. A checkpoint unaffected by the plan remains selected, and Undo can reuse it. A Natural plan with no denied sources does not traverse checkpoint ancestry during compilation.

The opt-in revision-lineage admission check walks a selected event's transitive `sourceEventSeqs` closure. It rejects a child result when any recorded source is denied, including a source hidden inside a nested checkpoint. Physical replacement provenance remains separate from a summarizer's actual read set; the latter is not completely recorded by this change.

## Alternatives considered

**Keep the checkpoint whenever its surface node is selected.** A mixed checkpoint can expose content that Exclude or Archive removed from the current request.

**Invalidate every checkpoint after any plan edit.** This discards independent checkpoints and makes Undo unnecessarily replay raw history.

**Treat the recorded shadowed span as an exact semantic read set.** The compaction record names replaced physical nodes, but a summarizer can receive other inputs. Treating it as complete would overstate the guarantee.

## Consequences

Native tests cover edits before and after compaction, Archive, nested checkpoints, tool pairing, child admission, independent sibling retention, and Undo. An Agent Loop test also checks the exact messages sent to a mock provider after Exclude and Undo. Logical expansion can enlarge the request beyond the physical surface estimate; automatic `compaction-basic` pressure and summarization still operate on that physical surface. A view-consistent compaction protocol and complete read-set observation remain separate work.

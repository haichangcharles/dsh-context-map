# Agent Note: Local Context review admission

Status: implemented

English | [中文](2026-10-19-local-context-admission.zh.md)

## Problem

Repeated manual Context exclusions can exceed the Fast classifier's32mandatory-node budget. Sharing that model-packet admission path with zero-model Local review prevents Branch/Return even when the native graph and Plan remain valid.

## Decision

[Contextify](../../../../packages/context/contextify/README.md) derives Local calibration candidates directly from native graph metadata, effective selection and existing lexical features. It copies no source text into a packet and has no inference-slate ceiling. Direct Excludes are protected before automatic additions are ranked; reviewed temporary Excludes remain eligible. Existing calibration still proposes at most two additions and two style exclusions, and native validation preserves manual constraints. Local retains bounded task cards, preference rules, abstention and explicit route approval; it does not invoke a model or construct a Fast request. Fast keeps its existing32-node limit and failure before dispatch.

## Alternatives considered

**Raise or silently truncate the Fast mandatory budget.** Rejected because Local performs no inference and cannot justify changing a model-facing protocol or hiding pinned constraints.

**Skip Local preference calibration or change only the failing test.** Rejected because the product must retain learned management behavior after many manual actions. Independent model-free candidate features remove the incorrect coupling.

## Consequences

Long manual Context histories retain Local routing and calibration. The scalar projection is linear in graph size; it does not clone complete source content. Owning regressions cover33direct Excludes, unchanged Fast refusal, Local Branch/Return carrying approved compiled messages and zero model requests. Real Loader acceptance exercises a wide native Plan. These are engineering checks, not new autonomous Branch accuracy evidence.

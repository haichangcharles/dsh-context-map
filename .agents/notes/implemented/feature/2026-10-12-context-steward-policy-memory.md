# Agent Note: Context Steward policy memory

Status: implemented

English | [中文](2026-10-12-context-steward-policy-memory.zh.md)

## Problem

Long-running conversations require repeated Include, Exclude, and Branch decisions. A generic Context recommender cannot distinguish a person's preference for Web imports from a preference for old chat messages, while an ungrounded persona summary can mistake a model suggestion or an ignored card for the person's choice.

## Decision

Contextify projects confirmed Context-management events across native Session families in the same DSH Profile into a compact policy memory. Owned events count once despite inherited prefixes. A reviewed multi-item sheet contributes one total observation; direct changed node selections, confirmed Branch Keep/Move and route-card choices, and successful manual Context Map forks contribute explicit observations. Undo removes the associated Plan choice from the current projection. Passive presentation and unmarked Remote calls do not train the policy. Changed families are rebuilt from the event logs; unchanged families reuse cached projections.

The projection uses a smoothed action estimate and backs off to the Profile-wide rate when an activity, source-kind, or nearby branch-depth cell has fewer than four effective observations. Repeated action choices become typed favor/avoid rules only after four effective observations. The native event log remains the evidence record; the summary carries support and never becomes permission to mutate a Session or Context Plan. A `stewardProfile` Remote exposes the projection for inspection. Navigate and Return gain evidence only from explicit route-card choices.

Fast Include/Exclude advice also draws on the latest 32 confirmed, non-undone edits across the Profile. A typed source/action/path preference and a shrunken relevance residual can rank both off-path sources and older included active-path sources, then calibrate review-only proposals in a new Session family. The model-visible Fast examples and grouped plans remain local to the current family, so older unrelated Session text is not sent as preference examples. The Host rebuilds this derived view from event logs rather than persisting a second persona document.

This adapts the observation/reflection/retrieval pattern of [Generative Agents](https://arxiv.org/abs/2304.03442) and the consolidation idea of [Mem0](https://arxiv.org/abs/2504.19413) to policy about Context management. It does not store general personal facts or claim that these borrowed mechanisms are new.

## Alternatives considered

**Summarize all conversation text into a persona paragraph.** Rejected because task content is not evidence of a Context-management preference, and a free-form summary obscures support and reversals.

**Use every displayed suggestion as feedback.** Rejected because presentation and silence do not prove attention or rejection; deterministic exposure also has unknown propensity.

**Use one global preference for all source types.** Rejected because Web evidence, chat history, and worker reports can elicit different choices.

## Consequences

The Host can inspect repeated confirmed preferences across Sessions without a model call, and review thresholds can adapt conservatively. Sparse or unobserved actions retain their prior. A live explicit pre-send route card and Navigate/Return feedback now exist. Separate-family Persona2Web replay checks the engineering transfer path, but does not establish a gain over simple conditional tables, downstream Web success, or unbiased offline bandit estimates.

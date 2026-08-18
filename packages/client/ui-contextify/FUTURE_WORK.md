# Context Map Agent Recommendations — Future Work

English | [中文](FUTURE_WORK.zh.md)

These three opportunities form one recommendation layer above the existing deterministic Context Plan. They are deliberately not runtime features yet. Every recommendation must be inspectable, explain its evidence, and require explicit user review before changing durable context or Session structure.

1. **Recommend context selection.** An Agent proposes which message nodes should enter the next request, distinguishing additions from removals and explaining why each node matters for the current objective. The user can accept individual changes or an entire proposal; a recommendation never silently changes Include, Exclude, or Natural state.
2. **Recommend pruning.** An Agent identifies obsolete, duplicated, superseded, or low-value nodes and branches. The proposal must distinguish context exclusion from destructive deletion or archival, estimate the context reduction, and preserve recovery. The first implementation should recommend reversible exclusion or archival rather than deleting native Harness history.
3. **Recommend branch or main-line promotion.** Before a new turn, an Agent can suggest starting a native branch, appending to an existing related Session, or promoting a useful branch result back to the main line. The proposal must name the target Session and branch point, show the context that would be inherited, and leave the final routing decision to the user.

Shared product questions for the future implementation include recommendation timing, confidence and rationale display, stale-proposal invalidation after new turns, atomic acceptance, undo behavior, privacy boundaries, and evaluation against manual Context Map decisions.

# Context Map Agent Recommendations — Future Work

English | [中文](FUTURE_WORK.zh.md)

The first two opportunities now form a manual, review-only runtime layer above the deterministic Context Plan. The third remains future work. Every recommendation stays inspectable, explains its evidence, and requires explicit user review before changing durable context or Session structure.

1. **Implemented: recommend context selection.** An isolated Harness Agent proposes additions and removals with confidence and rationale. The user accepts individual or selected changes; recommendations never silently change Include, Exclude, or Natural state. Proposals become stale after their revision or graph watermark changes.
2. **Implemented: recommend semantic cleanup.** The Agent identifies obsolete, conflicting, or redundant message nodes. Cleanup never runs in bulk: the user confirms one editable role-preserving placeholder at a time. The same node, edges, fork point, original Session event, Restore, Reset, Undo, and Redo remain available.
3. **Recommend branch or main-line promotion.** Before a new turn, an Agent can suggest starting a native branch, appending to an existing related Session, or promoting a useful branch result back to the main line. The proposal must name the target Session and branch point, show the context that would be inherited, and leave the final routing decision to the user.

Remaining product questions include automatic recommendation timing, branch routing, privacy controls beyond the current bounded same-family projection, and evaluation against manual Context Map decisions.

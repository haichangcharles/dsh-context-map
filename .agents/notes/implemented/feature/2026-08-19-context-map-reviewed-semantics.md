# Agent Note: Context Map reviewed semantics

Status: implemented

English | [中文](2026-08-19-context-map-reviewed-semantics.zh.md)

## Problem

A native Session family preserves complete conversational history, but long-running work needs a smaller request context without losing branch identity or making irreversible edits. Automatic cleanup is unsafe because one message can anchor later branches, and a recommendation can become invalid while another Session in the family changes.

## Decision

`dsh-contextify` keeps native Session messages, edges, fork boundaries, archive projection, and ownership as the graph authority. The Map projects only each completed Turn's initial user input and final assistant output. Include and Exclude are durable Context Plan choices; reasoning, tools, and intermediate assistant steps remain available in the native trajectory but do not become Map nodes.

An isolated Harness spawn Agent receives a bounded JSON projection of one exact family revision and returns review-only selection and cleanup recommendations. Message content is untrusted data, tools are disabled, structured output is validated against the reviewed graph, and no recommendation mutates the parent Session. Selection changes execute only after explicit acceptance. Cleanup has no bulk action: each candidate requires confirmation and replaces only model-visible semantics with a role-preserving placeholder.

Context Plan version 3 stores replacement overlays separately from native messages. A replacement retains the node id, role, edges, fork point, original content, and Include or Exclude state. Restore removes the overlay; an off-path Include that referenced a placeholder snapshot is rebound to a new snapshot of the original message. Reset clears every explicit selection and replacement. Version 2 plans normalize in memory and the next mutation writes version 3.

Recommendation freshness combines the Context Plan revision, active Session identity, and a hash of every native chat Session header and append position in the family. Sessions marked `origin: subagent` are excluded from the graph and its revision because the review Agent itself is a temporary child implementation detail. The service verifies this revision before launching, after the isolated run, and immediately before accepted selection or cleanup mutations. A changed parent, sibling, native descendant, plan, or active Agent state therefore fails closed.

The Client renders the Map as a pinned right-details page alongside the native Details page. React Flow positions use measured node bounds, so parent-bottom to child-top and sibling bounds retain fixed graph-space gaps without resetting the user's viewport after measurement. The original message dialog receives full text while cards retain bounded previews.

## Verification

Contextify service tests cover bounded isolated recommendations, the shipped spawn child's temporary Session shape, family-wide stale rejection, version 2 normalization, selection compilation, reversible active and off-path replacements, history, and busy-agent rejection. Client tests cover review-only state, explicit atomic acceptance, stale proposals, full original display, one-at-a-time cleanup, checkboxes, native menus, and measured layout. The keyless assembled Web replay proves that recommendation alone is inert, accepted selection changes compiled context, unconfirmed cleanup remains inert, confirmed cleanup creates a placeholder, and restoration recovers the original; it also covers native branching and archive behavior, right-panel interaction, reload persistence, and long-node spacing.

## Alternatives considered

**Create a second branch model inside one Session.** Rejected because native Harness Sessions already own forks, persistence, archive behavior, and Agent lifecycle. A parallel branch vocabulary would split authority and make navigation ambiguous.

**Let recommendations execute automatically.** Rejected because relevance and semantic obsolescence are user-intent judgments, and family changes can invalidate a proposal while it runs. Explicit review keeps the model advisory.

**Delete graph nodes during cleanup.** Rejected because removal can disconnect descendants and erase a valid fork anchor. A reversible placeholder changes request semantics without changing topology.

**Lay out cards with a fixed estimated height.** Rejected because message length, viewport width, and replacement badges change rendered bounds. Measurement is the only reliable input for non-overlapping placement.

## Consequences

Users can control the next model request from the same screen as Chat while retaining Harness-native history, branches, details, and archives. Cleanup remains reversible and topology-safe, and stale advice cannot cross family revisions. The design adds durable replacement snapshots, family hashing, an isolated recommendation call, and a measured-layout pass; it deliberately gives up automatic cleanup, cross-family maps, reasoning/tool nodes, and topology deletion.

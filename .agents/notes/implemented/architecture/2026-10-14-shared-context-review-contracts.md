# Agent Note: Shared Context review contracts

Status: implemented

English | [中文](2026-10-14-shared-context-review-contracts.zh.md)

## Problem

Context review modes repeated native graph adjacency, source-content fields and classifier JSON extraction. Session-family revisions and Branch or excerpt review repeated the same validation. The Prompt Dashboard separately copied immutable Host defaults. CI found eleven clones, and these copies could diverge as Context behavior evolved.

## Decision

Local, Fast and Deep reuse their shared pure topology and source-content projection; selection and optional semantic routing reuse JSON envelope extraction while retaining separate strict schema validation. Owned policy timelines retain native event positions and Undo provenance. The service shares its review-only event predicate, Branch source checks and active focus-node checks without changing mutation order or errors.

The Client reexports immutable defaults and the effective-prompt fold from the existing client-safe Contextify types subpath. The browser purity gate permits only that exact subpath; the Host root, nested types paths and Branch tool remain rejected. Type-only imports in the shared contract do not load the Host service. Clone thresholds and exceptions remain unchanged.

## Alternatives considered

- **Ignore the duplicated ranges.** This keeps independently maintained policy copies and weakens CI.
- **Import the Host service into the Client.** This violates the browser boundary and bundles unrelated runtime state.
- **Share complete mode-specific packets.** Different candidate budgets and Deep full-tree behavior must remain distinct.

## Consequences

The default prompts have one source of truth, and shared review folds retain the same packet values and failure semantics. Mode-specific routing, budgets, public validation, user-confirmation gates and native Session mutations remain separate. This refactor adds no model calls or new automatic behavior.

## Testing

The unchanged clone configuration scans packages and scripts with zero clones. Contextify domain regressions retain per-file full coverage for the modified sources. Prompt settings tests verify shared defaults and preview behavior; the Client purity regression permits the exact pure entry and rejects adjacent Host entries.

## Related

- [Contextify](../../../../packages/context/contextify/README.md)
- [Client bundle purity tests](../../../../scripts/client-bundle-purity.spec.ts)

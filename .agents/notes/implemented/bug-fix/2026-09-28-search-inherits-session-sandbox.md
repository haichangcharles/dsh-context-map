# Agent Note: Filesystem search inherits the calling session sandbox

Status: implemented

English | [中文](2026-09-28-search-inherits-session-sandbox.zh.md)

## Problem

The `bash` tool confines its child process through the session's sandbox policy, while `glob` and `grep` launch packaged ripgrep directly through the subprocess provider. A search could therefore read a file that the same session's confined shell could not read. Keeping `--no-config` prevents ripgrep configuration injection but does not restrict filesystem reads.

## Decision

The shared [`runRipgrep()`](../../../../packages/fs/tool-fs-search/src/search-core.ts) helper resolves `ctx.sandboxPolicy` for the calling session and passes the packaged ripgrep argv through `ctx.sandbox.confine()` for a confining mode. `glob` and `grep` both inherit this behavior. A confining policy without a sandbox provider fails before spawn; a sandbox provider without its policy service also fails. Compositions with neither optional service retain local subprocess search, and explicit `danger-full-access` remains unconfined.

This change reuses the sandbox provider's existing filesystem policy. It does not add source-granular policy configuration. The research-only Seatbelt provider applies a known A-directory read denial to demonstrate that search follows the same restriction as `bash`; it is not part of the shipped policy.

## Alternatives considered

**Leave discovery unconfined because it is read-only.** Search results can expose both matching content and filenames from sources the calling agent may not read.

**Route search through the shell executor.** Search owns a fixed argv, bounded raw-output parsing, and no shell syntax; using the sandbox provider directly preserves those properties and the existing subprocess capture path.

**Require the sandbox services in every composition.** Unconfined local profiles legitimately use filesystem discovery; optional peers preserve that supported behavior while rejecting incomplete confining configurations at execution.

## Consequences

The official search tests cover the local path, failure when a confining policy lacks a provider, and runner-failure diagnostics taking precedence over ripgrep's exit-1 empty-search result. A native macOS research regression checks that `grep` and `glob` cannot expose a denied A directory while B remains searchable. The ordinary sandbox policy controls filesystem write modes, not an A/B read partition; source isolation additionally needs a source-aware provider, complete input-channel inventory, and a full-enforcement check before any provenance guarantee. The current search result does not report the provider's partial-enforcement fact.

# DSH Context Map project identity

English | [中文](2026-09-07-dsh-context-map-project-identity-design.zh.md)

## Purpose

DSH Context Map is an independently maintained community project built on DeepSeek Harness. Its public repository, documentation, and product chrome identify DSH Context Map as the product while crediting DeepSeek Harness as the underlying agent runtime. The project does not imply sponsorship, ownership, or maintenance by DeepSeek AI.

## Public identity

The repository is published as `haichangcharles/dsh-context-map` with the title **DSH Context Map** and a description centered on visual, controllable conversation context. The repository topics include `dsh-plugin`, `deepseek-harness`, `context-management`, and `conversation-visualization` so the project remains discoverable in the Harness ecosystem.

The root README leads with the independent product, its user value, screenshots or walkthrough entry points, installation from this repository, and an explicit attribution notice. The original Harness documentation remains available through links and the retained architecture documents rather than presenting the repository as the official DeepSeek distribution.

The Web UI uses the DSH Context Map name in the browser title, application wordmark, PWA manifest, and other product-level labels. Provider names, DeepSeek model names, upstream package names, protocol identifiers, environment variables, and factual descriptions of the underlying runtime retain their existing names.

## Compatibility boundary

The current release supports DeepSeek Harness as the sole Context Map host runtime. Contextify extends documented plugin, compiler, Session, Remote, and client-slot mechanisms; it does not introduce a second agent loop or call model providers from the Web UI. Future work will add separate Context Map host-runtime adapters for Claude Code and the OpenAI Agents SDK, then apply the same interaction model to open-source agents such as OpenCode; those adapters are roadmap items, not capabilities of this release.

Existing `@deepseek-ai/*` workspace package names remain unchanged unless the project later publishes independently scoped packages. Preserving those internal names minimizes merge conflicts, keeps the upstream module graph intact, and distinguishes product branding from dependency identity.

Brand-specific changes are concentrated in project-owned entry points and a small community-brand plugin. Upstream implementation files are not mechanically renamed. A short machine-searchable attribution marker makes accidental removal visible during review.

## Repository topology

The independent GitHub repository is the local `origin`. The official `deepseek-ai/deepseek-harness` repository remains the read-only `upstream`. The former GitHub fork can remain as a historical mirror or be archived after the independent repository is verified; it is not the product's canonical URL.

The default branch carries released DSH Context Map code. Product work uses `codex/*` feature branches. Stable releases use `dsh-context-map-vX.Y.Z` tags so product versions cannot be confused with upstream Harness release tags.

## Upstream update workflow

For each upstream release, fetch `upstream`, create `codex/sync-deepseek-<version>` from the current DSH Context Map default branch, and merge the exact upstream tag or reviewed commit. Resolve conflicts only at the smallest owning integration points, then verify Contextify package tests, Web UI behavior, type checking, the production build, and documentation links before merging the synchronization branch.

Do not develop product features inside an upstream synchronization branch. If an upstream change replaces an extension point used by Contextify, adapt the plugin to the new documented mechanism instead of preserving an obsolete copy of upstream core code.

The expected conflict area is limited to Contextify packages, Web bundle composition, client slots used by the right panel and message actions, and product-brand entry points. Changes outside those areas require review because they increase the long-term fork surface.

## Release checks

A release verifies that the GitHub name, description, topics, default branch, README links, clone commands, browser title, PWA name, and visible wordmark all identify DSH Context Map. It also verifies that attribution links point to the official DeepSeek Harness repository and that `origin` and `upstream` resolve to their intended repositories.

The release build must pass the focused Contextify suite, Web UI regressions for the Context Map, repository type checking, production build, documentation synchronization, and `git diff --check`. No branding change may alter Session persistence, Context Compiler behavior, model routing, or the Harness agent loop.

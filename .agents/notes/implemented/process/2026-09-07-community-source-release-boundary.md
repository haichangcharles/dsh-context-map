# Agent Note: Community source release boundary

Status: implemented

English | [中文](2026-09-07-community-source-release-boundary.zh.md)

## Problem

DSH Context Map is maintained in an independent public repository while retaining the DeepSeek Harness workspace and package graph. The inherited repository contains organization-specific runners, Project automation, registry publication jobs, and upstream package identities. Running those paths here would either fail for reasons unrelated to the product or create a route for publishing packages whose namespace and release process this project does not own.

The project still needs evidence that its changes remain compatible with the complete inherited build. Removing every packaging workflow would hide dependency, payload, and installed-artifact regressions that can also break source users.

## Decision

DSH Context Map distributes immutable source through GitHub Releases using product-prefixed `dsh-context-map-vX.Y.Z` tags. A release tag points at the exact commit that passed the community checks. The supported build input is a Git checkout at that exact tag so the official build can record authentic commit provenance. GitHub's automatically generated source archives are reference snapshots rather than direct build inputs because they omit `.git`; a deliberate archive build must provide `DSH_CLIENT_COMMIT_HASH` equal to the full release commit SHA. Release notes identify DeepSeek Harness as the only currently supported Context Map host runtime and describe host-runtime adapters for Claude Code and the OpenAI Agents SDK, followed by adoption in OpenCode, as roadmap targets rather than available integrations. Inherited Claude Code subagent and hook interoperability inside DeepSeek Harness remains distinct from that roadmap.

Inherited dsh, vendor, Landlock Run, and Python release workflows are compatibility workflows only. They may build, pack, install, inspect, and retain short-lived GitHub artifacts, but contain no npm or PyPI publication job, registry credential, or publication OIDC permission. Internal `@deepseek-ai/*` names remain unchanged because they are part of the inherited workspace graph, not a claim that this repository owns the upstream package namespace.

Registry publication utilities remain in the source tree as explicitly named `upstream:*` maintenance references so future upstream synchronizations can compare the complete inherited tooling. No supported community workflow or release instruction invokes them, and they are outside the DSH Context Map distribution contract.

Community CI runs on GitHub-hosted runners for pull requests and `master` pushes. It executes the workflow contract regression together with type checking, linting, workspace constraints, GUI tests, and focused runtime tests. The inherited private-runner matrix remains manual engineering reference material. Real-provider checks remain manual and require explicitly configured secrets; focused keyless real-kernel sandbox proofs run separately on `master` pushes. The GitLab configuration is an opt-in manual build reference and contains no package upload stage.

DeepSeek organization Project automation is absent. Issues and pull requests use ordinary repository features without a GitHub App or organization Project dependency. Documentation deployment uses this repository's GitHub Pages configuration, source links, edit links, product name, and visual identity.

## Alternatives considered

**Keep protected manual registry publishers in CI.** Environment approval and tag checks reduce accidental execution, but the independent project still does not own the upstream npm or PyPI release identities. A dormant CI credential path would contradict a source-only release and expand the consequences of a workflow mistake.

**Delete all inherited package workflows.** This removes the publication risk but also removes useful evidence that the fork still produces installable upstream-shaped artifacts. Credential-free compatibility rehearsals retain that evidence without presenting the artifacts as supported registry releases.

**Rename every inherited package into a project-owned scope before release.** A new namespace could support package distribution later, but a repository-wide rename would expand the maintained fork surface and make upstream merges substantially harder. Package distribution needs a separate versioning, migration, and ownership decision.

**Treat uploaded CI artifacts or GitHub's automatic source archives as the direct build product.** Short-lived CI artifacts are diagnostic evidence and may use inherited package identities. Automatic source archives omit Git metadata required for authentic build provenance. The supported distribution is a Git checkout at the tagged source commit; neither artifact type is presented as a stable direct-build installation channel.

## Consequences

Users install DSH Context Map from this repository's Git checkout instructions, preferably at an immutable release tag. Release notes publish the exact commit SHA so an advanced user can explicitly supply it as `DSH_CLIENT_COMMIT_HASH` when building an automatic source archive. The project makes no claim that an npm or PyPI package with an inherited name contains this distribution. Compatibility jobs can detect packaging regressions, but their artifacts expire and are not a supported release channel.

Publishing packages later requires a new decision that establishes a project-owned namespace, versions, migration path, credentials, and registry policy. Until then, workflow contract tests reject reintroduced publication jobs and secrets, and required Community CI executes those tests on every supported change.

# DSH Context Map community release readiness

English | [中文](2026-09-07-community-release-readiness-design.zh.md)

## Goal

Make the independent DSH Context Map repository truthful and release-ready. Public documentation must distinguish current support from future runtime integrations, and every automatically triggered GitHub workflow must prove a property this community repository can actually support.

## Product positioning

DeepSeek Harness is the only Context Map host runtime implemented and supported by this release. The roadmap may name future Context Map host-runtime adapters for Claude Code and the OpenAI Agents SDK, followed by adoption in open-source Agent products such as OpenCode, but it must not claim those integrations exist today. Inherited Claude Code subagent and hook interoperability inside DeepSeek Harness is not the same as a Context Map host-runtime adapter.

Context Map's durable graph, selection revisions, Archive placeholders, recommendation contracts, and UI remain application-owned. A future adapter would translate another runtime's native sessions, messages, branches, and lifecycle events into this stable model. This release does not add a second agent loop.

## Runtime retry contract

A Context compilation is frozen for one request attempt and is reused for ordinary provider retries. Recovery middleware can commit a Session surface replacement between attempts, most notably during compaction. The Agent Loop therefore records `session.surface.replaceGeneration` beside the compilation and recompiles only when a retry observes a different generation. This preserves retry determinism while preventing a stale pre-compaction compilation from failing reconstruction before the next adapter request.

Loader fixtures that mount Agent Loop must also mount the required Context Compiler service. The production bundle already does this; the retry composition fixture did not.

## CI and release policy

- Community CI runs on standard GitHub-hosted runners for pull requests and `master` pushes. It owns type checking, linting, GUI tests, and focused runtime regressions.
- The inherited upstream CI remains available only as a manual engineering reference because it requires DeepSeek's private and larger runner pools.
- Every inherited package workflow is a credential-free compatibility check. The dsh, vendor, Landlock Run, and Python workflows can build and validate upstream-shaped artifacts, but retain no npm or PyPI publication path. The three Context Map packages align with the inherited dsh release family while pointing their source metadata at this repository.
- Real-provider E2E is manual until the repository intentionally owns a suitable secret. A requested run still fails loudly if the secret is absent.
- Sandbox CI proves kernel confinement only. The macOS leg runs focused Seatbelt E2E rather than duplicating the entire unit suite.
- GitHub Pages uses GitHub Actions as its build source. The documentation workflow remains responsible for verification and deployment.
- DeepSeek's organization-specific Issue Project automation is removed. This repository accepts ordinary GitHub Issues and pull requests without depending on an unavailable GitHub App or organization Project.

## Publication boundary

This repository publishes a GitHub source release, not the inherited npm or PyPI package families. The release tag must point at the verified current commit, while historical tags remain unchanged. The supported build input is a Git checkout at that tag. GitHub's automatic source archives are reference snapshots because they omit `.git`; an intentional archive build must set `DSH_CLIENT_COMMIT_HASH` to the release commit. Release notes disclose that DeepSeek Harness is the current runtime and that external runtime adapters remain roadmap work.

## Verification

Local evidence must include the retry regressions, Loader composition, workspace constraints, release-family verification, GUI tests, type checking, production build, bilingual documentation checks, and clean diffs. After pushing, Community CI, package compatibility, Sandbox, and documentation deployment must be inspected on the exact commit. Real-provider E2E must not run automatically.

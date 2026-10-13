# Agent Note: CI without upstream account dependencies

Status: implemented

English | [中文](2026-10-13-portable-ci-integrations.zh.md)

## Problem

A fork can build successfully but fail optional publication or Project automation because it has neither the upstream account credentials nor its organization runner pools. Queueing every required worker on an unavailable custom runner prevents the repository from producing a CI verdict. Missing integration configuration is distinct from a failing product or test.

## Decision

[Required PR CI](../../../../.github/workflows/ci.yml) uses standard hosted Linux and Windows runners by default, with bounded worker and coverage partition counts. `DSH_CI_LINUX_RUNNER` and `DSH_CI_WINDOWS_RUNNER` select configured larger pools; explicit failover retains the existing self-hosted routing. Master standby jobs run only for configured failover pools. Every required PR build, coverage, snapshot, benchmark, and native-platform check remains present. [The API budget policy](../testing/2026-10-13-explicit-ci-api-budget.md) independently prevents automatic model spending.

[Preview CI](../../../../.github/workflows/build-preview-cloudflare.yml) builds and retains an artifact for every PR. Cloudflare upload, protected-image verification, and URL comments require a trusted same-repository PR plus all deployment and Access credentials. An unconfigured repository reports artifact-only mode; a partial deployment setup fails visibly. No hosted preview is claimed for an artifact-only run.

[Issue lifecycle](../../../../.github/workflows/issue-lifecycle.yml) and [Issue policy](../../../../.github/workflows/issue-policy.yml) always test the trusted policy implementation. Live Project operations require the configured organization/repository to match the triggering repository and a complete GitHub App configuration. App tokens target the current repository instead of a hardcoded upstream installation. Unconfigured forks explicitly report that no board policy or mutation was executed; partial applicable configuration fails. The existing human-PR and changes-requested gates remain enforced.

## Alternatives considered

**Skip all fork CI.** Product defects would lose their build, browser, package, and platform evidence. Only optional account-dependent actions require configuration; local tests and required CI remain active.

**Copy upstream secrets or mutate its Project.** A fork has no authority to reuse that installation or account. Repository matching and explicit configuration keep external operations within their intended owner.

**Use upstream custom runner labels unconditionally.** Labels do not provision a pool for another account, and queued jobs never produce a verdict. Standard runners give forks an executable default while configured pools retain their higher concurrency.

## Consequences

Local policy tests do not prove that an organization Project was read or updated, and preview artifacts do not prove a deployment. Workflow summaries state those limits. [Configuration tests](../../../../scripts/fork-ci-options.spec.ts) execute credential-presence decisions without real credentials, preserve failure for partial setup, and verify hosted and custom runner routing. Real integration permission errors still fail once an integration is explicitly configured.

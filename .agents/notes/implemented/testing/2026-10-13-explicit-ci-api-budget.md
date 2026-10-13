# Agent Note: Explicit CI model API budgets

Status: implemented

English | [中文](2026-10-13-explicit-ci-api-budget.zh.md)

## Problem

Automatic model API validation spends money on every eligible PR or push. Installed-wheel CI can consume the same credential through a reusable workflow, so guarding only the main e2e job leaves an automatic spending path. Fixed Ubuntu package archive URLs also expire when an old bubblewrap revision is removed, blocking preparation before any tests run.

## Decision

[The E2E workflow](../../../../.github/workflows/e2e.yml) runs full Context Map builds, recorded Session replay, and browser replay without model credentials for ordinary PRs and pushes. Paid profile and installed-wheel tests require `workflow_dispatch` and the default-false `real_api` input. The [reusable runtime builder](../../../../.github/workflows/build-exe-for-python-sdk.yml) independently checks both values before any secret-bearing step. Automatic PR, master, and release callers retain native artifact and keyless black-box coverage without passing the model secret. Provider-specific and E2B workflows remain manual-only. This reverses the automatic spending policy in the [real-API CI decision](2026-06-19-real-api-e2e-ci.md), while preserving its preflight and credential isolation.

[Bubblewrap preparation](../../../../scripts/prepare-ci-bubblewrap.sh) downloads the current distribution package using authenticated APT indices into a private runner directory, extracts it without a system package transaction, and publishes its binary only after a functional confinement probe. Private index directories avoid locks shared by simultaneous jobs; update hooks are cleared with the [documented APT directive](https://manpages.ubuntu.com/manpages/jammy/man5/apt.conf.5.html) so index acquisition does not write global caches. Runner cleanup owns the extracted binary; script cleanup removes acquisition metadata.

## Alternatives considered

**Cancel each paid run after push.** Cancellation races setup and model execution and requires continuous monitoring. The trigger and credential guards prevent automatic model calls before they start.

**Remove the e2e check or skip every integration test.** That discards product coverage. Keyless recorded execution, browser replay, and native installed-wheel checks remain automatic; real model validation remains available when explicitly authorized.

**Pin another archive URL or install globally with APT.** A newer fixed URL has the same expiry failure. A global package transaction adds shared locks and installation hooks; authenticated current indices plus private extraction retain package verification without those changes.

## Consequences

Ordinary CI does not prove current external model quality. Explicit live runs still fail on missing credentials, and their logs never print the key. [Workflow budget tests](../../../../scripts/ci-api-budget.spec.ts) exercise automatic-event and opt-in conditions, include negative controls, and inspect the complete workflow corpus. [Preparation tests](../../../../scripts/prepare-ci-bubblewrap.spec.ts) exercise failure, cleanup, and concurrent process allocation with command fixtures; the Linux CI probe remains the authority on real kernel confinement.

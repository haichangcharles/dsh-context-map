# Agent Note: Real-API e2e in CI against the external DeepSeek API

Status: implemented

English | [中文](2026-06-19-real-api-e2e-ci.zh.md)

## Problem

Keyless replay cannot establish live provider behavior. The [ACP inject postmortem](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md) illustrates a product failure missed by unit tests. A live suite drives shipped profiles through model calls, tool execution, multi-turn conversations, resume, and cancellation, while credential-free contributors need independent coverage.

## Decision

The explicit live job in [e2e.yml](../../../../.github/workflows/e2e.yml) runs `test:e2e` against the external DeepSeek API on Node 24 after the artifact build. The [CI budget decision](2026-10-13-explicit-ci-api-budget.md) owns triggers and reverses automatic model spending; ordinary events run recorded Session and browser replay. Live validation has a bounded worker pool, retries, and timeout, and preflight rejects an empty credential instead of accepting an all-skipped suite. The [cancellation policy](../process/2026-09-09-cancel-superseded-ci.md) cancels superseded validation on the same workflow/ref.

### Credential isolation

The repository secret `DEEPSEEK_API_KEY_EXTERNAL` maps to `DEEPSEEK_API_KEY` only in preflight and live test steps. Checkout, setup, installation, and ordinary CI do not receive it. `contents: read` limits token permissions, and `DEEPSEEK_BASE_URL=https://api.deepseek.com` pins the tested provider. Preflight prints only credential presence, never its value or length.

### Trust

Never run untrusted PR code with base-repository secrets through `pull_request_target`. Manual dispatch explicitly selects and authorizes a repository ref; write-access users can alter workflows and remain inside the secret trust set. Public repository visibility does not authorize automatic credential exposure. Secret handling, repository write access, and any environment reviewer controls remain operational responsibilities.

## Alternatives considered

**Run the live suite without preflight.** A missing secret makes suites self-skip, so a green result would conceal missing coverage.

**Expose credentials during installation or ordinary keyless CI.** Dependency hooks and every automatic run would receive a capability they do not need. Step-local credentials and explicit live dispatch keep the scopes separate.

## Consequences

Model-quality evidence requires an authorized live run; ordinary CI validates saved execution and product behavior. The credential has one repository-owned mapping, and secret misconfiguration fails visibly. The automatic-trigger policy is independently maintained in the budget decision so credential hygiene does not imply permission to spend.

# DeepSeek rc.8 Upstream Sync Implementation Plan

[English](2026-08-21-deepseek-rc8-sync.md) | 中文

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve DSH Context Map v0.1.0 and integrate DeepSeek Harness `dsh-v0.1.0-rc.8` without changing the published rollback point.

**Architecture:** The immutable `dsh-context-map-v0.1.0` tag points at the verified Contextify product commit. The `codex/sync-deepseek-rc8` branch merges `upstream/master`, resolves conflicts by preserving upstream Harness contracts and reapplying Contextify through its adapters, then passes native and Contextify regression checks before it can be promoted.

**Tech Stack:** Git merge workflow, pnpm 11, Node.js 24, TypeScript, Vitest, Vite web client.

---

### Task 1: Verify the rollback point and isolated branch

**Files:**
- Verify: Git refs only

- [ ] **Step 1: Verify the local and remote release tag**

Run:

```bash
git rev-parse dsh-context-map-v0.1.0^{}
git ls-remote --tags origin refs/tags/dsh-context-map-v0.1.0^{}
```

Expected: both commands resolve to `85d35be1bc07f21ee44e46c8e2e7e353d8d9a1d8`.

- [ ] **Step 2: Verify the sync branch starts from the release commit**

Run:

```bash
git branch --show-current
git rev-parse HEAD
```

Expected: branch `codex/sync-deepseek-rc8`, commit `85d35be1bc07f21ee44e46c8e2e7e353d8d9a1d8`.

### Task 2: Merge the official rc.8 line

**Files:**
- Modify: files reported by `git diff --name-only --diff-filter=U`
- Preserve: `packages/context/contextify/**`
- Preserve: Context Map additions under `packages/client/**` and `packages/host/**`

- [ ] **Step 1: Refresh the official branch and verify its release**

Run:

```bash
git fetch upstream master --tags
git describe --tags --exact-match upstream/master
```

Expected: `dsh-v0.1.0-rc.8`.

- [ ] **Step 2: Start a merge commit without committing**

Run:

```bash
git merge --no-ff --no-commit upstream/master
```

Expected: either a clean staged merge or explicit conflict paths; the v0.1.0 tag and original worktree remain unchanged.

- [ ] **Step 3: Record the complete conflict inventory**

Run:

```bash
git diff --name-only --diff-filter=U
```

Expected: every unresolved path is listed once. Known translation-paired conflicts include `packages/client/ui-workspace/README.md`, `packages/client/ui-trajectory/README.md`, `packages/client/ui-conversation/README.md`, `docs/persistence-catalog.md`, and `docs/event-producer-consumer.md`.

### Task 3: Resolve source conflicts by ownership

**Files:**
- Modify: conflicted source paths reported by Task 2
- Verify: `packages/context/contextify/**`
- Verify: `packages/core/session/**`
- Verify: `packages/host/**`
- Verify: `packages/client/**`

- [ ] **Step 1: Resolve official Harness contracts first**

For each conflicted source file, inspect all three versions:

```bash
git show :1:<path>
git show :2:<path>
git show :3:<path>
```

Expected resolution: retain the rc.8 API and lifecycle behavior, then adapt Contextify call sites to that behavior. Do not resolve a source file with whole-file `--ours` or `--theirs`.

- [ ] **Step 2: Preserve the Contextify product behaviors**

For every resolved Session, Host, or client conflict, confirm the resulting source still provides:

```text
beforeSeq native fork support
Contextify Q&A move after branch acceptance
single-node archive placeholders
Context compiler include/exclude state
Context Map and native details sidebar switching
fast/deep recommendation modes
explicit request_context_branch tool routing
```

Expected: each behavior still has its implementation and existing focused test.

- [ ] **Step 3: Stage every resolved source file**

Run:

```bash
git add <resolved-source-paths>
git diff --name-only --diff-filter=U
```

Expected: only documentation or generated-file conflicts remain.

### Task 4: Resolve paired and generated documentation

**Files:**
- Modify: `packages/client/ui-workspace/README.md`
- Modify: `packages/client/ui-trajectory/README.md`
- Modify: `packages/client/ui-conversation/README.md`
- Modify: `docs/persistence-catalog.md`
- Modify: `docs/event-producer-consumer.md`
- Modify: translation counterparts reported by the pairing resolver

- [ ] **Step 1: Resolve owner documents semantically**

Retain rc.8 descriptions of native behavior and the Contextify sections describing shipped extensions. Remove conflict markers and stage each owner document.

- [ ] **Step 2: Resolve safe translation-pair records**

Run:

```bash
pnpm run resolve-translation-pairing-conflicts
```

Expected: safe pairing metadata and generated counterparts resolve automatically; the command identifies any owner document that still requires manual review.

- [ ] **Step 3: Confirm each changed pair**

Run once per reported pair:

```bash
pnpm run verify-translation-pairing --write <pair>
```

Expected: all paired documents are recorded against their resolved English owners.

- [ ] **Step 4: Verify there are no unresolved conflicts**

Run:

```bash
git diff --name-only --diff-filter=U
git diff --check
```

Expected: no unresolved paths and no whitespace errors.

### Task 5: Verify native and Contextify behavior

**Files:**
- Test: existing tests changed by the merge
- Test: `packages/context/contextify/**/tests/**`
- Test: Context Map tests under `packages/client/**/tests/**`
- Test: Contextify Host tests under `packages/host/**/tests/**`

- [ ] **Step 1: Install the rc.8 dependency graph**

Run:

```bash
pnpm install --frozen-lockfile
```

Expected: installation succeeds with the repository-declared pnpm version and no lockfile mutation.

- [ ] **Step 2: Run type checking**

Run:

```bash
pnpm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run Contextify and affected focused tests**

Run the test files selected from the merge diff plus every Contextify test file:

```bash
pnpm exec vitest run <affected-test-files> <contextify-test-files>
```

Expected: all selected tests pass; no test is removed solely to make the merge pass.

- [ ] **Step 4: Build the product**

Run:

```bash
pnpm run build
```

Expected: host, client, and web builds exit 0.

- [ ] **Step 5: Run documentation synchronization checks**

Run:

```bash
pnpm run doc-sync
```

Expected: generated catalogs, links, translation records, and documentation budgets pass.

- [ ] **Step 6: Run browser acceptance on an isolated port**

Start the merged build on a port other than 3080 and verify ordinary chat, native Branch, Context Map opening, Include/Exclude, recommended Branch acceptance, and native details sidebar switching.

Expected: the existing 3080 product remains available while the rc.8 candidate completes the acceptance flow without browser console or transport errors.

### Task 6: Commit and publish the candidate branch

**Files:**
- Modify: merge resolution produced by Tasks 2–5
- Add: `docs/superpowers/plans/2026-08-21-deepseek-rc8-sync.md`

- [ ] **Step 1: Review the final merge**

Run:

```bash
git status --short
git diff --cached --stat
git diff --cached --check
```

Expected: only intentional rc.8 integration and Contextify compatibility changes are staged.

- [ ] **Step 2: Create the merge commit**

Run:

```bash
git commit -m "merge: adapt DSH Context Map to DeepSeek rc.8"
```

Expected: one merge commit with both the Contextify release line and `upstream/master` as parents.

- [ ] **Step 3: Push the candidate without promoting it**

Run:

```bash
git push -u origin codex/sync-deepseek-rc8
```

Expected: the candidate branch is visible on GitHub; `codex/contextify-harness`, the v0.1.0 tag, and the running 3080 build remain unchanged.

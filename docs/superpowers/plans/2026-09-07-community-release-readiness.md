# DSH Context Map Community Release Readiness Implementation Plan

English | [中文](2026-09-07-community-release-readiness.zh.md)

**Goal:** Publish a truthful GitHub source release and replace inherited infrastructure failures with relevant community checks.

**Architecture:** Keep DeepSeek Harness as the sole current runtime. Preserve one compilation across ordinary request retries, invalidate it only after a committed Session surface replacement, and keep community-specific workflow changes separate from upstream runtime behavior.

**Tech Stack:** TypeScript, Cordis Loader, Vitest, GitHub Actions, GitHub Pages, Markdown

## Task 1: Repair request retry compilation

- [ ] Record the failing compaction and Loader tests before implementation.
- [ ] Store the Context compilation and its `replaceGeneration` before the request loop.
- [ ] On a retry action, recompile only when the current surface generation differs.
- [ ] Mount Context Compiler in the synthetic Loader fixture.
- [ ] Run the compaction, Loader, and ordinary provider-retry regression tests together; expect 12 passing tests.

## Task 2: Align community package compatibility

- [ ] Set the three Context Map package versions to `0.1.0-rc.8`.
- [ ] Point their repository metadata at `haichangcharles/dsh-context-map` and teach workspace constraints that these three packages are community-owned.
- [ ] Convert the inherited dsh, vendor, Landlock Run, and Python release workflows into credential-free compatibility checks with no npm or PyPI publishing path.
- [ ] Run workspace constraints and `release:verify --family dsh`.

## Task 3: Replace unavailable CI infrastructure

- [ ] Make inherited CI manual-only because its custom runner pools are unavailable here.
- [ ] Add Community CI on `ubuntu-latest` for type checking, linting, GUI tests, and focused runtime regressions.
- [ ] Keep real-provider E2E manual and strict about its optional secret.
- [ ] Keep Sandbox focused on real kernel-confinement E2E.
- [ ] Remove the inherited organization Project and GitHub App Issue automation.

## Task 4: Publish truthful documentation

- [ ] Add current Runtime support and future adapter Roadmap sections to both READMEs.
- [ ] Mention Claude Code, OpenAI Agents SDK, and OpenCode only as future work.
- [ ] Rebrand the documentation site, source links, edit links, and contribution guide for the independent repository.
- [ ] Record and verify every changed bilingual pair.

## Task 5: Enable and verify GitHub Pages

- [ ] Configure the repository's Pages build type as `workflow`.
- [ ] Run documentation synchronization and the production VitePress build locally.
- [ ] Inspect the remote documentation workflow on the exact pushed commit.

## Task 6: Verify and publish

- [ ] Run targeted regressions, Community CI commands, workspace constraints, release verification, GUI tests, type checking, production build, documentation checks, and `git diff --check`.
- [ ] Commit and push the exact verified tree to `master`.
- [ ] Cancel obsolete queued workflows that still wait for unavailable upstream runners.
- [ ] Inspect every automatically triggered workflow; real-provider E2E must remain untriggered.
- [ ] Create a new immutable GitHub source tag and Release from the verified commit, without moving the historical tag; document the tagged Git checkout as the supported build and publish the full SHA for deliberate automatic-archive builds.

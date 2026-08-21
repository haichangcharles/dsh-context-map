# Context Map Walkthrough Seeding Implementation Plan

[English](2026-08-20-context-map-walkthrough-seeding.md) | 中文

**Goal:** Seed a disposable native Harness session tree that demonstrates the shipped Context Map behavior without adding demo-only product UI or mocked agent output.

**Architecture:** A one-shot TypeScript seeder uses `SessionStore` plus the JSONL persistence plugin against the active `$DSH_HOME`. It creates one root session, two forks from the same root boundary, and one child fork from a branch-owned boundary. Every conversation turn is represented by native `turn/start`, `user/message`, `step/start`, `assistant/message`, `step/end`, and `turn/end` events, so the existing Host, Session list, chat, trajectory, and Context Map all consume exactly the same data.

**Tech Stack:** TypeScript, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-session-persistence-jsonl`.

---

### Task 1: Build the disposable native seeder

**Files:**
- Create temporarily: `scripts/seed-context-map-walkthrough.ts`

1. Define stable IDs for the root, archive/context-diff sibling, sibling-branch session, and branch-owned child.
2. Open the active JSONL session root and refuse to run if any stable ID already exists.
3. Append completed native turns with explicit titles. Include one intermediate assistant step before the final output so the map can prove that it only renders the final output.
4. Fork sessions through `SessionStore.fork`: branches 01 and 02 use the same root boundary; branch 03 uses the final boundary created inside branch 02.
5. Flush all four sessions and dispose the seeding context.

### Task 2: Seed and reload the running Host

1. Stop the local Host cleanly so it cannot hold a stale persistence catalog.
2. Run the seeder once against `/Users/haichangli/.dsh/sessions` with session cwd `/Users/haichangli/Documents`.
3. Remove the temporary seeder after successful persistence.
4. Restart the existing development command at `http://127.0.0.1:3080/`.

### Task 3: Verify native behavior

1. Call `session.list` and assert the four titles, parent IDs, and cwd.
2. Call `session.history` and assert completed turns contain the expected user input and final assistant output.
3. Verify in the UI that the root session is visible in the Documents workspace and its children render as sibling/sibling/child.
4. Open Context Map and verify that intermediate assistant output is absent, node controls are interactive, and Locate reaches chat.
5. Confirm the repository has no temporary product-code change; only this plan remains as an auditable repository artifact.

# DSH Context Map

English | [中文](README.zh.md)

[Product homepage](https://haichangcharles.github.io/dsh-context-map/) · [Interactive sample](https://haichangcharles.github.io/dsh-context-map/#demo)

DSH Context Map is an independently maintained long-horizon Chat workspace built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It turns native Harness Session forks into an inspectable map where people can navigate branches and choose which earlier messages and supported evidence enter each next model request.

**Independent community project.** DSH Context Map is maintained by [haichangcharles](https://github.com/haichangcharles). It is not an official DeepSeek product and is not maintained or endorsed by DeepSeek AI.

## What it adds

- **Context Map** — view a connected family of native Harness Sessions as a message-level tree beside Chat.
- **Explicit context control** — include or exclude individual user inputs and final assistant outputs without changing the underlying Session log.
- **Context Steward** — start with zero-model Local advice, explicitly request bounded Fast or isolated Deep review, and confirm source, destination and lifecycle proposals before they change state.
- **Cross-turn reuse** — bring a source from another branch into the active Session, stop using it for a later turn, and bring it back without deleting its origin.
- **Personal Context advice** — use Client-confirmed Include/Exclude and Keep-current choices as bounded examples for later review; recommendations never change the Plan before confirmation.
- **Branch review** — receive a lightweight suggestion when a completed Q&A is better moved to a parallel native Session branch.
- **Per-node Archive** — hide obsolete message semantics behind a deterministic placeholder while retaining the graph node, edges, original event, and restore path.
- **Prompt Dashboard** — append profile-specific rules or explicitly unlock full prompt overrides for Context, Archive, and Branch reviewers.
- **Native Harness compatibility** — use the existing DeepSeek Harness agent loop, tools, model routing, Session persistence, forks, compiler hooks, and Web UI slots.

Context Map stores one node for the initial user input and one node for the final visible assistant output of each successful Turn. Supported Web results and worker reports appear as evidence nodes. Reasoning, intermediate assistant steps, incomplete output, and other runtime events stay out of the chat-node view.

## Context changes across turns

In a long conversation, a source can be useful for one request and distracting for the next. The active Session owns a durable Context Plan: **Natural** uses its own historical messages, **Exclude** skips one of them, and **Include** brings a supported source from another branch into the next request. An off-path source set back to Natural stays in its original branch and becomes inactive in this request; it is not deleted or archived. The user can Include it again at a later turn. An Agent can suggest these edits on the review sheet, but the Plan changes only after confirmation. An earlier Agent-suggested temporary Exclude can likewise be proposed for restoration; a direct user Exclude remains protected.

For example, a planning branch may hold a supplier's six-week lead time. While editing launch-page copy, that source stays inactive. When scheduling starts, the user can Include it from the Map; a later copy-review turn can return it to Natural, and another scheduling turn can Include it again. The [native service regression](packages/context/contextify/tests/service.spec.ts) checks that these three edits change the compiled messages across successive turns while the original branch remains intact.

<a id="run"></a>
## Run

<a id="run-from-source"></a>
### Run from source

The Context Steward preview is on `codex/context-steward-runtime` ([PR #24](https://github.com/haichangcharles/dsh-context-map/pull/24)). The commands below check out that branch.

Install Node.js 22.19 or newer in the 22.x line, or Node.js 24 or newer, and pnpm 11.7.0 (the version pinned in `package.json`), then run:

On macOS and Linux, the source build also needs a C11 compiler available as `cc` and a Node installation that includes development headers.

```sh
git clone --branch codex/context-steward-runtime --single-branch https://github.com/haichangcharles/dsh-context-map.git
cd dsh-context-map
pnpm install
pnpm run build
pnpm dsh web
```

The Web UI starts at `http://127.0.0.1:3080` by default. Runtime credentials use the same configuration mechanisms as DeepSeek Harness; never commit provider keys to this repository.

## Architecture and upstream

### Current runtime support

DeepSeek Harness is the only Context Map host runtime implemented and supported by the current release. Contextify owns the durable message graph and Context Compiler behavior, while the Web plugin owns visualization and interaction. The application does not introduce another agent loop or call model providers directly from the browser.

<a id="existing-session-data"></a>
### Existing Session data

The official migration chain does not accept the fork’s format-v0 `context/compiler*` and `contextify/*` events. Later format migrations also renumber events, so accepting these records without migrating every cross-Session reference would be unsafe. Keep existing Context Map data on the previous runtime until a family-aware migration is available; validate this upgrade with an isolated configuration and Session directory. This branch does not modify existing data directories.

The internal `@deepseek-ai/*` package names are retained for compatibility with the upstream workspace and module graph. They identify the runtime packages from which this project is derived; they do not make DSH Context Map an official DeepSeek distribution.

Use these remotes in a development checkout:

```sh
git remote -v
# origin    https://github.com/haichangcharles/dsh-context-map.git
# upstream  https://github.com/deepseek-ai/deepseek-harness.git
```

This synchronization targets upstream `aa8262ec091698bae9a6b04773a6b5b06ad4aef2` (2026-09-10, package version `0.1.5-rc.1`), replacing the `0.1.0-rc.8` base. Future updates should merge a reviewed tag or commit on a dedicated branch:

```sh
git fetch upstream --tags
git switch -c codex/sync-dsh-2026-09-10 master
git merge --no-ff aa8262ec091698bae9a6b04773a6b5b06ad4aef2
pnpm run typecheck
pnpm run build
pnpm run doc-sync
```

Resolve conflicts at the smallest Contextify integration points and keep product feature work out of synchronization branches. The detailed maintenance contract is in [the project identity design](docs/plans/2026-09-07-dsh-context-map-project-identity-design.md).

## Context Steward guide

Follow the [long-conversation guide](docs/user/guide/context-steward.md) for source selection, explicit draft navigation, branch lifecycle, preference inspection and zero-API verification. Local review is the default; automatic post-turn Branch classification is opt-in. The included 30-turn replay exports prefix-only scorer packets and separate constructed expectations. It verifies engineering behavior and does not establish human personalization gains or model accuracy.

## Development

Start with the [DeepSeek Harness architecture documentation](docs/architecture.md), the [Contextify package](packages/context/contextify/README.md), and the [Context Map UI package](packages/client/ui-contextify/README.md). Repository contributors must follow [AGENTS.md](AGENTS.md).

Useful checks:

```sh
pnpm run test:gui
pnpm run typecheck
pnpm run build
pnpm run doc-sync
```

## Ecosystem

This repository uses the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic recommended by the DeepSeek Harness contribution guide. Questions and issues about DSH Context Map belong in this repository; questions about the underlying runtime belong in the [official DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

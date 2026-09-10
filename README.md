# DSH Context Map

English | [中文](README.zh.md)

DSH Context Map is an independently maintained conversation-context workspace built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It turns native Harness Session forks into an inspectable map where people can navigate branches and control which completed user inputs and final assistant outputs enter the next model request.

**Independent community project.** DSH Context Map is maintained by [haichangcharles](https://github.com/haichangcharles). It is not an official DeepSeek product and is not maintained or endorsed by DeepSeek AI.

## What it adds

- **Context Map** — view a connected family of native Harness Sessions as a message-level tree beside Chat.
- **Explicit context control** — include or exclude individual user inputs and final assistant outputs without changing the underlying Session log.
- **Context review** — request a fast bounded recommendation or a deliberate deep review of a temporary complete-tree snapshot, inspect the proposed replacement, and apply or undo it as one revision.
- **Branch review** — receive a lightweight suggestion when a completed Q&A is better moved to a parallel native Session branch.
- **Per-node Archive** — hide obsolete message semantics behind a deterministic placeholder while retaining the graph node, edges, original event, and restore path.
- **Prompt Dashboard** — append profile-specific rules or explicitly unlock full prompt overrides for Context, Archive, and Branch reviewers.
- **Native Harness compatibility** — use the existing DeepSeek Harness agent loop, tools, model routing, Session persistence, forks, compiler hooks, and Web UI slots.

Context Map stores one node for the initial user input and one node for the final visible assistant output of each successful Turn. Reasoning, tool calls, tool results, context injections, intermediate assistant steps, and incomplete output stay out of the map.

<a id="run"></a>
## Run

<a id="run-from-source"></a>
### Run from source

Install a supported Node.js version and pnpm, then run:

```sh
git clone https://github.com/haichangcharles/dsh-context-map.git
cd dsh-context-map
pnpm install
pnpm run build
pnpm dsh web
```

The Web UI starts at `http://127.0.0.1:3080` by default. Runtime credentials use the same configuration mechanisms as DeepSeek Harness; never commit provider keys to this repository.

## Architecture and upstream

### Current runtime support

DeepSeek Harness is the only Context Map host runtime implemented and supported by the current release. Contextify owns the durable message graph and Context Compiler behavior, while the Web plugin owns visualization and interaction. The application does not introduce another agent loop or call model providers directly from the browser.

### Existing Session data

The official migration chain does not accept the fork’s format-v0 `context/compiler*` and `contextify/*` events. Later format migrations also renumber events, so accepting these records without migrating every cross-Session reference would be unsafe. Keep existing Context Map data on the previous runtime until a family-aware migration is available; validate this upgrade with an isolated configuration and Session directory. This branch does not modify existing data directories.

### Roadmap: portable context infrastructure

Future work will add Context Map host-runtime adapters for Claude Code and the OpenAI Agents SDK, then explore applying the same durable context mapping capability to open-source Agent products such as OpenCode. These adapters are roadmap items, not features of the current release. The Claude Code subagent and hook interoperability already inherited from DeepSeek Harness is a separate underlying Harness capability.

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

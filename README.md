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

## Run

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

DeepSeek Harness remains the sole agent runtime. Contextify owns the durable message graph and Context Compiler behavior, while the Web plugin owns visualization and interaction. The application does not introduce another agent loop or call model providers directly from the browser.

The internal `@deepseek-ai/*` package names are retained for compatibility with the upstream workspace and module graph. They identify the runtime packages from which this project is derived; they do not make DSH Context Map an official DeepSeek distribution.

Use these remotes in a development checkout:

```sh
git remote -v
# origin    https://github.com/haichangcharles/dsh-context-map.git
# upstream  https://github.com/deepseek-ai/deepseek-harness.git
```

For an upstream release, merge the reviewed tag or commit on a dedicated synchronization branch. This example shows the next release after the current `rc.8` base:

```sh
git fetch upstream --tags
git switch -c codex/sync-deepseek-rc9 master
git merge --no-ff dsh-v0.1.0-rc.9
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

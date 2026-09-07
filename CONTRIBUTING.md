# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for contributing to DSH Context Map. This is an independently maintained community project built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); it is not an official DeepSeek product.

## Where to report a problem

- Report Context Map bugs and request Context Map features in this repository's [Issues](https://github.com/haichangcharles/dsh-context-map/issues).
- Report defects in the underlying Harness runtime to the [official DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness/issues).
- For uncertain cases, open an issue here and describe the observed behavior. Maintainers can redirect it without requiring you to diagnose the owning layer first.

Include reproduction steps, the operating system and Node.js version, the expected behavior, and relevant logs or screenshots. Remove credentials, private conversation content, and other sensitive data before posting.

## Pull requests

Community pull requests are welcome. Before starting a substantial change, open an issue so the scope and compatibility impact can be discussed. Keep each pull request focused, preserve unrelated upstream-compatible code, and add or update tests and documentation for behavior changes.

Use `master` as the base branch. A typical validation sequence is:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:gui
pnpm run build
pnpm run doc-sync
```

Run the checks relevant to your change before opening a draft pull request, and report any check that cannot be run locally. Follow [AGENTS.md](AGENTS.md) for repository-specific architecture and development constraints. Never commit provider keys or copy secrets into issues, fixtures, or logs.

## Runtime boundary and roadmap

DeepSeek Harness is the only implemented and supported host runtime for Context Map today. Context Map host-runtime adapters for Claude Code and the OpenAI Agents SDK, followed by adoption in open-source Agent products such as OpenCode, are roadmap exploration areas rather than current compatibility claims or committed delivery dates. This does not remove the inherited Claude Code subagent and hook interoperability within DeepSeek Harness.

Proposals for a future runtime-adapter boundary are welcome, but they must keep durable Context Map state separate from the agent runtime and must not add a second agent loop to the current DeepSeek Harness application.

## License

By contributing, you agree that your contribution is licensed under this repository's [MIT License](LICENSE).

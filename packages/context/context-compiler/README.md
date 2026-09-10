---
description: "Registry-backed durable context selection for DeepSeek Harness model requests"
kind: "package-reference"
---

# @deepseek-ai/dsh-context-compiler

English | [中文](README.zh.md)

## Summary

`dsh-context-compiler` is the Harness capability seam that selects which durable Session message events enter a model request. It preserves the Session log as the source of truth: providers return ordered event sequence numbers, and the registry validates and projects those events into frozen `Message` objects.

## Table of Contents

- [Default behavior](#default-behavior)
- [Registering a provider](#registering-a-provider)
- [Provider contract](#provider-contract)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="default-behavior"></a>
## Default behavior

The built-in `{ id: 'surface', version: 1 }` provider is active when a Session has no `context/compiler` event. Its output is equivalent to `session.deriveMessages()`, including surface replacements and omission of empty assistant completion anchors.

<a id="registering-a-provider"></a>
## Registering a provider

```ts ignore-check
const dispose = ctx.contextCompiler.register({
  id: 'contextify',
  version: 1,
  select: ({ session, turn, step }) => ({
    eventSeqs: selectContextifyEvents(session, { turn, step }),
  }),
})

ctx.contextCompiler.select(session, 'contextify')
const compilation = ctx.contextCompiler.compile({ session, turn: 1, step: 1 })
```

`select()` appends a complete `context/compiler` descriptor only when it differs from the Session's current descriptor. A registration disposer removes process-local execution authority without rewriting durable history; compiling a Session that still selects the removed provider fails loudly.

<a id="provider-contract"></a>
## Provider contract

A provider must be synchronous and pure. It may inspect the supplied Session and request coordinates, but it must not perform network or model calls, append events, read the clock, or mutate external state. It returns only existing, unique, non-negative safe-integer seqs for `system/message`, `user/message`, non-empty `assistant/message`, `tool/result`, or `context/compiler-snapshot` events. A snapshot is log-only and does not join `Session.surface`; the model sees its frozen message only when the active compiler selects that exact event. The registry preserves the returned order and rejects every invalid selection before model I/O.

Providers cannot register the reserved `surface` id. Ids are non-empty strings without surrounding whitespace, versions are positive safe integers, and duplicate ids fail. A durable descriptor whose provider is missing or whose version differs from the live registration never falls back to `surface`.

<a id="model-experience"></a>
## Model Experience

### Compiled conversation history

#### What the model sees

The model sees the ordered messages selected by the active compiler, including the durable system message, together with the ordinary Harness tool schemas. Non-default compiler metadata is recorded in `request/header`; default Surface requests retain the upstream header shape. Compilation runs again after request recovery changes durable history.

#### Token effect

The selected event set directly determines conversation-history input tokens. This package adds no prompt text of its own.

#### KV Cache effect

Preserving a stable selected prefix preserves the corresponding reusable request prefix. Reordering, excluding, or reinserting earlier events can invalidate cache reuse from the first changed message onward.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Selection, not in-request synthesis** — a compiler cannot create messages or summaries during `select`; another plugin must append a `context/compiler-snapshot` before selecting copied or synthesized content.
- **Synchronous execution** — network-backed retrieval and model-backed ranking belong before compilation, not inside a provider.
- **Exact provider availability** — resuming a Session requires the selected provider id and version to be registered before the next Agent Loop step.
- **Session events only** — non-message events and arbitrary in-memory `Message` objects cannot enter a compilation.

<a id="dev-note"></a>
### Dev Note

No invariant companion is published because the Agent Loop companion checks compiled requests and the plugin owns no independent runtime invariant.

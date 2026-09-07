# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

This package retains its upstream `@deepseek-ai/dsh-client-ui-brand-official` identifier so DSH Context Map can merge the DeepSeek Harness module graph without renaming package edges. In this distribution its replaceable occupants identify the product as DSH Context Map; the package identifier does not imply that the product is an official DeepSeek distribution.

The package fills `sidebar.brand.mark`, `sidebar.brand.name`, and `conversation.hero.brand.mark` only when `DSH_CLIENT_BUILD_PROFILE` is `official`. Other builds load the plugin but register no occupants, leaving the shell fallbacks visible.

The three occupants install as one declaration-aware registration set through nested `slots.inject()` calls. The package therefore works whether its row activates before or after the sidebar and conversation declarers, withdraws all occupants when either declaration collapses, and leaves no partial brand mix during HMR. It retains no runtime state. The node half is an empty Loader seat, and the browser title remains a build-environment concern outside this package.

## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The package id is an upstream compatibility detail** — product identity comes from the slot occupants and build-selected browser title.
- **The package supplies one occupant set** — another distribution can replace this row with a Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

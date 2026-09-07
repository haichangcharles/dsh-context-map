# native/

English | [中文](README.zh.md)

Native source and inherited package contracts maintained with the DeepSeek Harness codebase. The [`landlock-run/` workspace](landlock-run/README.md) owns the Landlock self-restrict-then-exec launcher consumed by the harness, including its architecture, three-package npm family, platform support, development workflow, and [compatibility procedure](landlock-run/docs/release.md). DSH Context Map publishes source only and does not publish these inherited npm packages.

## Workspace and release boundary

`landlock-run/` and its packages belong to the repository's root pnpm workspace and lockfile. Harness consumers use the current workspace entry package during development and CI, so a launcher contract change and its consumer update can land and be tested together.

The main repository's `Landlock Run` workflow builds and tests each supported architecture. The manual `Package compatibility (upstream Landlock Run)` workflow assembles those native artifacts and packs and verifies the three npm tarballs without registry credentials or a publish job. The entry package retains platform packages as npm optional dependencies, so an upstream-shaped package rehearsal still selects only the package matching the user's operating system and CPU.

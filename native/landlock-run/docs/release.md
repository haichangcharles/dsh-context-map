# Upstream package release reference

DSH Context Map publishes tagged source through GitHub Releases. It does not publish the inherited Landlock npm package family. This document retains build and version-alignment details for upstream synchronization; do not use it as the community project's release checklist.

## Versioning

The launcher workspace root and its three npm-compatible packages share one version. During an upstream synchronization that changes this family, run the bump helper from the repository root:

```sh
pnpm --dir native/landlock-run release:bump patch          # or minor / major / x.y.z
```

It updates `native/landlock-run/package.json` and every `native/landlock-run/packages/*` manifest, refreshes the repository root lockfile (`--ignore-scripts --lockfile-only`), and runs `release:verify`. Explicit versions accept full semver including prereleases (`pnpm --dir native/landlock-run release:bump 0.0.0-test.0`). Keep `workspace:*` dependencies in source; pnpm converts them to concrete versions during pack.

Version bumps are normal source changes and must keep the launcher manifests and root lockfile together. Product releases use `dsh-context-map-vX.Y.Z` tags; they do not create or consume Landlock package-release tags.

## Preflight

```sh
pnpm install --frozen-lockfile
pnpm --dir native/landlock-run build:ts
pnpm --dir native/landlock-run typecheck
pnpm --dir native/landlock-run test:entry
```

On a Linux host, also rehearse the pack path locally:

```sh
pnpm --dir native/landlock-run build:native
pnpm --dir native/landlock-run test:launcher
node native/landlock-run/scripts/pack-release.mjs native/landlock-run/.release/npm --current-platform-only
node native/landlock-run/scripts/verify-packed-install.mjs native/landlock-run/.release/npm --current-platform-only
```

## Community compatibility workflow

The manual `Package compatibility (upstream Landlock Run)` workflow builds every binary on its matching native runner, assembles and verifies the payload, packs the npm-compatible tarballs in dependency order, rehearses the installed entry, and uploads a short-lived artifact for inspection. It accepts no publish switch, registry credential, or OIDC publication permission.

The `upstream:release:publish` package script and its implementation remain source-only maintenance references for comparing future upstream changes. DSH Context Map workflows and release instructions never invoke them. Adding a supported registry distribution requires a project-owned namespace and a separate release decision.

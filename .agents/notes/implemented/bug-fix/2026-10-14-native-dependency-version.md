# Agent Note: Published native dependencies use the tested version

Status: implemented

English | [中文](2026-10-14-native-dependency-version.zh.md)

## Problem

A fresh npm consumer does not inherit the workspace lockfile. Six native Host packages declared Koffi `^3.1.0`, while workspace CI resolved `3.1.1`. The packed-install CI job resolved `3.3.3` and failed compiling `uv.cc` under Linux Node 24.21.0: its conditional expression mixed `Napi::Value` and `nullptr_t`. The verifier omits optional dependencies, so Koffi's optional platform prebuild was unavailable and its installer compiled from source.

## Decision

All six public runtime consumers declare exact Koffi `3.1.1`; their lockfile importers use the same specifier without changing resolved packages. The [release contract regression](../../../../scripts/release/native-dependency-contract.spec.ts) discovers public consumers through the existing release family and checks that each published constraint equals its workspace-tested resolution. An intentional native upgrade must update both together. The packed-install verifier and its optional-dependency policy remain unchanged.

## Alternatives considered

- **Keep the caret and pin only the workspace lock.** Fresh npm consumers still resolve another native installer.
- **Add a root override.** Published Host packages do not carry the workspace root's overrides.
- **Skip install scripts or loosen the release gate.** This would leave native loading unverified.

## Consequences

Fresh consumers retain the tested native version. Upgrades require an explicit package-constraint change and native installation validation. This does not guarantee source compilation on every operating system or Node version, and it does not change agent behavior or add provider requests.

## Testing

The new public-manifest contract fails on the previous caret and passes for all six corrected consumers. A fresh macOS arm64 npm consumer installs and loads Koffi `3.1.1` under Node 24.19.0 with its standard optional prebuild. The same local probe with optional dependencies omitted stops because CMake is unavailable; Linux source installation remains the responsibility of the unchanged packed-install CI gate. Offline pnpm metadata validation also requires registry metadata absent from this local cache; its supply-chain policy is retained. Only the six Koffi lockfile specifiers change.

## Related

- [Official 3.1.1 metadata](https://registry.npmjs.org/koffi/3.1.1) and [3.3.3 metadata](https://registry.npmjs.org/koffi/3.3.3) declare the platform prebuilds as optional dependencies.
- The [release sequence decision](../process/2026-08-10-npm-release-sequences.md) and [published dependency ownership](../process/2026-08-26-published-dependency-faces.md) retain their separate publication and dependency-identity rationale; neither is superseded.

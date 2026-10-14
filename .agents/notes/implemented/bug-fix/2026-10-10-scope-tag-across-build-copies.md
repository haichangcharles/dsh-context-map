# Agent Note: Stable scope tags across package build copies

Status: implemented

English | [中文](2026-10-10-scope-tag-across-build-copies.zh.md)

## Problem

In the research workspace, source and built copies of `dsh-scope` can load in the same process. Each copy previously created a distinct `Symbol('dsh.scope')`. A child context minted by one copy then appeared unscoped to a registry using the other copy. Scoped prompt contributions landed in the global layer, so creating a second worker failed with a duplicate `subagent:delegation` registration. The existing system-prompt scope suite also failed.

## Decision

Use `Symbol.for('dsh.scope')` for the context tag. This shares the tag across module copies while keeping each scope's opaque key object distinct. Add a regression test that mints with the built package and reads with the source module.

## Alternatives considered

- **Keep a module-local Symbol and rely on one resolver path** — fragile when tooling loads both source and built artifacts.
- **Special-case the child prompt registration** — would hide the broader registry-scope mismatch.

## Consequences

The 13 system-prompt scoped tests and the native multi-worker Web replay pass again, along with the new cross-copy test. This fixes context tag recognition, not all possible mixed-copy module state: parent links and carrier bookkeeping remain module-local and should use one package instance in production builds.

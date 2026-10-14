# Agent Note: Personal Context style reversal

Status: implemented

English | [中文](2026-10-10-personal-context-style-reversal.zh.md)

## Problem

The existing training-free Context advisor uses up to 32 confirmed choices to estimate a stable preference. With eight earlier Includes for one Web-source cell, it abstained after three opposing Excludes and needed about twenty opposing Excludes before advising Exclude. Repeated corrections therefore left a changed organization habit unaided for too long.

## Decision

Before selecting the source, path, or joint-cell expert, the advisor checks direct-weight choices in the exact source-kind, Web-action, and active-path cell. It switches advice only when at least five earlier choices formed a strong opposite Beta-smoothed majority and the five most recent choices in that cell unanimously support the new action. A fractional selection from a multi-node accepted proposal cannot count as a full confirmation. The existing 32-choice bound and graph validator remain in force. This changes only a reviewable suggestion; the user still confirms any Plan edit.

The bounded Exclude pass now considers only active candidates that are currently included. Previously, already excluded nodes could consume both suggestion slots before the graph validator discarded those no-ops, hiding a useful Exclude for a still included source.

## Alternatives considered

- **Keep the lifetime majority until old choices age out** — rejected because a user with eight earlier Includes needed about twenty new Excludes before the advisor switched.
- **Use the most recent choice immediately** — rejected because one accidental or task-specific edit could reverse a stable style.
- **Train a temporal model** — deferred because the available Context-choice logs do not provide enough observed preference changes to identify its parameters or validate a downstream gain.

## Consequences

A controlled reversal from eight Includes to five Excludes now changes advice on the fifth correction; four corrections do not, and a different Web action or fractional batch feedback does not borrow that reversal. The existing held-out Persona2Web-derived native replay remains exactly unchanged at 19/20 compiled source choices. These are implementation checks, not evidence that real users change preferences at this rate or that the detector improves Web task success. The fixed threshold remains a conservative product rule until longitudinal choices support calibration.

A native Session-family test also confirms that five reviewed Web reversals produce a valid Exclude proposal for a new Web result, and that accepting it removes that result from the next compiled request. An already excluded source no longer occupies a bounded Exclude slot.

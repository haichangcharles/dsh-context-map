# Agent Note: Context Map product homepage

Status: implemented

English | [中文](2026-09-10-context-map-product-page.zh.md)

## Problem

The fork's GitHub Pages root presents upstream documentation rather than the Context Map product. Visitors need a concise explanation, a demonstrable context-selection interaction and a source-installation path.

## Decision

The product homepage is static HTML, CSS and browser JavaScript under `product-site/public`. Its dark developer-tool layout uses near-black neutral surfaces, readable text, quiet borders and restrained green accents, informed by Linear and Zed; copy and illustrative UI are original. English is the default; a URL-backed Chinese switch preserves demo selection. The sample graph and branch controls operate on local fixture data only, clearly labelled as a sample. No model request or real Session mutation occurs.

The build overlays the homepage onto the documentation output, preserving documentation routes. The fork-specific Pages workflow deploys the combined artifact from master. The upstream manual documentation workflow does not deploy in this fork, preventing a later documentation publication from overwriting the product homepage. Both workflows retain the same Pages concurrency group.

## Alternatives considered

Replacing documentation with a standalone landing deployment would break existing guide URLs. Building the marketing page inside the Agent Web app would couple a public static introduction to private session/runtime infrastructure. Copying an existing brand's assets or claims would misrepresent this community project.

## Consequences

The homepage can be served by GitHub Pages without credentials or a runtime. Source installation and old-session migration limitations remain visible. Publication still builds documentation and uses the existing Pages environment policy; no protection is removed.

## Verification

Validate desktop and mobile layout, bilingual copy, node selection and reset, branch switching, clipboard behavior and console errors. Build documentation before applying the overlay, verify documentation routes remain present, then verify the deployed homepage identifies DSH Context Map. The demo is illustrative evidence of interaction, not a live Agent run.

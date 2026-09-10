# Agent Note: Context Map product homepage

Status: implemented

English | [中文](2026-09-10-context-map-product-page.zh.md)

## Problem

The fork's GitHub Pages root presents upstream documentation rather than the Context Map product. Visitors need a concise explanation, a short, understandable demonstration of context selection and a source-installation path.

## Decision

The product homepage is static HTML, CSS and browser JavaScript under `product-site/public`. Its dark developer-tool layout uses near-black neutral surfaces, readable text, quiet borders and restrained green accents, informed by Linear and Zed; copy is original. English is the default, with a URL-backed Chinese switch. An approximately 20-second recording replaces the hand-built illustrative UI. It captures the actual dark Web application: a prepared launch conversation changes from paid enterprise to free/open source; two outdated messages are unchecked; the excluded message is located in the original Chat. The visible context count changes from six to four while history stays intact. The sample is explicitly labelled; no model call occurs. Three bilingual chapter buttons seek the recording, with a synchronized explanatory caption. Native playback controls and a poster avoid unsolicited autoplay.

`product-site/capture.config.ts` and `apps/web/tests/product-walkthrough.capture.ts` reproduce the scenario through the existing hermetic Web scaffold and real UI. The capture asserts that excluded text is absent from `contextCompiler.compile()` and remains in `session.snapshotEvents()`. The published WebM is trimmed only to remove setup; it contains no fabricated UI or model response presented as live.

The build overlays the homepage onto the documentation output, preserving documentation routes. The fork-specific Pages workflow deploys the combined artifact from master. The upstream manual documentation workflow does not deploy in this fork, preventing a later documentation publication from overwriting the product homepage. Both workflows retain the same Pages concurrency group.

## Alternatives considered

Replacing documentation with a standalone landing deployment would break existing guide URLs. Building the marketing page inside the Agent Web app would couple a public static introduction to private session/runtime infrastructure. Copying an existing brand's assets or claims would misrepresent this community project.

## Consequences

The homepage can be served by GitHub Pages without credentials or a runtime. Source installation and old-session migration limitations remain visible. Publication still builds documentation and uses the existing Pages environment policy; no protection is removed.

## Verification

Validate desktop and mobile layout, bilingual copy, chapter seeking, video playback, clipboard behavior and console errors. Run the capture to verify compiled context and preserved history. Apply the overlay to a documentation build, verify documentation routes remain present, then verify the deployed recording and homepage. The public page plays prepared footage; it does not execute an Agent.

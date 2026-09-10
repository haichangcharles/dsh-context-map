# Agent Note: Context Map product homepage

Status: implemented

English | [中文](2026-09-10-context-map-product-page.zh.md)

## Problem

The fork's GitHub Pages root presents upstream documentation rather than the Context Map product. Visitors need a concise explanation, a short, understandable demonstration of context selection and a source-installation path.

## Decision

The product homepage is static HTML, CSS and browser JavaScript under `product-site/public`. Its dark developer-tool layout uses near-black neutral surfaces, readable text, quiet borders and restrained green accents, informed by Linear and Zed; copy is original. English is the default, with a URL-backed Chinese switch. A fixed-height showcase replaces the expanded screenshot gallery. Four visible tabs cover Branch, Context, Review & restore, and Prompts, with Branch selected initially. Longer explanations and the branch-menu and archive screenshots are available through disclosures. Tabs support arrow keys, Home/End and mobile horizontal swipes without automatic playback. The branch screenshot focuses on the map on small screens; original-image links preserve the complete screenshots. Screenshots use the running application; conversations and the recommendation are explicitly labelled as prepared samples rather than live AI results.

`product-site/capture.config.ts` and `apps/web/tests/product-walkthrough.capture.ts` reproduce the gallery through the hermetic Web scaffold. The capture verifies native fork ancestry, cross-branch inclusion in the real context compiler, exclusion without deleting history, preview without mutation, apply/undo, and archive/restore. It stays in the host TypeScript program alongside the other scaffold-based Web tests.

The build overlays the homepage onto the documentation output, preserving documentation routes. The fork-specific Pages workflow deploys the combined artifact from master. The upstream manual documentation workflow does not deploy in this fork, preventing a later documentation publication from overwriting the product homepage. Both workflows retain the same Pages concurrency group.

## Alternatives considered

Replacing documentation with a standalone landing deployment would break existing guide URLs. Building the marketing page inside the Agent Web app would couple a public static introduction to private session/runtime infrastructure. Copying an existing brand's assets or claims would misrepresent this community project.

## Consequences

The homepage can be served by GitHub Pages without credentials or a runtime. Source installation and old-session migration limitations remain visible. Publication still builds documentation and uses the existing Pages environment policy; no protection is removed.

## Verification

Validate desktop and mobile layout, bilingual copy, tab selection, stable panel height, disclosures, keyboard navigation, mobile swipes, all six screenshots and their original-image links, clipboard behavior and console errors. Run the capture to verify the demonstrated operations. Apply the overlay to a documentation build and verify the public homepage and retained documentation routes. The static page performs no model calls.

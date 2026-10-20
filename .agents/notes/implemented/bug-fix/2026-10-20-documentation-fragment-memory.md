# Agent Note: Bounded documentation fragment indexing

Status: implemented

English | [中文](2026-10-20-documentation-fragment-memory.zh.md)

## Problem

The built-site fragment verifier needs target IDs and anchor hrefs across pages. Retaining a browser DOM for every generated page exhausts the heap during documentation acceptance, even after the site itself builds successfully.

## Decision

The [verifier](../../../../scripts/verify-doc-site-fragments.ts) uses maintained parse5 8.0.1, the HTML parser already used by JSDOM, as an explicit development dependency. Each full HTML document is parsed once with scripting disabled, preserving JSDOM's noscript behavior. The cross-page index retains only ID/name strings and fragment-bearing href strings; page trees are released. Traversal preserves document order, excludes template contents and ignores namespaced hrefs. Route aliases, URL resolution, decoded fragments and missing-file diagnostics keep their existing semantics. The verifier creates no browser windows or additional asynchronous resource lifecycle.

## Alternatives considered

**Raise the heap limit for every documentation check.** This retains unnecessary page trees and increases local and CI memory pressure.

**Close a JSDOM window per page or share one DOMParser.** These still exhaust the bounded heap on the actual site; avoiding window/document retention is the smaller implementation.

**Extract links with regular expressions.** This would duplicate HTML parsing and mishandle inert markup, entities and namespaces.

## Consequences

The verifier owns a direct development dependency on the maintained parser and a small traversal over its typed tree. Original fragment fixtures and a full-document/entity/inert-content/namespace case check semantic compatibility. Full-site acceptance uses the same published HTML output; lower verifier memory is an engineering result, unrelated to agent accuracy or personalization. Site bundling and TypeScript documentation checks have separate memory requirements.

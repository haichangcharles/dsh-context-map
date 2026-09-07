# DSH Context Map Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish DSH Context Map as an independently branded community project while retaining DeepSeek Harness as its compatible upstream runtime.

**Architecture:** Product identity changes stay in repository documentation, build-selected browser metadata, and the existing replaceable brand-slot occupant. Runtime package identifiers, model providers, Session persistence, Context Compiler behavior, and the Harness agent loop remain unchanged. Git uses an independent `origin` for product releases and a read-only `upstream` for reviewed version merges.

**Tech Stack:** GitHub CLI, Git, Markdown, React 18, TypeScript, CSS Modules, Vite, pnpm, Vitest, Playwright

---

## File structure

- `README.md` and `README.zh.md`: public product identity, source installation, independence notice, architecture attribution, and upstream update workflow.
- `packages/client/ui-brand-official/src/client/Brand.tsx`: retained upstream package location that supplies this distribution's neutral Context Map mark and product name through existing slots.
- `packages/client/ui-brand-official/src/client/Brand.module.css`: product wordmark typography without changing sidebar layout ownership.
- `packages/client/ui-brand-official/src/css-modules.d.ts`: local CSS Module declaration.
- `packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx`: brand slot and rendered identity regression.
- `packages/client/ui-brand-official/README.md` and `README.zh.md`: explain that the package id is retained for upstream compatibility while this distribution supplies its own brand.
- `apps/web/public/manifest.webmanifest`: installed application name.
- `apps/web/tests/pwa-manifest.e2e.ts`: PWA identity regression.
- `apps/web/vite.config.ts`: initial browser-title fallback.
- `packages/client/ui-renderer/src/client/DocumentTitle.tsx`: runtime browser-title fallback.
- `packages/client/ui-renderer/tests/document-title.client.spec.tsx`: title regression.
- `docs/plans/2026-09-07-dsh-context-map-project-identity-design.md`: approved identity and compatibility design.

### Task 1: Public repository documentation

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`

- [ ] **Step 1: Replace the English landing page with the independent product identity**

Lead with this exact positioning and preserve links to the official runtime:

```markdown
# DSH Context Map

English | [中文](README.zh.md)

DSH Context Map is an independently maintained conversation-context workspace built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It turns native Harness Session forks into an inspectable map where people can navigate branches and control which completed user inputs and final assistant outputs enter the next model request.

> [!IMPORTANT]
> DSH Context Map is a community project maintained by [haichangcharles](https://github.com/haichangcharles). It is not an official DeepSeek product and is not maintained or endorsed by DeepSeek AI.
```

Document Context Map, context recommendations, branch recommendations, per-node Archive placeholders, Prompt Dashboard, and native Session compatibility as the principal capabilities. Run instructions must clone `https://github.com/haichangcharles/dsh-context-map.git` and use `pnpm install`, `pnpm run build`, and `pnpm dsh web`.

- [ ] **Step 2: Write the matching Chinese landing page**

Use the same section order and facts. State “DSH Context Map 是由 haichangcharles 独立维护的社区项目，并非 DeepSeek 官方产品，也不由 DeepSeek AI 维护或背书。” without weakening the attribution.

- [ ] **Step 3: Add the upstream update command sequence to both languages**

```bash
git fetch upstream --tags
git switch -c codex/sync-deepseek-rc9 master
git merge --no-ff dsh-v0.1.0-rc.9
pnpm run typecheck
pnpm run build
pnpm run doc-sync
```

Explain that `origin` is the product repository and `upstream` is `https://github.com/deepseek-ai/deepseek-harness.git`. Product features do not enter synchronization branches.

- [ ] **Step 4: Verify the landing pages**

Run: `pnpm run verify-md-links && pnpm run verify-md-wrap`

Expected: both commands exit `0`; every public clone URL names `haichangcharles/dsh-context-map` and every DeepSeek link is explicitly upstream attribution.

- [ ] **Step 5: Commit the documentation**

```bash
git add README.md README.zh.md
git commit -m "docs: present DSH Context Map as an independent project"
```

### Task 2: Visible application brand

**Files:**
- Modify: `packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx`
- Modify: `packages/client/ui-brand-official/src/client/Brand.tsx`
- Create: `packages/client/ui-brand-official/src/client/Brand.module.css`
- Create: `packages/client/ui-brand-official/src/css-modules.d.ts`
- Modify: `packages/client/ui-brand-official/README.md`
- Modify: `packages/client/ui-brand-official/README.zh.md`

- [ ] **Step 1: Change the component test to require the community identity**

Replace the SVG-viewBox assertion with user-visible assertions:

```tsx
it('renders the DSH Context Map identity at both requested mark sizes', () => {
  const name = render(<OfficialBrandName />)
  expect(name.getByText('DSH Context Map')).toBeTruthy()
  name.unmount()

  const mark = render(<OfficialBrandMark size={34} className="hero-mark" />)
  expect(mark.getByLabelText('DSH Context Map').getAttribute('width')).toBe('34')
  expect(mark.getByLabelText('DSH Context Map').getAttribute('class')).toBe('hero-mark')
  mark.rerender(<OfficialBrandMark size={24} />)
  expect(mark.getByLabelText('DSH Context Map').getAttribute('width')).toBe('24')
})
```

- [ ] **Step 2: Run the focused test and observe the old-brand failure**

Run: `pnpm vitest run packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx`

Expected: FAIL because the old component renders the DeepSeek artwork and has no `DSH Context Map` accessible identity.

- [ ] **Step 3: Replace only the slot occupants**

Implement a neutral graph mark using SVG nodes and edges with `currentColor`, honoring `size` and `className`. Keep the existing exported component names and slot registration so upstream package wiring remains stable. Render the name as:

```tsx
export function OfficialBrandName() {
  return <span className={css.name}>DSH Context Map</span>
}
```

The mark must set `role="img"`, `aria-label="DSH Context Map"`, and a `viewBox` independent of its requested size. Do not import `FishLogo` or `BrandWordmark`.

- [ ] **Step 4: Add presentation-only CSS**

```css
.name {
  overflow: hidden;
  color: currentColor;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.01em;
  line-height: 24px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 5: Update package documentation in both languages**

State that the retained `@deepseek-ai/dsh-client-ui-brand-official` package id is an upstream compatibility identifier, while its replaceable slot occupants identify this distribution as DSH Context Map. Preserve the Model Experience guarantee that the package sends nothing to a model.

- [ ] **Step 6: Run focused tests**

Run: `pnpm vitest run packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx packages/client/ui-brand-official/tests/invariant.client.spec.ts`

Expected: all tests pass.

- [ ] **Step 7: Commit the application wordmark**

```bash
git add packages/client/ui-brand-official
git commit -m "feat(brand): identify the Web UI as DSH Context Map"
```

### Task 3: Browser and installed-app metadata

**Files:**
- Modify: `apps/web/tests/pwa-manifest.e2e.ts`
- Modify: `apps/web/public/manifest.webmanifest`
- Modify: `apps/web/vite.config.ts`
- Modify: `packages/client/ui-renderer/src/client/DocumentTitle.tsx`
- Modify: `packages/client/ui-renderer/tests/document-title.client.spec.tsx`

- [ ] **Step 1: Require the new PWA name**

Change the manifest expectation to:

```ts
expect(manifest).toMatchObject({
  id: '/',
  name: 'DSH Context Map',
  short_name: 'Context Map',
})
```

- [ ] **Step 2: Require the browser-title fallback**

Add a test that clears `DSH_CLIENT_TITLE`, renders `DocumentTitle`, and expects `document.title` to equal `DSH Context Map`. Keep the existing explicit-environment test to prove deployments can override the product title.

- [ ] **Step 3: Run both regressions and observe failure**

Run: `pnpm vitest run apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-renderer/tests/document-title.client.spec.tsx`

Expected: FAIL because the PWA uses `DeepSeek Harness` and the fallback uses `DSH Local Build`.

- [ ] **Step 4: Update the three owner values**

Set both `DEFAULT_CLIENT_TITLE` constants to `DSH Context Map`. Set the manifest `name` to `DSH Context Map` and `short_name` to `Context Map`. Do not change `DSH_CLIENT_TITLE`; it remains the build-time deployment override.

- [ ] **Step 5: Run the regressions**

Run: `pnpm vitest run apps/web/tests/pwa-manifest.e2e.ts packages/client/ui-renderer/tests/document-title.client.spec.tsx`

Expected: all tests pass.

- [ ] **Step 6: Commit browser metadata**

```bash
git add apps/web/public/manifest.webmanifest apps/web/tests/pwa-manifest.e2e.ts apps/web/vite.config.ts packages/client/ui-renderer/src/client/DocumentTitle.tsx packages/client/ui-renderer/tests/document-title.client.spec.tsx
git commit -m "feat(web): publish DSH Context Map product metadata"
```

### Task 4: Independent GitHub repository

**Files:**
- Modify: Git remote configuration only; no credential files
- Modify: GitHub repository metadata through `gh`

- [ ] **Step 1: Create the independent public repository**

Run:

```bash
gh repo create haichangcharles/dsh-context-map --public --description "Visual, user-controlled conversation context for long-horizon agents, built on DeepSeek Harness."
```

Expected: GitHub returns `https://github.com/haichangcharles/dsh-context-map`; `gh repo view haichangcharles/dsh-context-map --json isFork` reports `false`.

- [ ] **Step 2: Preserve the former fork and change the canonical remote**

Run:

```bash
git remote rename origin legacy-fork
git remote add origin https://github.com/haichangcharles/dsh-context-map.git
git remote set-url --push upstream DISABLED
```

Expected: `origin` points to the independent repository, `upstream` fetches from `deepseek-ai/deepseek-harness`, and `legacy-fork` points to `haichangcharles/deepseek-harness`.

- [ ] **Step 3: Publish the branded release candidate as the default branch**

After Tasks 1–3 pass, run:

```bash
git push origin HEAD:master
git push origin dsh-context-map-v0.1.0
gh repo edit haichangcharles/dsh-context-map --default-branch master
```

Expected: the new repository's `master` resolves to the branded commit. The old tag remains available for historical comparison even though the branded master is newer.

- [ ] **Step 4: Set discovery metadata**

Run:

```bash
gh repo edit haichangcharles/dsh-context-map --description "Visual, user-controlled conversation context for long-horizon agents, built on DeepSeek Harness." --homepage "https://github.com/haichangcharles/dsh-context-map" --add-topic dsh-plugin --add-topic deepseek-harness --add-topic context-management --add-topic conversation-visualization --add-topic ai-agents
```

Expected: the repository page uses the independent description and all five topics.

- [ ] **Step 5: Publish maintenance branches without treating them as releases**

Run:

```bash
git push -u origin codex/sync-deepseek-rc8
git push origin codex/contextify-harness
```

Expected: both branches exist for traceability; `master` remains the default product branch.

### Task 5: Release verification

**Files:**
- Verify all files changed in Tasks 1–3

- [ ] **Step 1: Run static and focused checks**

Run:

```bash
pnpm run test:gui
pnpm run typecheck
pnpm run build
pnpm run doc-sync
git diff --check
```

Expected: every command exits `0`.

- [ ] **Step 2: Run the assembled browser regression**

Run: `DSH_SNAPSHOT=replay pnpm run test:web`

Expected: the keyless Web suite passes and its built application displays `DSH Context Map` without changing Context Map behavior.

- [ ] **Step 3: Inspect the public repository**

Run:

```bash
gh repo view haichangcharles/dsh-context-map --json name,description,homepageUrl,isFork,defaultBranchRef,url
git remote -v
git ls-remote --heads origin master codex/sync-deepseek-rc8 codex/contextify-harness
```

Expected: `isFork` is `false`, the default branch is `master`, `origin` is the product repository, and `upstream` remains the official runtime source.

- [ ] **Step 4: Perform a clean-tree release check**

Run: `git status --short --branch`

Expected: no uncommitted files and the current commit exists on `origin/master`.

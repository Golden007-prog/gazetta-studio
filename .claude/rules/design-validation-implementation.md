# Validation — Implementation

Companion to [design-validation.md](design-validation.md). This doc covers what we're doing with the design: phased cut sequence with risk ordering, per-cut scope, deferred items, build order rationale.

See [design-validation.md](design-validation.md) for the design itself.

## Phased cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Per [team-preferences.md rule 17](team-preferences.md): "Build and validate, don't spike. Each commit must produce real code that stays if the approach works, be independently rollback-able." Each cut is independently shippable and independently valuable; we can stop at any cut.

| Cut | What | Effort | Dependency | Status |
|---|---|---|---|---|
| **1** | Validator infrastructure + save-delta | 4 days | None | ✓ |
| **2** | Background scanner + admin UI surfaces | 4 days | Cut 1 | ✓ — `scanner.ts` + `SiteHealthDrawer.vue` + `validationScanner` / `validationIssues` stores; 3 background-only validators shipped (`schema-conformance`, `orphaned-locale-file`, `unused-fragment`) |
| **3** | Render-for-analysis + quality validators (a11y, html-validate) + altRequired | 5 days | Cut 1, Cut 2 | ✓ — `validators/accessibility.ts`, `html-validity.ts`, `alt-required.ts`, `alt-required-walker.ts` shipped |
| **4** | Publish gate + broken-links | 5 days | Cut 3 | ✓ — pre-publish audit step in `PublishPanel.vue` + `publish-audit.ts` + `validators/broken-links.ts` (internal links only) shipped. **Lighthouse validator deferred indefinitely**; outbound link checking and #anchor targets deferred — see "What's deferred from this plan" |
| **5** | `gazetta validate` CLI rewrite | 2 days | Cut 1 (more useful after Cut 3) | ✓ — `runValidate` rebuilt around scanner orchestrator; `parseValidateFlags` supports `--severity`, `--include-quality`, `--no-warn-as-error`, `--verbose`; 15 tests across `cli-validate-flags.test.ts` + `cli-validate.test.ts` |
| **6** | Template-developer surfaces | 3 days | Cut 2 | ✓ — `template-impact.ts` shipped |

**Total: ~23 days** for the full plan. **Status as of 2026-05-12:** All 6 cuts shipped. Lighthouse (originally Cut 4) deferred indefinitely — pre-publish audit framework supports adding it later when concrete operator demand surfaces. Plus 5 additional soft-delete validators (`aliasof-points-to-archived`, `archive-not-supported-on-target`, `circular-alias`, `dangling-alias`, `referenced-archived-without-alias`) shipped beyond the original cut scope.

**Minimum useful ship: Cut 1 (4 days)** — catches the most common author-introduced breaks; establishes the abstraction.

**Recommended first ship: Cut 1 + Cut 2 (8 days)** — gives authors both delta blocking and ambient visibility; the seam is uniform. Cut 2 depends on AdminCache; sequence in practice is AdminCache cuts 1-2 (the seam + `MemoryCache` provider) before Cut 2's scanner can be a clean composition consumer rather than an ad-hoc memo that gets ripped out later.

**"Real quality" ship: Cut 1 + 2 + 3 (13 days)** — adds a11y + HTML validity + altRequired; validators against rendered output.

## Per-cut scope

### Cut 1 — Validator infrastructure + save-delta (4 days)

**What ships:**
- `Validator` interface + `Issue` shape (`packages/gazetta/src/validation/types.ts`)
- Save-delta orchestrator (`packages/gazetta/src/validation/save-delta.ts`) — diff incoming vs. existing manifest; collect refs introduced by this edit
- Five validator implementations (`packages/gazetta/src/validation/validators/`):
  - `referenced-asset-exists`
  - `referenced-fragment-exists`
  - `referenced-template-exists`
  - `circular-fragment-introduced`
  - `dynamic-route-conflict-introduced`
- Wire into `PUT /api/pages/:name` and `PUT /api/fragments/:name` handlers
- 409 response shape: `{ code: 'VALIDATION_FAILED', issues: Issue[] }`
- Schema in `admin-api/schemas/validation.ts`
- Admin UI banner component (`apps/admin/src/client/components/ValidationBanner.vue`):
  - Renders when save returns 409
  - Lists issues with severity icons
  - "Fix" action on each issue scrolls to the offending field
  - Disables the Save button until issues clear

**Tests:**
- Unit tests per validator (refs found / not found / introduced vs. pre-existing)
- Save-delta orchestrator: only flags new violations; pre-existing issues pass through
- Admin-api integration: 409 with correct issue structure
- Vue component: banner renders + "Fix" focuses correct field

**SOLID lenses:**
- SRP: each validator owns one concern; orchestrator owns diff + dispatch
- OCP: adding a new validator is one new file + one registry entry
- LSP: every validator honors the same `Validator` contract
- ISP: validators don't see UI concerns; UI doesn't see validation logic
- DIP: route handler depends on the orchestrator's `runSaveDelta` function, not on individual validators

**What it doesn't catch yet:**
- Anything pre-existing in the site (Cut 2's job)
- Quality issues (a11y, HTML validity — Cut 3)
- altRequired (depends on schema walking — Cut 3)

**Risk:** medium. The diff logic is the only novel piece; everything else is straightforward integration.

### Cut 2 — Background scanner + admin UI surfaces (4 days)

**What ships:**
- Background scanner service (`packages/gazetta/src/validation/scanner.ts`):
  - Initial full-site scan on admin server boot
  - Incremental rescan triggered by:
    - File watcher events in `gazetta dev` (manifest, template, asset changes — dev-only since `gazetta serve` has no watcher)
    - Save handler in both `dev` and `serve` modes — Cut 1's save-delta path notifies the scanner of committed changes, scanner re-validates the affected item plus its transitive dependents (via `findDependentsFromSidecars({ fragment })` for fragment edits, `readRefsForAsset(name)` for asset edits)
  - Per-item validation cache backed by `AdminCache.MemoryCache`, keyed by content hash; only re-runs when something material changed
  - Template-edit invalidation in v1: full-site rescan as fallback (no `template-deps` reverse-dep relation ships; see "Deferred from Cut 2" below)
  - Result store keyed by item path
- New admin API: `GET /api/validation/issues` returns current `Issue[]` across the site
- SSE event: `validation-issues-updated` — pushes new issue counts when the scanner finishes a pass
- Three new validators (background-only):
  - `schema-conformance` (full Zod parse against existing content; surfaces `warn` for content that bypassed the form)
  - `orphaned-locale-file`
  - `unused-fragment`
- Pinia store (`apps/admin/src/client/stores/validation.ts`) holds current issues
- Site tree dots in `SiteTree.vue` — colored circles next to items with issues
- "Site health" drawer (`apps/admin/src/client/components/SiteHealthDrawer.vue`):
  - Icon button in top toolbar (next to History)
  - Lists all current issues, grouped by item, sortable by severity
  - Click an issue → navigate to the affected item; banner shows the issue inline

**Tests:**
- Scanner: incremental rescan only re-runs affected items
- Cache: same content hash returns cached issues without re-validating
- API: returns current issues; pagination if needed
- Vue components: dots render correctly; drawer lists + filters; navigation focuses the affected field

**SOLID:**
- Scanner reuses validator instances from Cut 1; new orchestrator (full-site rather than delta)
- Cache invalidation is dependency-aware (uses existing sidecar machinery from media v1)
- SSE notification decouples scanner from UI: scanner pushes; UI pulls

**Risk:** medium-high. Cache invalidation is the load-bearing piece. Wrong invalidation = stale issues or perf cliff.

**What it doesn't catch yet:**
- Quality issues (a11y, HTML — Cut 3)
- altRequired (Cut 3)

### Cut 3 — Render-for-analysis + quality + altRequired (5 days)

**What ships:**
- "Render-for-analysis" service (`packages/gazetta/src/render-for-analysis.ts`):
  - Same renderer as preview/publish, no storage write
  - Returns `{ html, css, js }` per page
  - Caches by content hash + template hash + transitive-dependency hash + locale + theme
  - Reuses sidecar dependency tracking — fragment edit invalidates only pages using that fragment
- Three new validators using rendered output:
  - `accessibility` — axe-core via jsdom; ~50-100ms per page
  - `html-validity` — html-validate against rendered HTML
  - `altRequired` — walks the page's template schema, finds `embeddedAsset({ altRequired: true })` fields, resolves the effective alt for each ref, errors when null
- New dependencies: `axe-core`, `html-validate`, `jsdom`
- altRequired is `error` at save-delta + background; warns are not promoted (template author's intent IS the gate)
- Admin UI: new issue categories appear in the existing site-tree dots + Site health drawer (no new surface)

**Tests:**
- Render-for-analysis: returns same output as preview; cache hit on repeat calls; cache invalidation on dependency change
- axe-core integration: real fixture pages produce expected issues; rule subset is configurable
- html-validate integration: real fixture pages produce expected issues
- altRequired: schema-walks correctly; resolves ref → asset alt chain; flags null
- End-to-end: edit a page, scanner detects new a11y issue, drawer surfaces it

**SOLID:**
- Each validator wraps one external tool; tool-specific config isolated to that validator
- Render-for-analysis is its own module; validators consume the cached output
- altRequired's schema walker is a separate module from its validator implementation (testable independently)

**Risk:** high. Rendering is the heaviest CMS operation; doing it for analysis introduces a new performance characteristic. Cache must be correct.

**Mitigation:**
- Render-for-analysis runs in worker pool to avoid blocking the admin event loop (Node `worker_threads`)
- Cache aggressively; invalidation only on dependency changes
- Validators run in parallel against the same rendered output

### Cut 4 — Publish gate + broken-links (5 days)

**What ships:**
- Pre-publish audit step in publish dialog:
  - Shows consolidated `Issue[]` for items being published
  - Per issue: "Fix" / "Ignore once" / "Promote to error"
  - Block publish on remaining errors
- Per-target audit config: `targets.production.publishAudit: { strict: boolean }`
- One new validator, `broken-links`: every internal `href` or `src` in rendered output must match a page route or start with `/assets/` (or `assets/`), and anything else is reported (JSDOM parses the HTML). `/assets/` and `assets/` paths aren't checked until [#1301](https://github.com/gazetta-studio/gazetta-studio/issues/1301) lands. External links are skipped on purpose, and `?query` and `#hash` are stripped before matching, so #anchor targets aren't checked. It runs in the background scan, in the publish audit on every Publish from the admin, and in `gazetta validate --include-quality`. Decided: maintainer, 2026-10-24 (#1295). What the shipped publish dialog does differently from this plan is listed in `design-validation.md`, "Current code alignment".
- Admin UI: pre-publish modal in `PublishPanel.vue`

**Tests:**
- Operator config promotes warns to errors when `strict: true`
- "Ignore once" suppresses for current publish; doesn't persist
- Publish blocks on remaining errors

**Risk:** low. The check adds no dependency (JSDOM already ships for Cut 3's accessibility validator); the heavy work (pre-publish framework) is the same machinery Cut 3 already exercises.

**Why this is last:** these validators are valuable but not critical for daily editor UX. The publish gate earns its place at the operator's commitment moment; `broken-links` also runs in the background scan, so its warnings show in Site health before a publish ([#1303](https://github.com/gazetta-studio/gazetta-studio/issues/1303): Site health can miss a link broken by deleting the page it points at).

**Lighthouse not in scope.** Originally listed alongside linkinator as a Cut 4 validator; deferred indefinitely (see "What's deferred from this plan" below). Reason: accessibility is covered better by direct axe-core; SEO is covered by `seo-plan.md`'s primitives; the remaining performance + best-practices value doesn't justify the ~200MB Chromium + Lighthouse deps, the 5-15s per-page runtime, or the maintenance burden of tracking Lighthouse's evolving scoring methodology. Operators wanting performance budgets at publish use CI-side Lighthouse (`treosh/lighthouse-ci-action`) or PageSpeed Insights. The pre-publish audit framework supports adding a `lighthouse` validator later if concrete operator demand surfaces — it's one more validator slotting into the existing framework.

### Cut 5 — `gazetta validate` CLI rewrite (2 days)

**What ships:**
- `gazetta validate` runs all validators in non-interactive mode
- Output format: per-item ✓/✗ summary; full issue list with `--verbose`
- Flags:
  - `--severity error` (default) / `--severity warn` / `--severity all`
  - `--include-quality` — runs a11y + html-validate (off by default for speed)
  - `--no-warn-as-error` — exits 0 on warns; exits 1 only on errors
- Replaces existing ad-hoc walk in `cli/index.ts`

**Tests:**
- CLI exits 0 on clean site
- CLI exits 1 on errors
- `--include-quality` runs the heavier validators
- Output is greppable

**Risk:** low. The validators already exist; CLI is just a different orchestrator.

**Why this isn't earlier:** the CLI is more useful with quality validators (Cut 3). Without them, it's roughly what the existing `runValidate` already does.

### Cut 6 — Template-developer surfaces (3 days)

Per `design-validation.md`'s "DevPlayground Impact tab + transient
banner" surface — paired with the existing site-health drawer; this
cut adds the template-developer audience.

**What ships:**

Backend:
- CLI template watcher → `validationScanner.rescan({ kind: 'template', name })`
  on every `.ts/.tsx` change in `templates/{name}/`. The scanner already
  supports the `template` rescan cause (full-site rescan fallback per
  Cut 2's deferred items table); this cut wires the trigger.
- New admin API `GET /api/templates/:name/impact` returning items
  using the template (recursive walk: top-level + inline components in
  page/fragment manifests) plus their issues from the scanner store.
  Shape: `{ items: [{ kind, name, itemPath, issues }] }`.
- New SSE event `template-changed { name, affectedItemCount }` on the
  existing `/__validation` channel after a template-edit rescan
  completes. Banner consumes this.

Frontend:
- Pinia store `useTemplateImpactStore`: subscribes to `/__validation`,
  tracks the latest template-change event with auto-clear (60s timer
  + zero-impact-from-scanner clear).
- `TemplateChangedBanner.vue` in the admin shell toolbar — shows the
  banner when the store has an active event. Click → routes to
  `/admin/dev/editor/{name}` with the Impact tab pre-selected.
- DevPlayground gains an "Impact" tab in the right detail pane
  alongside the existing schema/preview view. Tab lists items using
  the selected template with ✓/⚠/✗ severity icons. Click-to-edit
  reuses the existing ValidationBanner field-focus.

**Migrate affordance — deferred:**

Per the design's "Migrate" reservation: the impact panel does NOT ship
a "Migrate" button in v1. Schema migrations are too feature-specific
to automate generically (every schema change has its own translation
rule: rename, default-fill, type-widen, restructure). Future direction
per `design-ai.md`'s extension surface — schema migrations are a
natural AI-task ("translate this content to match the new schema") and
land when the AI infrastructure has its second consumer beyond
alt-text. Reserved seam: the impact panel's row buttons today say
"Edit" (which navigates to the page); a future "Migrate with AI"
button slots in adjacent without redesigning the panel.

**Tests:**

Backend:
- Template-edit triggers scanner rescan with `kind: 'template'`
- `GET /api/templates/:name/impact` returns the right items + their
  issues; recursive component walk catches nested inline templates
- SSE event fires after template-edit rescan completes

Frontend:
- Store handles SSE event; auto-clears at 60s; auto-clears when
  scanner reports zero impact
- Banner renders + dismisses; click navigates correctly
- Impact tab fetches + renders the list with severity icons
- Click-to-edit on an issue row navigates to the affected item

**Risk:** low-medium. The infrastructure exists by Cut 6; this is
mostly UI work + one new API. The DevPlayground integration is the
load-bearing change — the existing playground is template-developer
turf, so adding to it is structurally cheaper than building a
parallel `/admin/templates` surface.

**Why this is last:** it's a power-user feature for template
developers, not a daily-author concern. Most daily author workflows
don't trigger it. Daily authors see schema-conformance issues via
the existing site-health drawer (no Cut 6 dependency).

## What's deferred from this plan

| Item | Trigger to revisit |
|---|---|
| Issue suppression mechanism (`_suppressions: {...}`) | Authors ask for "ignore this issue" persistently |
| Per-validator severity override (vs. coarse strict flag) | Operators ask for per-rule control |
| Custom validators (site authors plug in their own) | Concrete operator use case for site-specific rules |
| `css-validity` (stylelint) | Lower priority than a11y/HTML; ship in a follow-up |
| Outbound link checking (linkinator) | Concrete demand |
| #anchor targets (links to an `id` on a page) | Concrete demand; [#1272](https://github.com/gazetta-studio/gazetta-studio/issues/1272) if the docs site needs anchor checks |
| `lighthouse` validator (performance + best-practices + Lighthouse-flavored a11y/SEO) | Concrete operator demand for "gate publish on perf budget" OR a measured regression on real Gazetta sites that other validators didn't catch. Until then: operators run Lighthouse in CI (`treosh/lighthouse-ci-action`) or via PageSpeed Insights. Cost of shipping speculatively: ~200MB of Chromium + Lighthouse deps, 5-15s per page at publish, maintenance burden tracking scoring methodology changes (e.g., FID→INP in 2024). Accessibility already covered by direct axe-core; SEO by `seo-plan.md` primitives. |
| Performance budget gates (LCP, CLS) | Bundled with the `lighthouse` validator decision above. |
| Cross-content validation (e.g., "every page has a meta description") | Authors ask |
| `template-deps` reverse-dep sidecar relation (peer to `fragment-deps` / `asset-refs`) | Concrete demand for incremental invalidation on template edits — from validation scanner OR publish flow's "items affected by template change". v1 falls back to full-site rescan; template edits are rare relative to content edits. Mechanical to add when needed (one new `DepRelation` binding + save/publish writers + reindex CLI handler). |
| **Target-side validation** (validate published HTML on a target, not just source) | Concrete operator demand from drift scenarios — direct-to-prod edits via `editable: true`, multi-region targets diverging, "is what's actually live OK?" dashboards. v1 validates source: render-for-analysis re-renders source content + scans the result. Target-side validation is a different surface (forensic, operator-facing, not author-facing). Trigger: 3+ operator reports of drift surprise OR a compliance ask for "validate live content." Likely shape: peer scanner reading published HTML directly from target storage, surfaced in a separate "Target health" drawer alongside source's "Site health". Cut 4's publish gate already provides pre-publish coverage at the most common moment authors want it. |

Outbound link checking and #anchor targets: Decided: maintainer, 2026-10-24 (#1295). Their triggers follow from that decision.

## Open implementation questions

1. **Sidecar machinery integration — locked.** Pre-flight against the shipped code (2026-05) confirmed: fragment-edit invalidation reuses `findDependentsFromSidecars(sourceRoot, { fragment })` from [publish.ts](../../packages/gazetta/src/publish.ts); asset-edit invalidation uses `readRefsForAsset(contentRoot, name)` from [assets/asset-deps.ts](../../packages/gazetta/src/assets/asset-deps.ts) — both ship with the right shape, no extension needed. Template-edit invalidation falls back to full-site rescan because no `template-deps` reverse-dep relation ships (only `fragment-deps` and `asset-refs` exist as `DepRelation` bindings). See "Deferred from Cut 2" below.

2. **Worker thread for render-for-analysis.** Investigate Node `worker_threads` vs. spawning a separate Node process. Worker threads share memory (good for the template registry); spawning is more isolation but slower init. Likely worker threads.

3. **axe-core ruleset configuration.** axe-core ships ~90 rules; some are noisy (e.g., color-contrast on dynamic content). Pick a sensible default subset; expose via `site.config.ts` for operator customization.

4. **Test pages for quality validators.** Need fixture pages with known issues (`<img>` no alt, broken HTML, contrast fails) to validate the integration. Build small `tests/fixtures/quality-pages/` directory.

5. **SSE channel for validation issues — locked.** New `/__validation` channel, scoped to `gazetta dev` only. Rationale: `/__reload` (defined at [cli/index.ts:1536](../../packages/gazetta/src/cli/index.ts#L1536)) drives full preview-iframe reload; piggybacking validation events would force unnecessary preview reloads on every scanner pass. Production (`gazetta serve`) has the route stubbed at 204 — admin store fetches `/api/validation/issues` on load and on save; no SSE-driven push needed.

6. **Render-for-analysis vs. preview path.** Preview already renders per-request; render-for-analysis caches. Worth unifying eventually so authors get consistent output. Don't unify in Cut 3 — wait for the seam to stabilize.

## Estimates

Wall-clock for solo dev. Real pace depends on what you hit.

| Cut | Estimate |
|---|---|
| Cut 1 — Save-delta + 5 validators | 4 days |
| Cut 2 — Background scanner + UI | 4 days |
| Cut 3 — Render-for-analysis + a11y + html + altRequired | 5 days |
| Cut 4 — Publish gate + broken-links | 5 days |
| Cut 5 — CLI rewrite | 2 days |
| Cut 6 — Template-developer surfaces | 3 days |

With CI iteration, review feedback, and integration discoveries, budget 1.5x the raw estimate per cut.

## SOLID checks per cut

Each cut's SOLID posture, validated at design time:

- **Cut 1**: SRP per validator. OCP via the `Validator` registry — adding a new ref-existence validator is additive. LSP across validator implementations. DIP — route handler depends on `runSaveDelta`, not on validators directly.

- **Cut 2**: SRP — scanner orchestrates; cache is its own concern; validators are unchanged. OCP — new background-only validators slot in. DIP — UI consumes the Pinia store, not the scanner directly.

- **Cut 3**: SRP — render-for-analysis is its own module; each tool-wrapper validator is its own module. OCP — new tool wrappers add Validators without changing infrastructure. ISP — validators see only the `RenderedOutputAccess` they need.

- **Cut 4**: SRP — publish gate is one orchestrator; per-target config is its own concern. OCP — new heavy validators add to the registry; each declares the stages it runs at, and `gazetta validate` runs the quality ones only with `--include-quality`. Decided: maintainer, 2026-10-24 (#1295).

- **Cut 5**: SRP — CLI runner is its own module that calls the same validator runners as the admin server.

- **Cut 6**: SRP — template-watcher is its own concern; UI surface is its own component.

Any cut failing SOLID review at PR time is a structural correction (per [team-preferences.md rule 18](team-preferences.md)), not a patch.

## Migration

### Existing sites

No config required for Cut 1-3. Validators run with default severities; existing content that's broken surfaces as warns/errors but doesn't block save (only newly-introduced breaks block).

### `gazetta validate` users

Cut 5 changes the output format. Document migration in `docs/cli.md` when it ships.

### Template developers

Cut 6 changes how schema changes are surfaced. New panel; existing flow unchanged.

## Why this shape

**Phased so each cut is independently valuable.** Cut 1 alone (4 days) catches the most painful "I broke something" cases. Stopping there is acceptable.

**Real tools, not reimplementation.** axe-core and html-validate; linkinator, for outbound links, is deferred. Each plugs into the validator interface. CMS owns scheduling, surfacing, and incremental scope; tools own the analysis.

**Save stays fast.** Cut 1's save-delta only checks introduced refs; everything else is the background scanner. Authors aren't punished for accumulated debt.

**Publish gate is operator-controlled.** Strict workflows enable; loose workflows skip. The CMS doesn't impose a one-size-fits-all severity.

**Surfaces match commitment levels.** Banner (save), drawer (background), modal (publish). Each is its own visual weight. Authors learn one new surface per cut.

# Validation

How the CMS surfaces correctness, integrity, and quality issues to authors and operators. Designed around the editor-UX principle that detection point should match author commitment level — not "everything is checked at every gate."

**This doc covers the design:** four-phase model, validator abstraction, severity model, surfaces, what's in/out of scope, distinctive choices.

**Companion docs:**
- [design-validation-implementation.md](design-validation-implementation.md) — phased cut sequence, scope, deferred items, build order.

## Scope

**The final goal:** content that ships produces valid, accessible, performant HTML/CSS/JS. The validation system exists to surface deviations from that goal at the earliest cheap detection point that matches author intent.

**In v1.5:**
- Phase-aware validator abstraction (`Validator` interface + `Issue[]` shape)
- Save-delta validation (block save on refs the current edit just broke)
- Background scanner (continuous visibility into accumulated issues across the site)
- Quality validators using real tools (axe-core, html-validate) against rendered output
- Pre-publish gate with operator-controlled strictness
- `gazetta validate` CLI as a non-interactive run of the same validators

**Out of scope:**
- Real-time keystroke validation (already covered by @rjsf's Zod-driven form layer)
- Reimplementing accessibility / HTML / CSS analysis (use real tools — axe-core, html-validate, stylelint, and linkinator for outbound links — under the abstraction)
- A "site SEO score" or content scoring (per [seo-plan.md](seo-plan.md): weakly correlated with rankings, encourages over-optimization)
- Blocking save on accumulated pre-existing issues (hostile UX; the background scanner surfaces them visibly without blocking)
- Server-side keystroke validation (the form layer is sufficient)

## The four-phase model

The load-bearing principle: **detection point should match author commitment level.** A keystroke is not a commitment; a save is light commitment; the background is observational; publishing is the firm commitment. Each phase has its own surface, severity, and timing.

| Phase | Trigger | Severity | Surface | Latency budget |
|---|---|---|---|---|
| **1. Format** | Field blur / 300ms idle keystroke | Block field commit | Inline next to field | <100ms |
| **2. Integrity** | Save click | Block save when this edit introduced the break | Banner + focus-to-first-error | <3s |
| **3. Quality** | Background, after save | Inform | Site-tree dots + "Site health" drawer | Async; minutes OK |
| **4. Publish gate** | Publish click | Configured by operator | Pre-publish modal with fix/ignore/override | Pre-commit |

This maps directly onto how successful tools (Sanity, Payload, GitHub PR review) handle validation — the best ones keep phases **distinct** rather than blending them. Where they fall short: their quality surfaces are weak or absent. Gazetta's render pipeline + per-target `editable` flag give it a structural advantage other CMSes don't have.

### Why phase-separation matters

Real-time validation on every keystroke increases user errors per [UX research](https://uxmovement.com/forms/why-users-make-more-errors-with-instant-inline-validation/) — authors are distracted by flashing errors while still composing. Aggregating unrelated issues in one giant list makes authors tune out. Conflating "draft" with "valid" forces premature commitment.

Each phase exists for a real reason:
- **Format** is for the author who's typing — fix it now while in flow
- **Integrity** is for the author who's pausing — what did *I* just break?
- **Quality** is for the author who's working — what's the holistic state?
- **Publish gate** is for the operator who's committing — am I about to ship something broken?

Mashing them produces hostile UX. Keeping them separate is the design.

### Why save-delta, not save-full

The integrity phase blocks save **only** on issues introduced by the current edit. If the page already had a missing-asset reference before the author touched it, that's the **background scanner's** problem to surface, not the save handler's.

Rationale:
- Matches author intent: "I touched this; tell me what I broke" — not "tell me about everything that's been broken since I started this morning"
- Avoids blocking on debt the author can't fix now (different author created it; templates changed; assets got deleted out-of-band)
- Keeps save fast: O(diff) instead of O(site)
- Catches the realistic introduction paths: hand-editing JSON, programmatic content imports, custom CLI flows

The background scanner surfaces the rest, visibly but non-blockingly.

### Why the publish gate is distinct from save

In Gazetta's stateless model, **the local target IS the draft**. `editable: true` on local; `editable: false` (default) on staging/prod. That's the natural draft/published boundary already encoded in the data model.

Save commits to the local target — incomplete is fine. Publish commits to a non-local target — that's the operator's "ship it" moment. Gating quality there matches existing semantics; gating it at save would force the author into commitment they didn't intend.

This also means: configured strictness lives at the publish gate. Operators with strict workflows enable quality gates at publish; operators with loose workflows don't. The save handler stays uniform.

## The Validator abstraction

One interface; many implementations; multiple entry points consume the same validators.

```ts
export interface Validator {
  /** Stable identifier for diagnostics ('referenced-asset-exists', 'accessibility'). */
  readonly name: string

  /** Which lifecycle stages this validator runs at. */
  readonly stages: readonly ValidationStage[]

  /** Default severity per stage. Operators may promote/demote at the publish gate. */
  defaultSeverity(stage: ValidationStage): Severity

  /** Run the validator. Returns issues; never throws on validation failure. */
  validate(input: ValidatorInput): Promise<Issue[]>
}

export type ValidationStage =
  | 'save-delta'        // diff incoming vs. existing manifest; check only new refs
  | 'background'        // continuous full-site scan
  | 'pre-publish'       // run before publish; can be heavy
  | 'cli'               // gazetta validate non-interactive

export type Severity = 'error' | 'warn' | 'info'

export interface ValidatorInput {
  stage: ValidationStage
  site: Site
  contentRoot: ContentRoot
  storage: StorageProvider
  templates: TemplateRegistry
  /** Scope is stage-specific:
   *   - save-delta: { item, before, after }
   *   - background: { item } iterated by the scanner
   *   - pre-publish: { items: published-set }
   *   - cli: site-wide
   */
  scope: ValidatorScope
  /** Cached rendered HTML when available (background, pre-publish). */
  renderedOutput?: RenderedOutputAccess
}

export interface Issue {
  validator: string
  severity: Severity
  /** Human-readable message. Author-facing. */
  message: string
  /** Item path like `pages/home/page.json`. */
  itemPath: string
  /** Content-tree path within the manifest, when applicable. */
  contentPath?: string
  /** Optional structured suppression hint — `Issue.suppressible: true`
   *  means a future "ignore this issue" mechanism would apply. */
  suppressible?: boolean
}
```

### What stages look like in practice

- **save-delta**: PUT /api/pages/:name diffs incoming vs. existing manifest. Validators run only against the introduced refs (new `_asset`, new `@fragment`, new component template). 409 with `Issue[]` body if any error-severity issues; 200 otherwise. Fast.

- **background**: Admin server runs a long-lived scanner. Initial scan on admin boot. Incremental rescan when file watcher detects manifest/template/asset changes. Per-page validation run cached by content hash; only re-runs when something material changed. Issues stored in a Pinia store, surfaced in the UI.

- **pre-publish**: The admin runs the audit on every Publish, and the server runs it again before publishing. Decided: maintainer, 2026-10-24 (#1295). Operator sees consolidated `Issue[]` with severity per their target's config. Fix / ignore / promote-to-error per issue. Block publish on remaining errors. (The heavy-validator slot — originally Lighthouse — is intentionally empty; see implementation-doc deferred-items table.)

- **cli**: `gazetta validate` runs all validators in non-interactive mode. Exit non-zero on any error. Useful for CI gating before deploy.

The shipped publish audit differs from this in several ways; see "Current code alignment".

### Stage × validator matrix

| Validator | save-delta | background | pre-publish | cli |
|---|---|---|---|---|
| `referenced-asset-exists` | ✓ error | ✓ error | ✓ error | ✓ error |
| `referenced-fragment-exists` | ✓ error | ✓ error | ✓ error | ✓ error |
| `referenced-template-exists` | ✓ error | ✓ error | ✓ error | ✓ error |
| `circular-fragment` | ✓ error | ✓ error | ✓ error | ✓ error |
| `dynamic-route-conflict` | ✓ error | ✓ error | ✓ error | ✓ error |
| `schema-conformance` | — | ✓ warn | ✓ error | ✓ warn |
| `altRequired` | ✓ error (when introduced) | ✓ error | ✓ error | ✓ error |
| `accessibility` (axe-core) | — | ✓ warn | ✓ warn (operator promotes) | ✓ warn |
| `html-validity` (html-validate) | — | ✓ warn | ✓ warn | ✓ warn |
| `css-validity` (stylelint) | — | ✓ info | ✓ warn | ✓ warn |
| `broken-links` (internal links) | — | ✓ warn | ✓ warn | ✓ warn (`--include-quality`) |
| `orphaned-locale-file` | — | ✓ warn | — | ✓ warn |
| `unused-fragment` | — | ✓ info | — | ✓ info |

`broken-links` runs for every page in the background scan and on every Publish from the admin; [#1294](https://github.com/gazetta-studio/gazetta-studio/issues/1294) tracks its cost. What the shipped publish dialog does with its warnings is under "Current code alignment".

Decided: maintainer, 2026-10-24 (#1295)

| Rejected | Why |
|---|---|
| Make it opt-in in code, as these docs said before | Sites that don't opt in would get no broken-link warnings, and #1294's fix brings the cost to about 3 ms a page |

**Why save-delta has so few entries:** the save handler should be fast and narrow. Reference-existence checks run; everything else is the background scanner's job.

**Why some validators have `—` at save-delta:** they need full-site context (orphaned-locale-file) or rendered output (a11y, html-validity) — neither of which is available cheaply at save.

## Surfaces

Four distinct UI surfaces, each tied to a phase or audience:

### Banner (save-time integrity)

When PUT returns 409 with `Issue[]`, the editor shows a dismissible banner at the top of the form with the issue list and a "focus" action that scrolls to the offending field. Save button stays disabled until issues clear.

**Visual weight:** high. Red. Author needs to act now.

**Scope:** only issues introduced by THIS save. Pre-existing issues NEVER appear here.

### Site tree dots + "Site health" drawer (background)

Site tree shows colored dots next to items with issues:
- Red dot — error-severity issue
- Amber dot — warn-severity issue
- (No dot for info-severity to avoid noise)

A "Site health" drawer (closed by default; icon in top bar) lists all current issues across the site, grouped by item, sortable by severity. Click an issue to navigate to the affected item with the relevant field highlighted.

**Visual weight:** ambient. Authors see what's broken; nothing blocks.

**Scope:** all current issues across the entire site.

### Pre-publish modal (publish gate)

Existing publish dialog gains a "Pre-publish audit" step before the destination picker. Shows the list of issues that would apply to the items being published. Per issue: "Fix" (jump to item), "Ignore" (mark as known-acceptable for this publish), "Promote to error" (block publish on this).

Operator-configurable per target: `targets.production.publishAudit: { strict: true }` promotes all warns to errors.

**Visual weight:** modal — operator is committing.

**Scope:** items being published × their issues × target config.

### DevPlayground Impact tab + transient banner (template-developer)

For template developers (the ones editing `templates/{name}/index.tsx`),
neither the save-banner nor the site-health drawer is the right surface.
Their workflow lives in their IDE, not the admin form. They edit a
template's schema, hot-reload fires, and they want to know: did I break
any content?

Two paired surfaces give them the answer:

- **Transient toolbar banner** — when the dev server's template watcher
  fires, the scanner rescans (template-edit invalidation) and the
  admin pushes an SSE `template-changed { name, affectedItemCount }`
  event. The toolbar shows: "Template `hero` changed — 2 items
  affected. View impact →." Click navigates to the DevPlayground for
  that template. Auto-clears after 60s OR when scanner reports zero
  affected items, whichever first. Single-slot — newer template
  changes overwrite older ones; the older items' impact is still
  available via the site-health drawer's accumulated issues.

- **DevPlayground Impact tab** — the existing dev playground (which
  already lists templates + custom editors + fields, Storybook-style)
  gains an "Impact" tab in the right detail pane alongside the
  schema/preview view. The tab lists all items that use the selected
  template — pages first, then fragments, then nested inline
  components — with per-item ✓/⚠/✗ severity icons. Click-to-edit
  navigates to the affected item; the existing site-health drawer's
  field-focus mechanism (Cut 1's `ValidationBanner`) takes over from
  there. "Migrate" affordance per item is reserved for a future
  AI-task surface (per `design-ai.md`'s extension model — schema
  migrations are too feature-specific to automate generically; the
  AI seam is the right home when concrete demand surfaces).

**Visual weight:** ambient banner + on-demand tab. Banner only
appears in response to template edits; tab only matters when a
developer is in the DevPlayground.

**Scope:** one template at a time × all items that use it × their
issues. Banner shows the count; tab shows the list.

**Why this surface earns its place:** template developers are a
distinct audience from content authors. Folding their needs into the
site-health drawer would force them to filter by template manually
on every edit; folding the impact view into the editor would put
template-developer concerns in the daily-author chrome.

## Severity

Three levels:

- **`error`** — blocking at the gate where it appears. Save blocks on save-delta errors; publish blocks on pre-publish errors.
- **`warn`** — non-blocking; surfaced in UI; CLI exits non-zero by default but `--no-warn-as-error` flag tolerates.
- **`info`** — visible in detailed views; not surfaced by default; never blocks.

The severity is **per-stage**. The same validator can warn at background but error at pre-publish. Operators promote or demote at the publish-gate config.

## Quality validators: integrate, don't reimplement

The architectural call: use real tools for the actual analysis. Each tool plugs in via the `Validator` interface; the CMS owns scheduling, surfacing, and incremental scope.

| Domain | Tool | Engine notes |
|---|---|---|
| Accessibility | `axe-core` | Run via `jsdom` in admin process; ~50-100ms per page. Battle-tested by every major a11y product. |
| HTML validity | `html-validate` | Fast, configurable, widely used in CI. |
| CSS lint | `stylelint` | Industry standard. |
| Broken links | Gazetta's own route matching (`jsdom` parses the HTML) | Every internal `href` or `src` in rendered output (on `a`, `link`, `img`, `source`, `video`, `audio` and `script`) must match a page route, including `:param` routes, or start with `/assets/` (or `assets/`); anything else is reported, such as the scaffold's `/admin` link ([#1183](https://github.com/gazetta-studio/gazetta-studio/issues/1183)). `/assets/` and `assets/` paths aren't checked yet. External links are skipped on purpose; `?query` and `#hash` are stripped before matching. |

The broken-links check covers internal links only. Outbound link checking (`linkinator`) and #anchor targets are deferred (`design-validation-implementation.md`, "What's deferred from this plan").

Decided: maintainer, 2026-10-24 (#1295)

| Rejected | Why |
|---|---|
| Change the code: add outbound and #anchor checks now | Outbound checks need a request to every external URL in each check, and a new dependency (`linkinator` is in no package today); #1272 can pull anchor checks in when the docs site needs them |
| File an issue and decide later | The docs would keep describing a check that doesn't exist |

Links to `/assets/` paths will be checked too: [#1301](https://github.com/gazetta-studio/gazetta-studio/issues/1301) reports at least the `__missing__` placeholder a page renders when it references an asset that doesn't exist. Until it lands, any `/assets/` or `assets/` path passes.

Decided: maintainer, 2026-10-24 (#1295)

| Rejected | Why |
|---|---|
| Defer it, like outbound links and #anchors | `/assets/` links written into content would stay unchecked, and until [#1302](https://github.com/gazetta-studio/gazetta-studio/issues/1302) is fixed nothing at publish reports a missing asset reference |
| Leave it as documented, with no deferred row | The same gap, with no deferred row or issue to come back to it |

Lighthouse was originally specced for the "Performance / SEO score" slot but is deferred indefinitely (see `design-validation-implementation.md` deferred-items table). Reasoning: accessibility is covered better by direct axe-core; SEO by `seo-plan.md`'s primitives; the remaining performance + best-practices value doesn't justify the ~200MB Chromium + Lighthouse deps, the 5-15s per-page runtime, and the maintenance burden of tracking scoring methodology changes. Operators wanting publish-time perf budgets use CI-side Lighthouse. The pre-publish audit framework supports adding the validator later if concrete demand surfaces.

Why this is the right move:
- These tools encode decades of domain expertise; any in-house validator would be strictly worse
- Issues from real tools carry credibility (authors don't argue with axe-core results)
- Tool versions can be pinned and updated independently of Gazetta
- The CMS focuses on **integration** — scheduling, scope, surfacing, fix-it actions — which is the real CMS work

What we DON'T do:
- Reimplement a11y rules
- Build a Yoast-style content score (rejected per [seo-plan.md](seo-plan.md))
- Ship Lighthouse as a built-in validator (deferred indefinitely; see implementation-doc deferred-items table for reasoning + revisit trigger)

## Render-for-analysis

Quality validators need rendered HTML/CSS to do their job. Gazetta already has a render pipeline (preview + publish). The validator framework exposes a "render-for-analysis" entry point that:

- Calls the same renderer used for preview/publish
- Returns rendered HTML/CSS/JS without writing to storage
- Caches by content hash + template hash + locale; re-renders only when something material changed
- Reuses the existing dependency-aware sidecar machinery (`findDependentsFromSidecars`) so a fragment edit only invalidates pages that use that fragment

This is a Gazetta-specific advantage other CMSes don't have. Most CMSes either:
- Don't have a render pipeline (headless-only) and force authors to wait for deploy
- Have one but it's coupled to publish (no analysis-only render path)
- Have one but no dependency-aware caching (re-render everything every time)

Gazetta's incremental sidecar tracking makes per-page quality validation cheap at scale.

## Distinctive choices

### Phase separation, not unification

Most CMSes blur the lines: validation rules fire at every gate, surfaces overlap, severity is one-dimensional. Gazetta keeps four distinct phases with three distinct surfaces, each matching a real author commitment level.

### Save-delta, not save-full

The save handler only blocks on what THIS save introduced. The accumulated state is the background scanner's surface. Authors aren't held responsible for debt they didn't create.

### Local target IS the draft

Other CMSes invent draft/published as a separate concept. Gazetta's `target.editable` already encodes commitment level — local is the draft, prod is the publish. Phase 4 (publish gate) maps onto this naturally without inventing new vocabulary.

### Quality validators integrate real tools

Don't reimplement axe-core. Don't write a Yoast clone. The CMS schedules and surfaces; the tools analyze. Each tool is one Validator implementation behind the same interface.

### Suppression is structural, not field-level

Issues carry a `suppressible: true` hint. Suppression itself is a future operation (operator says "ignore this rule for this content"); designing the field in from day one means we don't retrofit.

### Operator-configurable publish gates

Per-target `publishAudit` config controls whether quality warns block publish. Strict workflows enable; loose workflows skip. The CMS doesn't impose a one-size-fits-all severity.

## Foundational checks

Validation is itself foundational dimension #9 of 13. This section answers how each of the other 12 foundational dimensions and the multi-instance discipline compose with the validation system, per [`feature-design-process.md`](feature-design-process.md) "Foundational dimensions."

- **Multi-instance check** (discipline) — save-delta runs on the instance receiving the save request; no cross-instance coordination. Background scanner (Cut 2) per-page cache is per-admin-instance (each instance scans + caches independently); the multi-instance pattern is "every instance reads source-of-truth from storage on demand, caches results in-process, no cross-instance cache sharing." Per-page content-hash cache key ensures different instances arrive at the same cached result without coordination. Suppression state (when shipped) lives in storage, not in-memory.

- **Scale check** — save-delta is O(diff) per save; only checks refs introduced by THIS save, not the full site. Background scanner (Cut 2) caches per-page validation results by content hash; only re-validates when something material changed. Cut 4's broken-links check runs for every page in the background scan and on every Publish from the admin. It fetches no URLs: it matches internal links against the loaded site's routes ([#1294](https://github.com/gazetta-studio/gazetta-studio/issues/1294) tracks a per-link cost that grows with site size). Decided: maintainer, 2026-10-24 (#1295). The framework scales because phase-separation matches detection cost to author commitment level. Gates: Cut 2 must reuse the existing sidecar dependency tracking (`findDependentsFromSidecars`) so a fragment edit only invalidates pages that use that fragment.

- **Theme check** — validation runs against rendered output for quality validators (Cut 3 axe-core, html-validate). Render-for-analysis composes with the active theme: when themes ship per [`design-themes.md`](design-themes.md), render-for-analysis renders per-(content, locale, theme) tuple, and validators see theme-specific output. Cache key includes theme. v1 (single-theme world): no impact.

- **Locale check** — validators receive the manifest in its declared locale. Locale-variant manifests (page.fr.json) are validated as their own item, not as deltas against the default locale. Per-locale validation cache. The `altRequired` validator (Cut 3) walks the schema for the locale being validated. RTL: validators don't have a UI, so RTL is N/A here; the banner UI follows admin-wide RTL contracts per [`design-i18n.md`](design-i18n.md).

- **Team check** — validators are infrastructure; they don't gate on roles. The save-delta gate runs for every author. Issue surfaces (banner, drawer, publish modal) gate on read-access to the affected content per [`design-auth-rbac.md`](design-auth-rbac.md) — an editor without page X read access doesn't see issues for page X. Audit log (per [`design-audit.md`](design-audit.md)) records every save attempt including 409 VALIDATION_FAILED responses. Review workflows (per [`design-review-workflow.md`](design-review-workflow.md)) read validation state — a "ready for review" transition can require zero open errors on the item.

- **Hook check** — validators do NOT fire hooks. They're pure functions over a manifest; firing hooks during validation would create circular dependencies (a hook that runs a validator that fires a hook). Hooks at save time fire AFTER validation passes — the save handler validates first, hooks observe the resulting save. Per [`design-hooks.md`](design-hooks.md). Validators that compose with hook-driven enrichment (e.g., a validator that checks the result of an auto-slugify hook) read the post-hook manifest, which is already what the validator gets.

- **Render check** — Cut 3's render-for-analysis IS a render mode. It's the same renderer used for preview/publish, with output captured in-memory rather than written to storage. Composes with [`design-rendering.md`](design-rendering.md)'s mode taxonomy: validators that need rendered HTML opt in via `RenderedOutputAccess`; validators that work on the manifest alone (the 5 ref-existence validators in Cut 1) don't. Request-time SSR: when shipped, dynamic components SSR per request, so validation runs against a representative request context (or the static fallback when one isn't available).

- **Plugin check** — validators are an extension surface. The `Validator` interface is the contract; the registry (`packages/gazetta/src/validation/registry.ts`) is the discovery mechanism. Cut 1 ships 5 in-tree validators registered via `defaultValidatorRegistry()`. Future plugin contract per [`design-plugins.md`](design-plugins.md) extends the registry with npm-packaged validators — same interface, additional discovery path. The registry pattern is foundational specifically so Cut 2+ and plugin-contributed validators slot in without changing orchestrator code.

- **Cache check** — Cut 1 (save-delta) is uncached: each save runs validators against the incoming manifest fresh. Cut 2 (background scanner) caches per-page validation results by content hash; cache key includes content + dependency hashes per `design-cache.md`. Cut 3 render-for-analysis caches rendered HTML by content + template + transitive-dependency hash. All caching goes through `AdminCache` once the design pass formalizes the abstraction; v1 cuts use per-instance memory cache via `MemoryCache` provider.

- **Offline check** — save-delta validation runs locally during offline (validators are pure functions over a manifest; no server roundtrip required). Issues surface in the standard banner. Background scanner (Cut 2) pauses while offline; resumes on reconnect with incremental rescan. Render-for-analysis (Cut 3) serves last-cached output; staleness indicator visible in surfaced issues. Per `design-offline.md`.

## Current code alignment

Where the shipped publish audit differs from this design, read from code on 2026-10-24: a list to reconcile or accept (`feature-design-process.md`, "Keeping design docs aligned with reality").

Decided: maintainer, 2026-10-24 (#1295)

| Rejected | Why |
|---|---|
| Rewrite the design to describe the shipped dialog | Several differences are bugs (#1328, #1302, #1329); a design written around them would lock the gaps in |

| Design | Shipped code | Status |
|---|---|---|
| The pre-publish modal offers Fix, Ignore once and Promote to error per issue | Ignore once only, for warnings | Open |
| The modal shows the audit's issues before publishing | When the dialog's audit finds no errors, it publishes without showing its warnings; they show in Site health, which can miss a link broken by deleting the page it points at ([#1303](https://github.com/gazetta-studio/gazetta-studio/issues/1303)). When it finds an error on any destination, it shows every destination's issues, and each warning must be ignored before publishing. The server gate blocks only on errors; `publishAudit.strict` turns a destination's warnings into errors | Kept for now (below) |
| The admin runs the audit on every Publish | After the confirmation a production destination asks for, the dialog's audit doesn't run; only the server's gate does, so only its errors show | Bug: [#1328](https://github.com/gazetta-studio/gazetta-studio/issues/1328). Decided: maintainer, 2026-10-24 (#1295) |
| The matrix's validators run at pre-publish | Only accessibility, html-validity and broken-links handle the pre-publish stage, and all three only warn. The other twelve that declare it return nothing there, so nothing blocks a publish to a destination without `publishAudit.strict` | Bug: [#1302](https://github.com/gazetta-studio/gazetta-studio/issues/1302) |
| Pre-publish checks the items being published | Translations (`pages/<name>:<locale>`) are dropped, and pages are rendered in the default language only | Bug: [#1329](https://github.com/gazetta-studio/gazetta-studio/issues/1329) |
| The server's gate audits what is published | The gate, the render and the manifest copy each read the source separately, so a save during a publish can go out unaudited | Decided: one snapshot per publish ([#1527](https://github.com/gazetta-studio/gazetta-studio/issues/1527); `design-publish-undo.md` Q4, cut 7) |
| Not settled | The pages that use a published fragment aren't audited, although static targets republish them | Question: [#1331](https://github.com/gazetta-studio/gazetta-studio/issues/1331) |

Warning-only audits publishing without showing their warnings is kept for now, with no code change. Decided: maintainer, 2026-10-24 (#1295)

| Rejected | Why |
|---|---|
| Show warning-only results in the dialog before publishing | One more click on every publish whose audit finds warnings |
| Run `broken-links` at publish only on strict targets | It would change where the check runs (the stage matrix), and #1294's fix brings its cost to about 3 ms a page |

The production confirmation skipping the dialog's audit is a bug (#1328). Decided: maintainer, 2026-10-24 (#1295)

| Rejected | Why |
|---|---|
| Keep it, and document that production publishes rely on the server's gate alone | The code's own comment says the audit runs after the confirmation |

## Migration

### Existing sites

Sites without any AI/validation config continue to work — validators run with default severities; no errors are introduced retroactively unless content was already broken (in which case authors needed to know).

### Existing `gazetta validate` behavior

The command is rewritten to run all validators in non-interactive mode. Output format stays roughly the same (per-item ✓/✗ summary). Adds new categories (a11y, html-validity) behind `--include-quality` flag (off by default for speed; CI opts in).

### Editor UX migration

Authors see new surfaces gradually:
- Cut 1 ships: save-time banner appears when an edit breaks a ref. Familiar pattern, low cognitive load.
- Cut 2 ships: site-tree dots and Site health drawer appear. Authors learn the "ambient visibility" pattern.
- Cut 3 ships: dots and drawer surface a11y/HTML/CSS issues alongside ref issues. No new UI; same surface.
- Cut 4 ships: publish dialog gains the audit step. Operators see the new modal at publish time.

Each cut is independently shippable; authors learn one new surface per ship.

## Open questions

1. **Rendered-output caching key.** Content hash + template hash + locale + theme is the obvious key, but: when a referenced fragment changes, every page using that fragment needs re-render-for-analysis. The sidecar dependency tracking knows the affected set; the cache key needs to incorporate the transitive dependency hash. Worth building correctly the first time.

2. **Severity promotion at the publish gate.** Per-target `publishAudit.strict` is a coarse switch. Per-validator override (`publishAudit.accessibility: error`) is cleaner. Compromise: ship the coarse switch in Cut 4; per-validator override lands when an operator asks.

3. **Background scanner cost on huge sites.** A 5000-page site running axe + html-validate on every fragment edit could take minutes. Mitigation already exists (dependency-aware re-validation); needs to be wired correctly.

4. **Suppression UX.** When an author wants to silence a specific issue ("I know this image is decorative even though axe doesn't"), where does the suppression live? Options: per-content (in the manifest as `_suppressions: {...}`), per-asset (on the asset manifest), per-site (in `site.config.ts`). Each has different scoping characteristics. Defer designing until authors actually ask.

5. **Validator versioning.** axe-core releases new rules; sites that pass today might fail tomorrow. Pin versions; document update policy. Same as the AI alt refusal-marker maintenance question.

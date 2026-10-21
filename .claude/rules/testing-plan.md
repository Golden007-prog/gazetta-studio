---
paths:
  - "**/*.test.ts"
  - "tests/e2e/**"
  - "packages/gazetta/tests/**"
  - "apps/admin/tests/**"
---

# Testing Plan

Active testing rules + forward-looking gap list. The 2026-04 plan that built the
infrastructure (Vue component tests, sidecars units, fast-check PBT, fault
injection, axe-core e2e, mutation testing nightly, contract tests, e2e POMs +
matrix + scenarios) shipped — burndown detail recoverable from
[git log on `.claude/rules/testing-plan.md`](https://github.com/gazetta-studio/gazetta-studio/commits/main/.claude/rules/testing-plan.md).

## Shape per sub-system

Gazetta is four sub-systems with different test-distribution shapes. Each is
already in the codebase; this section names what's there.

| Sub-system | Shape | Layout |
|---|---|---|
| Core (`packages/gazetta/src/`) | Classic pyramid (heavy unit) | `packages/gazetta/tests/*.test.ts` — pure-compute logic with real invariants |
| Storage providers | Honeycomb (heavy integration) | `apps/admin/tests/docker.test.ts` via testcontainers (MinIO + Azurite) |
| Admin SPA | Trophy (component + scenario) | `apps/admin/tests/*.test.ts` (jsdom + Vue Test Utils + `createTestingPinia`) + `tests/e2e/` |
| CLI | Crab (heavy scenario) | exercised through e2e + integration via `gazetta validate`, `gazetta archive`, `gazetta assets` |

The shape is not the right axis to optimise. AI-era discipline is.

## Storage tier

API tests use [`memoryStorage()`](../../packages/gazetta/tests/_helpers/memory-storage.ts)
by default — a fresh in-memory `StorageProvider` per test, seeded via
`seed({...})`. Memory eliminates a class of structural flake (shared
`tempDir` state, cleanup races, watcher pickup of stale data) and keeps
test setup ~10ms vs ~100ms for `cp -r examples/starter`.

Memory does NOT fix all flakes — async-ordering bugs and millisecond-collision
races (e.g. audit event timestamps) are storage-tier-agnostic; sort by
deterministic key.

**Use fs (`createFilesystemProvider` + `tempDir`) when:**

- The test exercises a **transform-adapter pipeline or on-disk variant
  generation** — uploads that re-encode bytes, sharp variant ladders writing
  derived `_400w.jpg` files, content-hash filename generation from real
  bytes (today: [`admin-api-assets.test.ts`](../../packages/gazetta/tests/admin-api-assets.test.ts))
- The test **asserts on hash-in-path filename construction**
- The SUT is the **file watcher / SSE-reload path**
- The test is a **starter smoke** — exactly one per surface, loads
  `examples/starter` and walks it through routes (today:
  [`admin-api.test.ts`](../../packages/gazetta/tests/admin-api.test.ts))

Anything else — memory, including **routes that just read pre-seeded bytes**
(memory's `writeBytes()` / `seedBytes()` cover this; no fs needed). Reference
example: [`admin-api-suggest-alt.test.ts`](../../packages/gazetta/tests/admin-api-suggest-alt.test.ts)
seeds a JPEG and exercises the asset route end-to-end without disk I/O. Storage providers' wire-level correctness (case
sensitivity, atomic writes, range requests) is covered separately by
[`docker.test.ts`](../../apps/admin/tests/docker.test.ts) testcontainers
conformance — don't reproduce there.

## AI-era disciplines

Three layers ride on top of whatever shape the sub-system uses. Each catches a
class of failure that AI-assisted development is structurally prone to.

| Discipline | Catches | Where it lives |
|---|---|---|
| **TDD ordering** (test commit before impl commit) | Tautological tests written after observing output | [`team-preferences.md` rule 31](team-preferences.md) + the [`tdd` skill](~/.claude/skills/tdd/) |
| **Mutation testing** (StrykerJS, nightly) | Tests that pass without asserting anything meaningful | [`packages/gazetta/stryker.config.json`](../../packages/gazetta/stryker.config.json) + [`.github/workflows/mutation.yml`](../../.github/workflows/mutation.yml) |
| **Property-based testing** (fast-check) | Boundary / Unicode / encoding edge cases AI's "safe middle" inputs miss | `packages/gazetta/tests/hash-sidecar-names.test.ts` is the reference example |

**Mutation scope expansion:** StrykerJS currently mutates the
admin-API surface (`admin-api/**/*.ts`), `publish.ts`, `publish-rendered.ts`,
the three history modules (`history-provider.ts`, `history-recorder.ts`,
`history-restorer.ts`), `alt/route-handler.ts`, and `hooks/registry.ts` —
see [`packages/gazetta/stryker.config.json`](../../packages/gazetta/stryker.config.json)
for the current `mutate` glob. Nightly runtime ~1h 45m; hard ceiling 3h
workflow timeout.

**Scope expansion is autonomous via `mutation-area-picker` bot** (per
[`design-mutation-area-picker.md`](design-mutation-area-picker.md)). Weekly
cron picks one module to ADD / SWAP / REMOVE from the portfolio under a
runtime budget, using five risk-weighted signals (AI-pairing density,
test/source LOC ratio, churn, flake correlation, bug-fix correlation).
The bot opens a draft PR when its judgment says scope should change;
exits silently otherwise. No human-curated next-list.

Don't gate on score yet — observational metric until each module's baseline
stabilises. A survived mutant, from Stryker or from breaking code by hand to
check a test, is either a missing test or code that changes nothing; decide
which before writing a test. If no input can tell the mutant from the
original, delete the code, or, if it stays for a reason tests can't see
(speed, say), note that beside it. In #981 each of the four survivors pointed
at a case no test checked, and got a test; #984 deleted a `markWritten` branch
that gave the same answer as the comparison after it.

Tests written to kill mutants read like any other test, because their reader
wants to know what the code guarantees, not which run found the gap. Add them
to the code's existing test file, or name a new file for the code it covers
(`publish-renderers-esi.test.ts`), never for an issue or the tool
(`-mutation-935`). Test names say what the code does, and comments state the
rule an assertion pins ("a component with no CSS adds no line"), not the
mutant it kills. Stryker line numbers and mutator names go in the PR
description: they're wrong after the first edit above them. The exception is a
mutant no test can catch; say beside the code, or in the test file, why the
code stays. `publish-mutation-914` and `publish-rendered-mutation-649/726/811`
predate this; rename them when they're next touched (#957 review).

**Admin-API route track (parallel to the internal-module list above).** Tautological
tests slip most easily where assertions match observed response shapes ("expect what
the route returned"). Rule 31's failure mode lives most often at this tier; mutation
testing is the discovery tool. Sequence:

1. `packages/gazetta/src/admin-api/routes/assets.ts` (where suggest-alt lives —
   no separate `suggest-alt.ts` file as the original Q4 lock assumed) — first
   cycle complete; see [`docs/audits/test-quality-with-ai.md`](../../docs/audits/test-quality-with-ai.md).
2. `src/alt/route-handler.ts` — adjacent finding from cycle 1; suggest-alt
   orchestration lives here, NOT in `admin-api/routes/assets.ts`. Added to the
   Stryker `mutate` glob; cycle 2 audits the next nightly run.
3. `archive.ts` — recent feature, AI-paired cuts, concentrated seam.
4. `publish.ts` — highest blast radius; tackle once triage workflow stable.
5. Remaining routes (`pages.ts`, `fragments.ts`, `history.ts`, …) on demand.

Same smallest-first discipline as the internal-module list. Routes calling internal
modules already covered by mutation testing produce some redundant signal; document
equivalent mutants per route in the audit notes rather than skipping the route.

**Test-quality-with-AI research (next session).** Locked scope: B-primary
(test quality, signal-to-noise) + A-secondary (agent-loop ergonomics that
compose with B's findings). C (coverage gaps) deferred — wait for the next
escape. Methodology: mutation testing per the admin-API track above,
suggest-alt first. Outputs: audit doc at `docs/audits/test-quality-with-ai.md`
(per rule 21) + rule/plan updates as patterns generalize. Sequencing:
measurement-first — write the audit doc from triage notes, layer in
external-source framing (Anthropic PBT post, ThoughtWorks Vol 34+, recent
StrykerJS releases) after.

**Property-test scope expansion (next):** `fast-check` is installed and used
in 1 file. Targets where round-trip / fallback chain semantics matter:
- `archive/` filename codec round-trip (alias-targets sidecar names)
- Locale fallback chain (any locale + theme tuple → resolved chain order)
- Redirect chain construction (cycles, depth limits, archived-source semantics)
- Sidecar reference-name encoding (kind disambiguation across hash/uses/tpl/asset-refs/fragment-deps/alias-targets)

Each is a 30-line addition. Land one per relevant feature cut, not as a batch.

**Persistence and shared-site e2e tests** (from the #962 and #978 retrospectives — each line is a failure that happened):

- **Wait for the stored write, in both directions.** Poll storage (`storedDraftTitles` / `storedDraftKeys` in `tests/e2e/helpers.ts`) before a reload, and again after a discard; never sleep and reload. The Don't Save test first passed *without* the fix because it reloaded before the debounced write (#964). When an edit isn't stored yet, or isn't stored at all, a reload can't show whether a discard dropped it: check inside the app instead, by switching away and back. The SEO Don't Save test does this with the locale (#981).
- **Check what's stored in the failure case, not only after success.** Offline cold load erased the persisted query cache — 4 queries stored before going offline, 0 after — and only the offline e2e test showed it (#970).
- **The worker's site copy is shared across files.** One worker runs tests from several files on one copy, so other files' tests run in between yours. Use unique names, clean up in `afterEach`, and read the state a test depends on at its start; never assume the starter's content (#972: two tests created the same redirect → 409; #973: a scenario had reset English `home`).
- **Before pushing a new e2e spec, run it twice in one worker:**
  - `--repeat-each=3 --workers=1` on the spec alone catches a test leaking into its own next run (#972).
  - `npx playwright test --project=dev tests/e2e/scenarios <spec> --repeat-each=2 --workers=1` reruns your spec after the scenario tests: each repeat is one pass over all listed files in path order (checked with `--reporter=list`; `--list` shows a different order). This catches assumptions about state other files leave (#973).
- **Compare files by meaning, not bytes.** A save that reorders JSON keys looked like metadata loss.

## Cross-foundation integration test punch list

Foundational dimensions shipped in cuts (hooks, audit, validation, soft-delete,
media v1, ai-alt). Each has feature-internal tests; what's missing is **integration
across foundations**. Concrete gaps, ranked by blast radius:

| # | Interaction | Why it's load-bearing | Status |
|---|---|---|---|
| 1 | `beforeSave` hook **throws** → save returns 4xx AND audit records the cancellation with the locked outcome | Hook cancellation is the documented failure path per `design-hooks.md` Q3; audit closed-enum extension `'hook-cancelled'` already in `audit/types.ts`. | ✓ — fixed: `manifest-save.ts` save-pipeline catch + `publish.ts` two beforePublish/afterPublish catches all emitted the wrong outcome (`'validation-failed'` for save, `'forbidden'` for publish — semantically conflated hook policy with validator/capability decisions). All three sites now emit `outcome: 'hook-cancelled'`. Coverage: [`manifest-save.test.ts`](../../packages/gazetta/tests/manifest-save.test.ts) (cancellation + timeout audit shape pinned). `SaveAuditRecorder`'s outcome enum widened to include `'hook-cancelled'`. |
| 2 | History restore of an archived page → preserves archive marker, alias, and `archivedAt` fields | Restore writes manifest back to content tree; if archive fields are dropped by the restorer's whitelist, restored "live" pages still serve archived markers (or vice versa) | ✓ — [`history-restorer.test.ts`](../../packages/gazetta/tests/history-restorer.test.ts) covers alias variant + pure soft-delete (no `aliasOf`) round-trips. Contract: restorer copies blob bytes verbatim; no whitelist. Tests serve as regression guards against a future refactor that would introduce one. |
| 3 | Capability-gap UX surfaces at all four points (boot warning / author modal / scanner / publish-gate) for one feature end-to-end | Per `feature-design-process.md` non-foundational disciplines, four-point surfacing is the contract; today each point is tested feature-by-feature, never as a single chain | ✓ — [`cross-foundation-capability-gap-chain.test.ts`](../../packages/gazetta/tests/cross-foundation-capability-gap-chain.test.ts) covers the (archive on plain-static target) chain. Five tests pin: surface #1 (`warnOnCapabilityGaps` warns once with both `redirects` + `gone-status` reasons + doc link); surface #2 (`/api/targets` returns `capabilities: { has, gaps }` per target with non-empty reason strings); surface #3 (P4 `archive-not-supported-on-target` validator at background stage flags the archived item with `severity: 'warn'` + target name in message); surface #4 (`/api/publish/audit` includes `capabilities` only when publish set has archived items — confirms conditional surface, not always-on); consistency check (surfaces #2 + #4 return identical `inspectTarget()` output — guards against divergent UX from a future regression that forks inspection per surface). |
| 4 | AI alt-text refusal → audit log records the refusal with provider name + reason | Refusals are structured per `design-ai.md`; if they don't audit-record, "why didn't this image get alt?" is unanswerable forensically | ✓ — fixed: `POST /api/assets/:name/suggest-alt` previously emitted no audit at all. Route handler now records `action: 'ai-suggest-alt'` (closed-enum extension) with `metadata: { provider, locale, refused, refusalReason? }`. Outcome stays `'success'` for both happy-path and refusal — the API call succeeded; refusal is a domain detail in metadata (consumers query `metadata.refused: true`). Coverage: [`admin-api-suggest-alt-audit.test.ts`](../../packages/gazetta/tests/admin-api-sugest-alt-audit.test.ts) (3 integration tests pinning success / refusal / locale paths). |
| 5 | Hook factory contribution from a plugin → hook fires with correct site config + `auditEmit` wired | Cut 9 of hooks shipped factory contributions; integration with audit at the plugin boundary isn't directly tested | ✓ — [`hooks-plugin-contribution-audit.test.ts`](../../packages/gazetta/tests/hooks-plugin-contribution-audit.test.ts) covers the full round-trip: factory function returning `HookContribution` → `buildHooksRegistry({ contributions })` → `createAdminApp({ hooks })` → PUT → audit event with `metadata.source` (package name like `'@example/cdn-purge'`) + `metadata.hookName` as separate fields per ADR-0009. Three tests pin: single plugin, two plugins on the same phase, mixed site-local + plugin sources coexisting. Cut 9 contract was already correct; tests guard against a future refactor that would compose `source:hookName` into one string and break forensic queries. |
| 6 | Archived page → validation scanner re-runs and clears prior `referenced-archived-without-alias` issues from the page itself (not from items referencing it) | Scanner cache invalidation on archive transitions is implicit; no test pins the contract | ✓ — fixed: archive routes now thread `validationScanner` from `createAdminApp` and call `scanner.rescan({kind:'manifest', item})` after every archive / unarchive / purge / setAlias write. Coverage: [`admin-api-archive-scanner.test.ts`](../../packages/gazetta/tests/admin-api-archive-scanner.test.ts) (4 integration tests). Pattern matches `manifest-save.ts`'s fire-and-forget scanner notification. |
| 7 | Publish to a target with `editable: false` from a hook-modified manifest → publish observes the hook-modified payload, not the pre-hook version | Hook-as-payload-transformer per `design-hooks.md`'s return-new-payload contract; publish path needs explicit coverage | ✓ — [`cross-foundation-hook-publish-payload.test.ts`](../../packages/gazetta/tests/cross-foundation-hook-publish-payload.test.ts) covers the full chain: PUT → beforeSave hook mutates content → manifest written with post-hook bytes → publish source → non-editable staging → destination receives post-hook content (not the pre-hook payload from the original PUT). Second test pins the non-rerun invariant: publishing doesn't fire `beforeSave` again (would produce double-marker `[post-hook] [post-hook]` if it did). Item-list mutation via `beforePublish` is covered separately by [`hooks-publish-integration.test.ts`](../../packages/gazetta/tests/hooks-publish-integration.test.ts) (Cut 5). |

Write each as one route-level integration test in `packages/gazetta/tests/`,
named `cross-{foundation-a}-{foundation-b}.test.ts`. Land alongside the next
feature cut that touches the foundation in question — not as a backlog batch.

## Single-route coverage gaps

Routes whose **logic** is tested via direct function calls but whose
**HTTP handler** (status code mapping, content-type, schema validation,
middleware ordering) has no `app.request()` test. Inventory as of 2026-10-21 (#1058 covers the four left):

| Route | Logic tested via | Gap |
|---|---|---|
| `GET /api/compare` | `compareTargets()` direct call ([compare.test.ts](../../packages/gazetta/tests/compare.test.ts)) | Route handler — target-name lookup + serialization |
| `POST /api/publish/stream` | Schema only | SSE stream contract; main publish flow |
| `GET /api/templates/:name/impact` | `validation-template-impact.test.ts` | Route handler |
| `GET /api/validation/issues` | Only its `read:pages` gate ([auth-route-gates.test.ts](../../packages/gazetta/tests/auth-route-gates.test.ts)) | Response body |

Same policy as the cross-foundation punch list: write the test alongside
the next feature cut that touches the route. Don't backfill as a batch
([team-preferences rule 17](team-preferences.md)).

The pattern this avoids: testing the underlying helper while leaving the
route handler — itself an SUT with its own concerns (404 vs 400 vs 500
status mapping, JSON serialization, principal middleware, audit emission)
— uncovered. Per [rule 31's tier-default](team-preferences.md), trophy /
honeycomb sub-systems default to API-first; new admin-API behavior gets
the route-level test, not the helper-level test.

## E2e + matrix + scenarios — current state

Layout is flat under `tests/e2e/` (12 feature spec files), with subdirectories
for `pages/` (POMs), `scenarios/` (cross-surface integration), and `matrix/`
(env × editable × type parameterized). Worker-scoped temp-site fixture per
[team-preferences rule 10](team-preferences.md).

The `dev` project's servers run `gazetta dev`, which serves the admin from
`apps/admin/` in your working tree through Vite. That's why breaking admin
code by hand reaches e2e without a rebuild, and why a source edit made during
a run reaches the tests still running. Keep other work as a patch until the
run ends, as #981 did with cut 4 during its e2e mutation runs.

To run one `dev`-project spec locally, use a throwaway config that drops the
four production web servers `playwright.config.ts` always starts:

```ts
// .tmp/pw-dev-only.config.ts (.tmp/ is gitignored)
import base from '../playwright.config.ts'
export default { ...base, testDir: '../tests/e2e', reporter: 'line', webServer: [] }
```

Then `npx playwright test -c .tmp/pw-dev-only.config.ts --project=dev <spec>`.
Run it from the main checkout, not a git worktree: a worktree with symlinked
`node_modules` writes the main checkout's Vite cache. Until #1028 gives each
dev server its own Vite cache, a run with two or more workers can also fail
on `504 (Outdated Optimize Dep)`.

A change to what `tests/e2e/fixtures.ts` gives every worker copy (a template
field, a page, a config edit) changes the starting state of every `dev` test.
Before relying on CI, search the tests for waits on whatever the change adds:
a timing problem can pass one CI run and fail the next. #1021 gave
`page-default` an `intro` field, so the page row got an `editor-container`.
Tests that click a component and then wait for `editor-container` found the
page row's one before the component's editor replaced it. #1021's own CI had
passed; it was reverted in #1031, and #1032 makes those waits target the
opened component.

POMs landed: `PublishPanel`, `SiteTree`, `ComponentTree`. Add a POM with its
first consumer (avoid dead-code POMs), not in advance.

Scenarios landed: `edit-publish-sync`, `fan-out-publish`, `rollback-sync`,
`publish-with-assets`, `archive-rename`. New scenarios target cross-surface
integration gaps; the catalogue lives implicitly in the file names.

Deferred — **hotfix source=prod → local** scenario. Requires `editable: true`
on production; dev-server target-registry doesn't reload on `site.config.ts`
change. Two paths: (a) separate Playwright project with pre-patched config,
(b) fix dev-server to reload registry. Either is infrastructure work.

## Explicit non-goals

| Skip | Why |
|---|---|
| Visual regression (Percy / Chromatic / `toHaveScreenshot`) | Per [`css-theming.md`](css-theming.md): per-platform baseline friction, semantic regressions missed. Reintroduction criteria not met. |
| Vitest Browser Mode | Vue Test Utils + jsdom is sufficient; real-browser fidelity comes from Playwright e2e |
| BDD / Cucumber / playwright-bdd | Split between feature files + step defs hurts maintenance; plain Playwright reads fine for solo dev |
| Pact contract testing | Single consumer, single producer — Zod schemas already cover via [`api-contract.test.ts`](../../apps/admin/tests/api-contract.test.ts) |
| Type-level tests (`tsd`, `expect-type`) | Apps not libraries; consumers are in-tree; TS strict already gates |
| 5K-page envelope CI gating | Separate decision (scale-CI), not testing-strategy. Synthetic-site benchmarks per `design-scale.md` Cut 1 belong in their own workflow |
| Vitest `bench` | Experimental, no SemVer guarantee — adopt only with specific perf motivation |
| Named workflow profiles | Rejected by [`design-decisions.md`](design-decisions.md) #15 |

## Deferred branches

Branches surfaced during the 2026-05 testing-strategy grill but not walked.
Captured here so future-me / a future grill doesn't re-derive the same
questions. Each has a **revisit trigger** — the observable signal that would
promote it from deferred to active.

| Branch | Question | Revisit trigger |
|---|---|---|
| **C. Test-fixture seed library** | Should `_helpers/fixtures.ts` ship named seeds (`seedHomePage()`, `seedFragmentTree()`) to cut per-test JSON boilerplate? | When 3+ admin-API tests independently re-implement the same seed shape AND a change to that shape forces parallel edits. Risk: fixture coupling — one shared fixture, change-once-break-all. |
| **D. Property-based tests at the API tier** | Beyond pure-logic PBT, can `fast-check` drive random-but-valid manifest payloads through `app.request()` to assert audit / sidecar invariants always hold? | When a cross-foundation punch list item ships and the invariant is naturally PBT-shaped (e.g., "every save emits exactly one audit event regardless of payload shape"). Most invariants will be example-tested first; PBT lifts when the surface is clearly invariant-rich. |
| **E. AI-agent prompt template for API tests** | Should rule 31 (TDD ordering) carry a captured prompt template ("Write a Hono `app.request()` test that...") to reduce per-PR prompt drift? | When 3+ PRs in a row produce API tests with structurally different shape (e.g., one uses `setupApp()`, another inlines, a third forgets the principal middleware). Today's tests are structurally consistent; no drift observed. |
| **G. Cross-foundation punch list ordering** | The 7 items are ranked "by blast radius" — should they instead be ordered by "likelihood of being touched by next feature cut"? | When 2+ items have shipped via "land alongside next feature cut" policy, retrospect on whether blast-radius order matched the actual order. If not, switch to feature-cut-likelihood. |
| **H. E2e scenario coverage audit** | Are there cross-surface gaps the existing 5 scenarios miss? Specifically: archive × publish × audit chain (3 foundations); offline-replay × conflict (when `design-offline.md` ships); collaboration comments × audit (when `design-collaboration.md` ships). | When a new design pass crosses ≥3 surfaces (offline, collaboration, scheduling). Audit at design-time, not retrospectively. |

These are not committed work. Promotion to the body of this doc requires the
revisit trigger to fire AND the branch to survive a grill on whether it earns
its keep at that point.

## Sources

- [Anthropic — Property-Based Testing with Claude (2026)](https://red.anthropic.com/2026/property-based-testing/)
- [ThoughtWorks Radar — AI-aided test-first development (Vol 34)](https://www.thoughtworks.com/en-us/radar/techniques/ai-aided-test-first-development)
- [Simon Willison — Code proven to work (2025)](https://simonwillison.net/2025/Dec/18/code-proven-to-work/)
- [Kent C. Dodds — Testing Trophy (2018)](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications)
- [Spotify — Testing of Microservices (Honeycomb, 2018)](https://engineering.atspotify.com/2018/01/testing-of-microservices)
- [fast-check](https://fast-check.dev/) · [StrykerJS](https://stryker-mutator.io/) · [axe-core](https://www.deque.com/axe/)
- [Playwright POM](https://playwright.dev/docs/pom) · [testcontainers](https://testcontainers.com/)

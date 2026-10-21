# Gazetta

Stateless CMS that structures websites as composable fragments. All state lives in targets.

## Structure

- `apps/admin/` — CMS admin frontend (Vue 3 + PrimeVue editor shell)
- `packages/gazetta/` — Core package (renderer, CLI, admin API, editor, storage providers)
- `tools/mcp-dev/` — MCP dev server (screenshot tool)
- `bots/` — Autonomous repo bots run on GitHub Actions cron (e.g., flake-watcher); see `bots/README.md`
- `examples/starter/` — Sample site with templates, fragments, pages
- `sites/gazetta.studio/` — The gazetta.studio website (dogfooding)

**Strategic / process docs** (read these before designing or planning):
- `CONTEXT.md` — **Product domain glossary**: canonical vocabulary for the CMS (actors, structural primitives, manifests, references, targets, assets, locale/theme dimensions, composition vs. resolution, project/site/workspace). Covers WHAT we build.
- `.claude/rules/dev-glossary.md` — **Dev-process glossary**: vocabulary for design phases, doc artifacts, testing, bots, skills, triage labels, etc. Covers HOW we work. Auto-loaded.
- `ROADMAP.md` — Strategic forward-looking priorities (Tier 1/2/3 + deferred + non-goals). Updated as priorities shift.
- `docs/non-goals.md` — Explicit strategic non-fits (memberships, content branching, federation, built-in search, visual-first editing, database integration). Read before proposing one of these.
- `docs/audits/cms-feature-audit.md` — Snapshot of Gazetta's coverage vs. the modern CMS landscape, with fact-checked competitor citations. Drives ROADMAP and non-goals.
- `docs/actor-scenarios.md` — Canonical task narratives per actor type (Content Author / Template Developer / Operator / CMS Developer). Yardstick for UX-grilling phase per `feature-design-process.md`.
- `docs/adr/` — Architecture Decision Records for hard-to-reverse, surprising-without-context decisions.

**Public docs** (user-facing):
- `docs/cloudflare.md` — Cloudflare deployment guide (R2, Workers, cache, CI)
- `docs/self-hosted.md` — Self-hosted deployment guide (VPS, Docker, Fly.io)
- `docs/deploy.md` — Deploy adapter contract reference (factory shape, available adapters, container-host pattern)
- `docs/getting-started.md` — Onboarding tutorial
- `docs/template-assets.md` — Template developer guide for asset references
- `docs/content-assets.md` — Content author guide for the asset library
- `docs/migration.md` — Migrating templates from `z.string()` URLs to `embeddedAsset()` references
- `docs/transform-adapters.md` — Per-target image delivery strategies
- `docs/cache.md` — Admin read-side cache configuration + monitoring
- `docs/offline.md` — Offline mode (cold-load reliability, save conflicts, browser support)
- `docs/auth.md` — Authentication + RBAC (trust modes, roles, capability gates)
- `docs/audit.md` — Audit log (forensic event recording, privacy posture, retention, capability gating)
- `docs/hooks.md` — Lifecycle hooks (save / publish / upload extension surface; site-local + npm-distributed factory contributions)
- `docs/soft-delete.md` — Archive / alias / rename / restore / purge for pages and fragments (UX, API, CLI, capability gaps)
- `docs/runtime-capabilities.md` — Per-target capability matrix (`redirects`, `gone-status`); `_redirects` host-glue for plain-static deployments

## Design docs (auto-loaded by Claude)

- `.claude/rules/design-concepts.md` — Fragment, page, node, target model; target properties; active target
- `.claude/rules/design-publishing.md` — Stateless CMS, bidirectional sync, targets, unified Publish
- `.claude/rules/design-decisions.md` — Key decisions and rationale
- `.claude/rules/design-editor-ux.md` — Active target UX spine, switching, progressive disclosure
- `.claude/rules/design-media.md` — Asset model, storage, refs, resolver, delete-with-replace, admin UX, i18n, distinctive choices
- `.claude/rules/design-media-reference.md` — Fact-checked tooling specifics, library versions, licensing, codebase-alignment notes
- `.claude/rules/design-media-implementation.md` — v1 scope + estimates, phased alt, out-of-v1, v1.5/v2 capabilities, frontier opportunities, open questions, migration
- `.claude/rules/design-ai.md` — AI integration: layered architecture, alt-text task, providers (Anthropic/OpenAI/Ollama), refusal handling, prompt composition
- `.claude/rules/design-ai-implementation.md` — v1.5 commit sequence, scope, deferred items, open questions, migration
- `.claude/rules/design-validation.md` — Validation: four-phase model (format/integrity/quality/publish-gate), validator abstraction, severity model, surfaces
- `.claude/rules/design-validation-implementation.md` — Phased cut sequence (save-delta, background scanner, quality validators, publish gate), scope, deferred items
- `.claude/rules/architecture.md` — System architecture and package layout
- `.claude/rules/testing-plan.md` — Active testing coverage + e2e restructure plan (auto-loads when editing tests)
- `.claude/rules/feature-design-process.md` — How feature design + implementation works in Gazetta. The resumability contract (every kind of work has a designated durable artifact). Read when starting feature design or unsure where a piece of work belongs.
- `.claude/rules/dev-glossary.md` — Dev-process vocabulary (design phases, doc artifacts, testing, bots, skills, triage labels). Companion to `CONTEXT.md` (product domain). Auto-loaded.
- `.claude/rules/design-config.md` — Site config reference (companion to ADR-0005). TS config (`gazetta.config.ts` + `site.config.ts`) replacing YAML; identity functions; secrets handling; evaluation timing.
- `.claude/rules/design-logging.md` — Operational logging reference. Structured JSON logs, levels, module namespacing, requestId correlation, privacy rules. Companion to `design-audit.md` (audit = forensic record; logs = operational signal; both run).
- `.claude/rules/design-deploy.md` — `DeployAdapter` Pattern 1 Provider surface. Publish + deploy independence; `target.deploy?` field; `WorkerCapableDeployAdapter` capability for worker-bundling adapters; `storage:` always required + `deploy:` optional; no container adapters (`gazetta serve` + platform CLIs). Companion to ADR-0010. **v1 shipped 2026-05-14.**
- `.claude/rules/design-deploy-implementation.md` — Pruned to deferred-items table (downstream adapters #204, #206, #208, #209, #205, #207, #210-212; container guide #213) + lessons learned. Cut history in `git log --grep "Cut.*of #203"`.
- `.claude/rules/sidecars.md` — Internal mechanism docs for per-item sidecars (`.{8hex}.hash`, `.pub-{ts}`) and reverse-dep indices (`.gazetta/fragment-deps/`, `.gazetta/asset-refs/`) used for incremental publish + reverse-dep lookups
- `.claude/rules/design-soft-delete.md` — Foundational primitive: archive + alias + rename + restore + purge for pages/fragments. HTML comment marker as the universal mechanism (worker reads first 200 bytes of page HTML); no aggregates. Capability-gap UX surfaced at four points.
- `.claude/rules/design-soft-delete-implementation.md` — 15-cut sequence (~25 days). Manifest fields, alias-aware renderer, archive routes, rename composition, validators, admin UI, conflict prompt UX, resolution UX, CLI, review-workflow integration.
- `.claude/rules/design-redirects.md` — Redirect reference doc (NOT a foundational dimension). Consolidates 301-rename / 410-gone / `_redirects` host-glue / forward-compat invariants. Owner docs: soft-delete (301 + 410); scheduling (future 302/scheduled).
- `.claude/rules/design-redirect-ui.md` — Manual Redirect creation feature (original ask [#364](https://github.com/gazetta-studio/gazetta-studio/issues/364); tracking issue [#451](https://github.com/gazetta-studio/gazetta-studio/issues/451)). 8 locked decisions: Redirect as first-class CONTEXT.md noun, new `POST /api/redirects` endpoint, SiteTree "+ New redirect" entry, hard-refuse on live-name collision, both pages+fragments, new `create-redirect` audit action, `edit:pages`/`edit:fragments` capability. Now carries `## Cut sequence` + `## Deferred items` + `## Validation gate`; impl doc retired per [ADR-0015](docs/adr/0015-impl-doc-artifact-retires.md).
- `.claude/rules/design-scheduling.md` — Foundational primitive: time-based state transitions (single-shot actions + visibility windows). Background scheduler with lock-with-TTL multi-instance coordination; lazy visibility evaluation at render time; capability check at fire time; per-action catch-up policy; 6 validators + 5 audit actions + 4 hook phases.
- `.claude/rules/design-scheduling-implementation.md` — 12-cut sequence + UX research pass (~22 days). Manifest schedule field, atomic conditional-create, sidecar lifecycle, tick loop, capability rehydration, lazy visibility, admin UX (deferred to UX research), operator dashboard, CLI.
- `.claude/rules/design-code-review.md` — Code review skill family (dev-process, not foundational dimension). Two-phase model: Discovery (`audit-area`) + Evaluation (`review-orchestrator` + 6 angle skills: `review-diff`, `review-architecture`, `review-security`, `review-tests`, `review-types`, `review-comments`). Four consumers (local CLI, PR-comment trigger, fix-bot reviewer, autonomous `review-bot`). Companion ADRs: [0012](docs/adr/0012-skill-three-invocation-modes.md) (Skill = 3 invocation modes), [0013](docs/adr/0013-code-review-two-phase-model.md) (two-phase split).
- `.claude/rules/design-code-review-implementation.md` — 4-phase build (~3-4 weeks). P1 skill family (10 cuts) → P2 fix-bot integration (3 cuts) → P3 PR-comment workflow (3 cuts) → P4 review-bot autonomous producer with generator-critic loop (6 cuts).
- `.claude/rules/design-live-check.md` — Live check: after each publish or deploy, verify the target's live site serves what was published (published-version marker, route planner over the target's dependency indices, reports in `.gazetta/live-check/`, `afterLiveCheck` hook). Publish verification, not uptime monitoring. Research: `docs/audits/live-site-health.md`.
- `.claude/rules/design-public-storage.md` — Public storage: a target whose storage visitors can reach keeps no history, audit or review state (`publicStorage`, public by default except local filesystem targets); `isPublicSitePath` decides which stored files are served; a folder registry marks `.gazetta/` folders safe or not; the live check probes for leaks and locks publishing. Resolves #1070.

## Build & Test

All commands run from the repo root unless noted.

```bash
npm install                              # install all workspace deps
npm run build                            # build all packages
npm run dev                              # examples/starter on localhost:3000
npm test                                 # all workspace tests (~65s for gazetta)
npm test -w packages/gazetta             # one workspace's tests
```

**Single test file / pattern** — run from the package directory:

```bash
cd packages/gazetta && npx vitest run tests/some-file.test.ts
cd packages/gazetta && npx vitest run -t "test name pattern"
```

**Coverage** — a report, not a gate. CI writes the table to each test job's summary; no job fails on a percentage. Unit coverage misses code run in subprocesses (CLI), the browser (e2e) or Docker:

```bash
npm run test:coverage -w packages/gazetta   # also -w @gazetta/admin; report in <pkg>/coverage/
```

**Iterating on one file** — use watch mode (per rule 32 Pattern B); each edit reruns in ~10-50ms instead of the ~1.2s cold-start of `vitest run`:

```bash
cd packages/gazetta && npx vitest tests/some-file.test.ts
```

**Type-check** — no repo-level script; per-package:

```bash
cd packages/gazetta && npx tsc --noEmit
npm run typecheck -w apps/admin          # vue-tsc: also checks .vue files; CI runs it (needs packages/gazetta built)
```

⚠️ **`tsc --noEmit` is not a full build verification.** It catches the dominant class of type errors but can suppress real errors that surface under emit (e.g., narrow-enum + `as const` mismatches that the build catches but `--noEmit` lets through). After non-trivial type-shape changes, run `npm run build` from the repo root before commit.

⚠️ **Never run `tsc -b` from a workspace dir.** It walks build references up to the root tsconfig and emits `.d.ts` / `.js` / `.js.map` files **next to every `.ts` source file** in the monorepo (spills hundreds of artifacts into `apps/`, `bots/`, `sites/`, etc.). For build verification use `npm run build`. For per-package type-check use `npx tsc -p <pkg>/tsconfig.json --noEmit` (explicit `-p`, explicit `--noEmit`).

**Format** — Biome; rule 30 says run before tests, not after (post-test format thrash forces a re-run):

```bash
npm run format                           # write
npm run format:check                     # CI gate
```

**Workflow lint** — actionlint (pinned in `scripts/actionlint.sh`; same check as the `actionlint` CI job). Run after editing anything in `.github/workflows/`:

```bash
npm run lint:actions            # actionlint: syntax, keys, permissions, shellcheck
npm run lint:actions:security   # zizmor: injection, token exposure, risky triggers (config: .github/zizmor.yml)
```

**E2e** — Playwright; no wrapping npm script:

```bash
npx playwright test
```

**Mutation** — StrykerJS, opt-in (per `testing-plan.md`); slow:

```bash
npm run test:mutation -w packages/gazetta
```

**CLI smoke against the dogfood site** — `sites/gazetta.studio/` is the canonical end-to-end target. `.env` lives at the site dir (`sites/gazetta.studio/.env`), not the repo root; the CLI loads it via the per-command env-load dispatch (see `loadEnvFiles` in `packages/gazetta/src/cli/index.ts`).

```bash
# Publish content to a target (writes R2; independent of deploy per ADR-0010):
npx gazetta publish local        # local filesystem target
npx gazetta publish production   # R2 — needs CLOUDFLARE_API_TOKEN + R2_* in sites/gazetta.studio/.env

# Deploy the worker (invokes target.deploy.execute(); independent of publish):
npx gazetta deploy production    # `cloudflareWorkersDeploy()` → wrangler deploy
```

Auto-detection: `npx gazetta publish` (no args) walks `sites/` for a single site, picks the only target if one exists, prompts otherwise. CI fails on multi-target ambiguity instead of prompting.

After a real deploy, smoke the live site:

```bash
curl -sI https://gazetta.studio | head -5    # 200 from `server: cloudflare`
```

**Note:** Page and fragment manifests use JSON (`page.json`, `fragment.json`). Site config is TypeScript (`site.config.ts`) using `defineSite()` from the `gazetta` package. Components are inline in the page manifest — no separate component files.

## Conventions

- TypeScript strict mode everywhere
- Prefer composition over inheritance
- Extract shared code only when 3+ callers exist

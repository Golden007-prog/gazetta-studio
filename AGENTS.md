# Gazetta

Stateless CMS that structures websites as composable fragments. All state lives in targets.

These are the instructions for any coding agent working in this repository. Claude Code reads them through `CLAUDE.md`, which adds the list of design docs it loads by itself.

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
- `docs/targets.md` — Target configuration reference (storage factories, type, environment, editable / public storage, history, siteUrl, cache, secrets)
- `docs/templates.md` — Template writing guide (contract and schema, template fields, frameworks, composite layouts)
- `docs/pages-and-fragments.md` - Pages, routes, fragments, translations, custom 404 pages and project layout
- `docs/customize-editor.md` - Custom editors, field widgets and admin theme overrides
- `docs/getting-started.md` — Onboarding tutorial
- `docs/publishing.md` - Publishing from the admin and CLI, sync status, history and undo limitations
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

**Site docs pages** under `sites/gazetta.studio/targets/local/pages/docs/` are generated from `docs/` by `npm run docs:site`; nav order, descriptions and the version banner live in `sites/gazetta.studio/scripts/docs-nav.json`. Never edit the generated `page.json` files by hand — CI fails when they drift from the docs.

**Design docs and team rules** live in `.claude/rules/`. Each `design-{feature}.md` records decisions the maintainer made: read the one the issue names (`**Feature**: x` means `design-x.md`) or the one for the code you change, and ask on the issue before changing a decision. `team-preferences.md` holds the numbered team rules that reviews cite. Claude Code loads these files by itself; other agents should open the ones they need.

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
- A change comes with its tests, in the same PR; a bug fix comes with a test that fails without it
- New interactive UI elements get a `data-testid`; e2e tests select by it, not by CSS classes or labels
- Types come from the Zod schema (`z.infer<typeof schema>`); don't write them out twice
- Say "content", not "props", and use one word per concept across the CLI, UI and API (Publish is `gazetta publish` and `/api/publish`)
- When behaviour users see changes, update `docs/` in the same PR
- Don't read or commit `.env` files, and don't publish or deploy to gazetta.studio's real targets; use a `local` target

## Pull requests

- One issue per PR, with `Fixes #N` (or `Part of #N`) in the description
- Before pushing: `npm run format`, then the tests for what you changed
- How to pick an issue, and what happens after you open a PR: [`CONTRIBUTING.md`](CONTRIBUTING.md)

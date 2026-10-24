# Tutorial

The Stage 1 tutorial: one path a newcomer follows from `npx gazetta init` to undoing a publish on a second target, kept true by a CI check that runs its commands word for word. Also how today's `docs/getting-started.md` splits into the tutorial and six other pages.

**Status**: design pass complete (2026-10-24), grilled Q1–Q13. The tester protocol is a separate round before tester round 1 (Q12). Implementation not started.

**Companion docs:**
- [`docs/audits/website-and-channels.md`](../../docs/audits/website-and-channels.md): the website plan. Stage 1 opens when "a release on npm matches the docs; the tutorial passes in CI; 3–5 people the maintainer watches get from install to a publish on a second target without help"
- [#1272](https://github.com/gazetta-studio/gazetta-studio/issues/1272): the docs pipeline. It builds gazetta.studio's docs from `docs/`, fails on raw HTML outside code, and ties `docs-nav.json` and AGENTS.md's "Public docs" list to the file list
- [`design-publish-undo.md`](design-publish-undo.md): undoing a publish on a destination, which the tutorial's last step needs ([#1092](https://github.com/gazetta-studio/gazetta-studio/issues/1092))
- [#1284](https://github.com/gazetta-studio/gazetta-studio/issues/1284): `gazetta init` adds a filesystem `staging` target, the tutorial's second target
- [`docs/actor-scenarios.md`](../../docs/actor-scenarios.md): the tutorial walks the Content Author's path (CA1) on a site a Template Developer just created
- Research: a getting-started audit (53 findings, filed as #1300, #1304–#1306, #1309–#1318 and additions to #1284) and a research round on comparable tutorials, CI prior art and first-use sessions (2026-10-24)

## Scope

**In v1:**
- A 7-step tutorial at `/docs` (`docs/getting-started.md`), no accounts
- A Playwright spec that runs the tutorial's commands against a local registry, and fails when the tutorial's commands and its own step list differ
- A `tutorial` CI job, and a weekly and after-release run against npm
- Six new docs pages taking over the rest of today's getting-started
- A release candidate on npm for testers (Q7)

**Out of v1:**
- The tester protocol (Q12: decided before round 1)
- A "How Gazetta works" explanation page (Q11)
- A stated time to complete, until it's measured (Q11)

**Non-goals:**
- Teaching templates, configuration, cloud targets, deploy or the CLI in the tutorial. They're in the guides; Diátaxis keeps choices and alternatives out of tutorials.

## Discovery

- None of nine comparable first-run docs teaches undo (Astro, Payload, Strapi, Directus, Keystatic, TinaCMS, Hono, Django, Rails). Directus's Environment Sync quickstart, which runs two local instances, is the closest to `local` → `staging`.
- Undoing a save on `local` works today (the save toast's Undo, the History panel). On a publish destination, undo restores manifests only, so the served page doesn't change (#1084): publish undo cuts 1, 2, 4 and 5 remain (#1092), and cut 4 waits on review-workflow cuts #526 and #527.
- `main` and npm are both at 0.8.0, so a scaffold that depends on `^0.8.0` (or `*` today) installs npm's copy, not the code under test.
- `gazetta dev`, `serve` and `admin` all default to port 3000 (`cli/index.ts:2498-2510`).
- CI already packs a tarball (`pack`) and smoke-tests it (`smoke`, `scripts/smoke-publish.sh`), and `tests/e2e/scenarios/edit-publish-sync.spec.ts` covers edit, save and publish to staging. Bots can't edit `.github/workflows/**` (#840).
- #1282 releases to npm only after the whole Stage 1 gate.

## Locked decisions

### Q1: The tutorial ends by undoing a publish; tester round 1 runs before that works

The last step undoes the publish to staging, and the reader sees staging's old title come back. Stage 1 still opens only once that works, but tester round 1 runs before it, on install to publish; only round 2 waits for #1092.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Undo the save on local | Ending: edit, save, click Undo in the save toast, and the old title is back in the preview. Works today, so Stage 1 doesn't wait for #1092; staging undo is added when it ships. Shows history, but not on a publish destination |
| Undo the publish; wait | As the plan says: the tutorial and all tester rounds wait until undoing a publish on staging works |
| No undo in the tutorial | End at the publish to staging; undo goes to the publishing guide. Stage 1 doesn't wait for #1092 |

### Q2: Publish the untouched site first

The reader publishes the untouched site to staging and looks at it, edits the hero and saves, publishes again, and Undo brings back the title they saw on staging. One edit.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Edit, publish, edit, publish | Two edits and two publishes; Undo returns to the first edit. Longer |
| Edit, publish, undo | One publish; Undo empties staging, since there was nothing before it |

### Q3: Publish and undo happen in the admin

The Publish panel and its Undo button: the content author's path. The CLI commands (`gazetta publish staging`, `gazetta undo staging`) go in the publishing guide.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| In the terminal | `npx gazetta publish staging` and `npx gazetta undo staging`. Simpler to test, but the reader leaves the admin for the key steps |
| Admin, with CLI asides | The admin steps, each with a one-line "or run …" for the terminal |

### Q4: Staging is viewed from a second terminal on port 3001

`gazetta dev` keeps running; in a second terminal the reader runs `npx gazetta serve staging --port 3001` and opens localhost:3001. Needed because undo happens in the admin while staging is viewed. This answers #1284's open point about the port clash.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Stop dev, serve, restart dev | One terminal: stop `dev`, run `serve staging`, look, stop it, start `dev` again. Two extra steps, and the admin goes away meanwhile |
| Change the product | `serve` or `dev` picks a free port when 3000 is taken. A code change outside the tutorial |

### Q5: CI installs from a local registry

CI starts a Verdaccio registry holding the freshly packed tarball, with `gazetta` not fetched from npm, so the docs' commands run word for word and get the new code. A check confirms the installed package is the tarball. No product change (Storybook's pattern).

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Test hook in init | `gazetta init` gets a test-only option to install a given tarball (Next.js's pattern). Changes init and the first command CI runs |
| Unique prerelease version | Bump to a throwaway prerelease before publishing to the local registry. Adds versioning steps |

### Q6: The test owns a step list

A Playwright spec holds each step's command and checks, and fails when the tutorial's shell blocks differ from its list in text, order or count. Editing either without the other fails CI. No markers in the Markdown, so nothing collides with #1272's raw-HTML rule.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Annotated Markdown | A runner reads markers in the Markdown (fence attributes like ```` ```bash tutorial=init ````). Needs #1272's highlighter to accept them |
| Doc Detective | An existing docs-testing tool drives the steps. Another dependency; worth it only if the browser part grows |

### Q7: Testers install a release candidate

A one-off `rc` release on npm (`npx gazetta@rc init`), approved by the maintainer; `latest` stays 0.8.0. The closest to what users will run. #1282 rejected publishing every merge as `next`, not a single release candidate.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| A CI tarball | Testers get a file from CI and run `npx --package=<file> gazetta init`. No npm release, but not the real install |
| Release first | Publish a normal release before testing. Reverses #1282's "after the whole Stage 1 gate" |

### Q8: A new `tutorial` CI job

A `tutorial` job in `ci.yml` after `pack`, on every PR and push to main, Ubuntu only, about 3–4 minutes; plus a weekly and after-release run against npm. The maintainer adds the job once in a PR; the spec, registry config and checks are fleet work.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Inside the smoke script | Extend `scripts/smoke-publish.sh`, which CI already runs, so no workflow edit. No cached Playwright browsers, so slower and harder to drive the admin steps |

### Q9: Six new pages, in phases

`templates.md`, `pages-and-fragments.md`, `customize-editor.md` and `targets.md` first: they move existing text, fixing that text's audit findings. Then `publishing.md` (publish, undo, history) and `cli.md` (every command and flag), which are mostly new writing. After #1272 merges; one page per PR.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Four pages | Only the pages that move existing text: templates, pages and fragments, customizing the editor, targets. No CLI reference or publishing guide |
| Tutorial plus one guide | The tutorial, and everything else in one "Guide" page. Keeps the mix of how-to and reference the audit found |

### Q10: Placement in #1272's groups

`publishing.md` in Start, after the tutorial; `targets.md` first in Deploy; `templates.md`, `pages-and-fragments.md` and `customize-editor.md` in Content and templates; `cli.md` in Admin and operations. No new group.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Add a Reference group | A fifth group for cli.md and targets.md. Reopens #1272's four-group decision for two pages |

### Q11: Five defaults

(a) No stated time until measured, then the testers' median rounded up. (b) CI runs it on every PR and push to main, plus weekly and after each release against npm. (c) The undo step is marked as an expected failure until #1092 lands, so CI shows the day it starts working. (d) The split lands after #1272 merges. (e) A "How Gazetta works" explanation page comes later; the tutorial's opening and recap carry it for Stage 1.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Go through them | I'll ask each one separately with its alternatives |

### Q12: The tester protocol is settled before round 1

A short round of its own, once the tutorial's preconditions (#1284, #1300, #1304 and the rest) are close: whether undo counts, AI assistants, live or recorded sessions, the pass rule, recruiting, an incentive, recording, retention, legal basis, whose machine, the starting page, publishing results. Tester round 1 can't start before it.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Now | Go through all 12 in this design round |

## UX check

Follows from Q1–Q4. Rule 23: the reader does one thing per step and sees its effect; nothing is explained before it's needed.

| # | Step | What the reader does and sees |
|---|---|---|
| — | Opening | What Gazetta is in one sentence; what they'll do (create a site, edit it in the admin, publish it to a second target, undo the publish); Node 22.22.2+ or 24.15+ (#1304); no accounts |
| 1 | Create a site | `npx gazetta init my-site`, `cd my-site`. `init` installs dependencies itself. One line on what was created: a home page, a header, templates, and two targets, `local` and `staging` |
| 2 | Start the dev server | `npx gazetta dev`; open localhost:3000, then localhost:3000/admin. Leave it running |
| 3 | Publish to staging | In the admin: Publish → staging → Publish. The first publish copies the whole site |
| 4 | Look at staging as a visitor | Second terminal: `npx gazetta serve staging --port 3001`; open localhost:3001 |
| 5 | Edit the home page | Open Home, select the hero, change its title, Save. localhost:3000 shows it; localhost:3001 doesn't: staging changes only when you publish |
| 6 | Publish the change | Publish → staging again; reload localhost:3001 |
| 7 | Undo the publish | Click Undo in the publish result; reload localhost:3001 and the old title is back. The edit is still in the admin: undo changed staging, not `local` |
| — | What you did | A target holds the whole site; Publish copies content between targets; each target keeps its own history |
| — | Next steps | "Put it online" (cloudflare.md, self-hosted.md), then templates, customizing the editor, targets |
| — | If something goes wrong | Unsupported Node (#1304), `init`'s npm install failed (#1300), port in use (#1184), Ctrl+C stops a server |

About 900–1,100 words and five shell blocks. At least one highlighted code block, which `deploy-site.yml`'s check on `/docs` needs.

## The CI check

Follows from Q5, Q6, Q8 and Q11.

1. The `tutorial` job downloads `pack`'s tarball and starts Verdaccio with a config whose `gazetta` rule has no proxy; everything else proxies npmjs.
2. It publishes the tarball under its own version, points npm at Verdaccio (`npm_config_registry`, an empty `npm_config_cache`) and works in a temp directory outside the repo, so `init`'s own `npm install` gets the tarball.
3. `tests/tutorial/getting-started.spec.ts` (its own Playwright config) holds the step table: command, background or not, ready URL, checks. Its first test reads `docs/getting-started.md`, extracts the fenced shell blocks in order and fails if they differ from the table. Steps 1–6 are `test.step`s of one test, named after their headings; the servers are started once for the file, so later tests reuse them. Step 7 (undo) is a separate test in the same serial group, after it. Admin steps reuse `tests/e2e/pages/*`.
4. Checks: init exits 0 without "npm install failed" and writes `local` and `staging`; the lockfile integrity matches the tarball; `dev` answers on 127.0.0.1:3000 and `/admin`; the publish result shows success; `serve` on 3001 shows the old title after the edit and the new one after the publish; undo brings the old one back. Until #1092 lands, only step 7's own test is marked `test.fail()` (linked to #1092): Playwright applies `test.fail()` to a whole test, so marking a test that also held steps 1–6 would hide their failures; both servers still running at teardown.
5. The weekly and after-release run uses the same spec with no Verdaccio, installing from npmjs and reading the tutorial from the release tag: the check that a release on npm matches the docs.

## Foundational checks

Docs and CI, no product surface: multi-instance, scale, themes, auth, audit, review, hooks, render, validation, plugin, cache, offline and collaboration are N/A. Locale: the tutorial is English, like the docs. The docs pipeline (#1272) is the one constraint: no raw HTML outside code, every page classified in `docs-nav.json` and listed in AGENTS.md.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `targets.md`: target types, storage factories with every required key and peer-dependency install, `type`, `environment`, `editable`, `publicStorage`, `history`, `siteUrl`, `cache` (dynamic targets only), secrets and `.env`, relative paths | #1272 | docs | Low |
| 2 | `templates.md`: the template contract, `head`, frameworks, composites | #1272 | docs | Low |
| 3 | `pages-and-fragments.md`: `page.json`, routes, dynamic routes, fragments, the 404 page, translations, layout | #1272 | docs | Low |
| 4 | `customize-editor.md`: custom editors, custom fields, `admin/theme.css` | #1272 | docs | Low |
| 5 | `publishing.md`: publishing from the admin and the CLI, the sync chip and dots, production confirmation, undo, rollback and history | #1272 | docs | Low |
| 6 | `cli.md`: every command, argument and flag, default ports and `--host`, auto-detection, CI behaviour, exit codes | #1272 | docs | Low |
| 7 | The tutorial: `docs/getting-started.md` rewritten as the UX table above; the spec, the Verdaccio config, the integrity check and an npm script that runs them | 1–4, #1284, #1300, #1304 | e2e-first | Medium |
| 8 | The `tutorial` CI job, and the weekly and after-release run (maintainer PR: workflow files) | 7 | (CI) | Low |
| 9 | Tester round 1 on a release candidate (Q7, Q12) | 7, 8, the tester protocol round | (manual) | Medium |
| 10 | When #1092 lands: remove `test.fail()` from the undo step; tester round 2 includes undo | 9, #1092 | e2e | Low |

Cuts 1–7 go to feature-bot through a planner issue. The tutorial waits for pages 1–4 so the text it drops already has a home.

Decided: maintainer, 2026-10-24 (#1338)

| Rejected | Shown to the maintainer as |
|---|---|
| Tutorial first | Rewrite the tutorial (cut 7) right after #1272 and the preconditions, moving the other text to a temporary "More" page until pages 1-6 land. Reaches the CI check sooner; the temporary page is extra churn |

Each page cut moves its text out of getting-started and fixes that text's open audit findings (#1310–#1312 may have fixed some in place first), with its `docs-nav.json` entry, AGENTS.md line and generated page in the same PR, as #1272's check requires.

## Migration

None: no production users. Links to getting-started's sections: none today (README.md:138 describes the page; it changes with cut 7).

## Open questions

1. The tester protocol (Q12).
2. Whether `smoke`'s Ubuntu leg can be dropped once the tutorial job is stable.

## Future directions

- A "How Gazetta works" explanation page (Q11).
- A StackBlitz button that opens an `init`-made site, after the release (research of 2026-10-24: the released 0.8.0 runs there).

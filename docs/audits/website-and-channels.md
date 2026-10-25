# Website and channels for gazetta.studio

**Question:** what should gazetta.studio, the repo, the npm page and every other channel do for Gazetta at its current stage, and in what order should each channel open?

**Why asked:** the site sends almost nobody anywhere, and the path it offers newcomers breaks. In the 14 days to 2026-10-24 the repo had 30 unique visitors, and one came from gazetta.studio. The site's "Get Started" leads to docs written for `main`, while `npx gazetta init` installs npm's 0.8.0 from May, about 780 commits behind ([#1178](https://github.com/gazetta-studio/gazetta-studio/issues/1178)). The npm page has no README. Meanwhile three outside contributors, working with AI agents, found the repo on their own in October and merged 36 PRs.

**Provenance:** compiled on 2026-10-24 in one Claude Code session, from eight research agents and direct checks. Repo facts were read on `main` at `a94488a1`; external claims were fetched that day, with the URL given. "Unverified" means it couldn't be confirmed from a primary source. Outcome evidence (Hacker News points, star counts, self-reported revenue) is correlational: no source measures how many site visitors go on to install a tool, and no source shows that a site strategy caused adoption. Time costs are estimates.

## Where Gazetta stands (2026-10-24)

| Channel | State |
|---|---|
| gazetta.studio | Three pages. Home: hero "The CMS that stores nothing", a "How it works" section, a "Why not a traditional CMS?" table, an animated quick start, "Get Started" → /docs. Docs: one long page, an older hand-copied version of the repo's `docs/`. Blog: a placeholder. Built and published with Gazetta (R2 + a Cloudflare Worker), which the site doesn't say; the footer reads "Built with Claude Code" and links to GitHub, CONTRIBUTING.md and the licence. |
| GitHub repo | Public since 2026-04-05. 0 stars, 4 forks. 30 unique visitors in 14 days; referrers: github.com, Google, app.intercom.com and gazetta.studio, one visitor each. CONTRIBUTING.md, `good first issue` and `ready-for-agent` labels, AGENTS.md, public design docs. The README's quick start is for contributors ([#1189](https://github.com/gazetta-studio/gazetta-studio/issues/1189)). |
| npm ([gazetta](https://www.npmjs.com/package/gazetta)) | `latest` 0.8.0, published 2026-05-14; 12 versions since 0.1.0. No README: `packages/gazetta/` has none and the package ships only `dist/` and `admin-dist/`. Description, keywords, MIT, links to the site, repo and issues are filled in. Downloads per month, May to October: 1,857, 465, 307, 316, 175, 990 (bots and mirrors included, so an upper bound). |
| Outside contributors | Since 1 October: mangomac 30 merged PRs (opened over about 2.6 days), Vidit-Yadav 5, Golden007-prog 1, Oikantik Basu 1 commit. Golden007-prog's PR says "implemented and validated with Codex"; the maintainer reports the others work with agents too. Their PRs update the matching design docs, as AGENTS.md asks. mangomac's #1253 fixed [#1191](https://github.com/gazetta-studio/gazetta-studio/issues/1191) (an editor could publish to production). How they found Gazetta is unknown. |
| Delivery | Eleven bots (triage, discovery prep, cut planning, features, fixes, reviews, review on comment, flaky tests, mutation tests, mutation scope, dead code), the roadmap-board sync, and local Claude Code, which handles PRs and brings the maintainer only decisions. The scarce resource is the maintainer's decisions, not review time. |
| First run | A new site has one target, so its first publish goes nowhere ([#1177](https://github.com/gazetta-studio/gazetta-studio/issues/1177)). The Onboarding sprint in ROADMAP's Next targets time to first deploy. |

## What a site can be for

Thirteen main jobs came out of the research, plus three from the maintainer's ideas (contributors first, covering more with AI, the bot fleet as a story).

| Option | Evidence | Fit for Gazetta now | Verdict |
|---|---|---|---|
| **Contributors first** | Supported before 1.0: "In the early stages… Most of the interested visitors you get will be developers" ([Fogel](https://producingoss.com/en/getting-started.html)); newcomers prefer young, small, active projects with clear guidelines ([Nirmani et al. 2026](https://arxiv.org/abs/2607.25126)). Already happening here. No study shows contributors become users. | Works today: contributors run `main` | Main button now |
| **Path to a first install** | htmx 2020, Bun 2022, Vite 2021, Pages CMS, Outstatic, TinaCMS. Pages CMS had about 900 stars 11 days after a 351-point Show HN; Outstatic about 1,300 after a 203-point one | Broken today | Main button after the release |
| **A door for coding agents** | 11 of 14 CMS sites serve `llms.txt`, but no AI platform says it reads other sites' files; coding agents do ask for Markdown (see "Agent files"); Deno: "Paste this into any coding agent: Read deno.com/agents.md"; Outstatic: "Install with Claude" | Cheap: generated from the docs | Yes, as an experiment on gazetta.studio only (see "Channels by stage") |
| **Docs as the site** | Needed under every option; Elysia's, Rome's and Hono's early homepages were their docs | /docs is a third copy | Yes, one source built from the repo |
| **README as the site** | Zod (README-only through 3.0), Vite v1, Deno 2018–19, Sveltia for about two years | npm page empty | The npm README yes; the whole site no |
| **Real-world test of Gazetta** | 9 of 14 CMS sites confirmed built with their own product, 2 partly; nobody measured the effect | Already true | Yes, and say so |
| **How Gazetta is built** | No direct evidence. Unusual now that projects are closing the door to agents (see "AI-era limits") | True and documented | A door and the essay topic, not the headline |
| **Essays arguing the idea** | Strong for attention: Ghost's "Project Ghost" 502 points, Svelte 533, "Tina is not a CMS" 180 against 31 for Tina's plain Show HN. Weak for the author's own tool: the islands essay got 1 point and Astro took the benefit | — | One essay at launch |
| **Honest comparison** | Directus: "Yes, this is a Directus vs Strapi page written by Directus"; Ghost lists "cases where Ghost is not the best choice". Dozens of vs-pages (Sanity 32, Storyblok ~33) are company-scale | — | 2–3 pages, facts re-checked by a bot |
| **Posting progress in public** | Best recorded results: Ladybird's newsletters (437–507 HN points), Bevy's launch week (2,200 stars, 26 new contributors), Caleb Porzio's sponsors ($112k a year). All had an audience or a spectacle | — | Only as release notes |
| **Live demo as the site** | Excalidraw (20k weekly active users in a year), tldraw. CMS demos came after funding and are being withdrawn: Payload's public demo is gone (repo archived Feb 2026); Directus is "reviewing the future" of its sandbox | Expensive; the admin can't run in a Worker today (`jiti`, `sharp`) | Later; a Playwright video now |
| Waitlist | Only teams, before the code was public: Tailwind 2017, Astro 2021, Bun 2021, Payload 2020 | Code is MIT and public | No |
| Showcase | No outcome evidence; appears at or after 1.0 | No users yet | Not until there are users |
| Funding / sponsors | Documented only where an audience already existed | — | Later |
| Successor to an unhappy incumbent | Sveltia as the successor to Netlify/Decap CMS | No obvious incumbent | No |
| Leading with benchmarks | Bun, Hono, Elysia | The pitch is an architecture, not speed | No |
| Learning resource instead of a library | Lucia deprecated its package in March 2025 | — | No |

### Whole-site strategies

| Strategy | Verdict |
|---|---|
| A. Install path only, now | Rejected: sends visitors into a path that breaks, and a well-attended Show HN can't simply be reposted for about a year ([HN FAQ](https://news.ycombinator.com/newsfaq.html)) |
| B. Contributors only | Rejected: no user feedback, and no evidence contributors become users |
| C. Install path in stages | Rejected: sound, but ignores the contributor flow that already works |
| **D. Several doors in stages, kept true by the fleet** | **Chosen** |
| E. Lead with how it's built | Rejected: draws people interested in AI workflows rather than CMS users; some developers distrust agent-written code |
| F. README and docs only until 1.0 | Rejected: cheapest, but gives up the real-world test and does nothing more for the people already arriving |

## The plan

Every channel opens at a stage, and a stage opens only when its gate is met.

### Stages and gates

| Stage | Opens when | Main audience | Home page main button |
|---|---|---|---|
| **0. Contributors** | Now: it already works | Developers who work on code, often with agents | Contribute (with a small "Try it") |
| **1. Preview** | A release on npm matches the docs; the tutorial passes in CI; 3–5 people the maintainer watches get from install to a publish on a second target without help (#1177, #1178, #1189 fixed) | Early adopters | Use it |
| **2. Launch** | Stage 1 holds for two releases with nothing breaking for newcomers, and the essay and video are ready | The wider developer community | Use it |
| **3. Adoption** | At least 3 public sites built by other people, and users who come back | Teams choosing a CMS | Use it |
| **4. 1.0** | The maintainer is ready to promise stability | Everyone | Use it |

Stage 1 needs both checks: CI catches the docs drifting from the code, and watching people catches what CI can't, such as a step that is technically correct but confusing.

Decided: maintainer, 2026-10-24 (#1266)

| Rejected | Why |
|---|---|
| "Use it" as the main button now | It leads into the path that breaks |
| Two equal buttons | Every visitor has to choose before understanding what Gazetta is |
| Stage 1 gated on CI alone | Misses steps that pass but confuse people |

### Positioning

Who the first screen speaks to, in what words, and which alternatives the honest comparison names. It applies to the README's first lines, the home page hero and the npm description. Evidence: a demand-research round read 24 public requests, and the most specific asked to move content between local, staging and production without copying a database; "no database, just files" came up 6 times, and nobody asked for R2 or S3 as the store. An early-users round read about 700 issues of comparable CMSs: individual developers on their own blog or site came first, and builders of client sites stayed. mangomac's answer on [#1277](https://github.com/gazetta-studio/gazetta-studio/discussions/1277) says contributors aren't necessarily users.

**Audience.** The first sentence speaks to developers who run a site in more than one environment and want to move content between them, in their own words ("push it to production", "without copying a database"). The second line says content is files in your own storage, served from a Worker or any Node host.

Decided: maintainer, 2026-10-24 (#1416)

| Rejected | Why |
|---|---|
| One developer's own site first | Matches the early-users evidence, but the most specific demand is moving content between environments |
| TypeScript developers on Cloudflare first | Crowded by EmDash, and that demand was mostly "make my CMS run on Workers" |

**Category word.** Plain "CMS": "An open-source CMS that …" plus what it does. "Stateless" stays the idea of the launch essay ("Why a CMS should store nothing"), and the repo keeps its `flat-file-cms` topic.

Decided: maintainer, 2026-10-24 (#1416)

| Rejected | Why |
|---|---|
| "Stateless CMS" | Gazetta's own phrase: 0 GitHub repos use it, and nobody in the demand research said it |
| "Flat-file CMS" | Accurate, but reads as PHP (Kirby, Grav) |

**First sentence (draft).** Environments first: "An open-source CMS that publishes your site between local, staging and production, in either direction, without copying a database." Second line: "Content is files in your own storage (a folder, R2, S3 or Azure Blob), served from a Cloudflare Worker or any Node host." The maintainer writes the final wording; [#1189](https://github.com/gazetta-studio/gazetta-studio/issues/1189) changes the README.

Decided: maintainer, 2026-10-24 (#1416)

| Rejected | Draft |
|---|---|
| Problem first | "Move content from local to staging to production without copying a database." Second line: "Gazetta is an open-source CMS that keeps your pages as files in your own storage." |
| Files first | "An open-source CMS that keeps your site's content as files in your own storage instead of a database." Second line: publishing between environments |

**Comparison.** The Stage 1 honest comparison names EmDash, Payload and TinaCMS: one per architecture a chooser weighs (Cloudflare's own CMS with its database on D1, the default self-hosted TypeScript CMS, and the Git-based family).

Decided: maintainer, 2026-10-24 (#1416)

| Rejected | Why |
|---|---|
| EmDash, Payload, Strapi | Strapi's users ask most for moving content between environments, but it replaces the Git-based family |
| EmDash, Payload, Keystatic | Keystatic as the strict "no database" peer instead of TinaCMS |

**Revisit** when the first issues from people outside the project arrive after Stage 1 opens, and when users (not contributors) answer #1277.

Decided: maintainer, 2026-10-24 (#1416)

### Channels by stage

"The fleet" means the work becomes ordinary issues for the bots; "you" means it needs the maintainer's decision or words.

| Stage | Channel | What it needs | Who | Entry rules checked? |
|---|---|---|---|---|
| 0 | **GitHub README** | First screen: one sentence, a status line, Contribute, Try it (#1189) | Fleet | — |
| 0 | **GitHub topics and the good-first-issue list** | Topics set; always 3+ open good first issues, which GitHub lists on the repo's `/contribute` page | Fleet (triage-bot keeps the supply) | `/contribute` exists ✓ |
| 0 | **GitHub Discussions** | One channel, with a pinned "How did you find Gazetta?" | You turn it on | — |
| 0 | **gazetta.studio home** | Thin page; status line; "Built and published with Gazetta"; blog link removed | Fleet | — |
| 0 | **Contribute page** | "Agents welcome", what `ready-for-agent` means, which paths the maintainer reviews personally, PR response time, live list of good first issues, design docs, credits | Fleet; you approve the review rules | — |
| 0 | **Docs on the site** | Built from the repo's `docs/` instead of the hand-copied page | Fleet | — |
| 0 | **Door for coding agents** | An experiment on gazetta.studio only: its docs pages in Markdown when an agent asks for Markdown (`Accept: text/markdown`), an `llms.txt`, links to both, a link to AGENTS.md; requests to them logged by user agent | Fleet | — |
| 0 | **up-for-grabs.net** | A PR adding a YAML entry pointing at the label | Fleet | ✓ |
| 0 | goodfirstissue.dev | At least 3 open beginner-labelled issues, at least 10 contributors, a CONTRIBUTING.md; submitted through a Google Form. Waits for 10 contributors (6 accounts today) | Fleet submits once met | ✓ |
| 0 | **PR limits, ready but off** | GitHub's open-PR cap with a bypass list; on only if PRs outpace the fleet | You decide when | ✓ |
| 1 | **npm** | A release from `main` when the maintainer decides, after the Stage 1 gate; the repo's README.md copied into the package at publish ([#1280](https://github.com/gazetta-studio/gazetta-studio/issues/1280)); version and "preview" in the install line; `gazetta init` depends on `^` its own version ([#1281](https://github.com/gazetta-studio/gazetta-studio/issues/1281)) | You decide and approve; fleet does the rest | ✓ (npm updates the README only on publish) |
| 1 | **Site: Use it** | Becomes the main button; a tutorial ending in a publish and an undo, run in CI | Fleet | — |
| 1 | **Docs by version** | Default docs from the release tag; `main`'s docs at a separate "unreleased" address | Fleet | — |
| 1 | **Demo video** | Recorded by Playwright at each release | Fleet; you approve the script once | ✓ |
| 1 | **Release notes page** | A GitHub Release per version, drafted from merged PRs, breaking changes first; the site's page and the npm README link to it | Fleet; you edit | — |
| 1 | **Honest comparison** | 2–3 named alternatives, facts re-checked monthly by a bot | Fleet; you approve the wording | ✓ |
| 1 | **StackBlitz button, Codespaces as fallback** | Opens a site made with `gazetta init`, from the first release candidate on (below) | Fleet | Partly |
| 1 | **Console.dev** | Email hello@console.dev (no form) within a week or two of the release; requires "beta" or "preview" visible on the site | You submit | ✓ |
| 1 | Lists: awesome-cloudflare-selfhosted ("Blogs, CMS and docs"), awesome-cloudflare (zhuima), awesome-jamstack (CMS) | Their own contribution rules (own projects allowed if stated; awesome-cloudflare-selfhosted asks that it's "complete enough to use") | Fleet prepares; you OK each PR | ✓ |
| 1 | awesome-selfhosted | First release more than 4 months old, working install docs, maintained; **its rules forbid AI agents from opening the issue or PR or writing the entry** | You write and submit it | ✓ |
| 2 | **Show HN** | Link the repo; in the maintainer's own words | **You** | ✓ |
| 2 | **Launch essay** | "Why a CMS should store nothing", posted separately | **You** | ✓ |
| 2 | **"How Gazetta is built"** | Page plus the essay on one maintainer and a bot fleet | You write, fleet builds the page | — |
| 2 | Newsletters: JavaScript Weekly, Node Weekly | Email editor@cooperpress.com (the submit form's link is broken) | You send it | ✓ |
| 2 | Reddit: r/webdev (Showoff Saturday only, "project, not product", no LLM-written posts), r/javascript (the Showoff thread, or a link post with source), r/CloudFlare (no rules listed; ask the mods) | Read from archived copies only, since Reddit blocks automated reading | You check by hand | Partly |
| 2 | Lobsters | Accounts are invite-only | Only if invited | ✓ |
| 2 | dev.to / Hashnode | Copy of the essay pointing back to the original on gazetta.studio | Fleet | — |
| 2 | The maintainer's own social accounts | The maintainer's voice | You | — |
| when #49 ships | **Official MCP Registry** | Publish the MCP server | Fleet | ✓ |
| 3 | Showcase | A list others add to by PR | Fleet | — |
| 3 | GitHub Sponsors | A link once there's an audience | You | — |
| 3 | r/selfhosted | "Promoted apps must be production ready and have docs"; projects under 3 months old go in a megathread (archived copy) | You check by hand | Partly |
| 3 | Cloudflare and Hono ecosystem | Templates and showcases, guest posts, talks, podcasts | You choose | ✗ |
| 3 | Monthly devlog | Only if the maintainer enjoys writing | You | — |
| 4 | Docs per major version, stability policy, migration guides | — | Fleet | ✓ |
| never | Waitlist, mass comparison pages, benchmark claims, paid ads | — | — | — |
| none | Bytes (sponsorship only, which is paid); Hacktoberfest 2026 ("Pull requests and merge requests will no longer count"; re-check in October 2027); awesome-cms (needs more than 50 stars); jamstack.org's CMS list and awesome-headless-cms (Gazetta isn't headless); awesome-hono (inactive since 2023) | — | — | ✓ |

Decided: maintainer, 2026-10-24 (#1266)

**Trying the admin.** The Stage 1 try button opens StackBlitz on a site made with `gazetta init`, from the first release candidate on (a check on 2026-10-24 found the released 0.8.0 runs there); "Open in Codespaces" is the fallback, on the visitor's own GitHub allowance. No hosted demo of the admin: a demo running in the browser is revisited when Stage 2's launch traffic would justify the work.

Decided: maintainer, 2026-10-25 (#1416)

| Rejected | Why |
|---|---|
| A public live admin | Needs moderation and resets, and the admin can't run in a Worker today; Payload's public demo is gone and Directus is reviewing its sandbox |
| Per-visitor sandboxes on Cloudflare Containers | The $5/month Workers Paid plan, about 60–90 sessions a month included |
| A demo running in the browser now | The admin API, templates and storage would have to run in the browser first |
| Codespaces first | Visitors need a GitHub account and use their own allowance |

The door for coding agents covers gazetta.studio only, as part of the site; the site's docs come from the repo's Markdown anyway. Gazetta generating `llms.txt` and Markdown copies for every site it publishes stays Deferred in ROADMAP (decided 2026-10-23, #1179) until there's evidence that AI platforms read them, or an operator asks. `seo-plan.md` calls llms.txt "too early", and this research found no measure of its value either: 11 of 14 CMS sites serve one.

Decided: maintainer, 2026-10-24 (#1266)

| Rejected | Why |
|---|---|
| Keep it deferred, for gazetta.studio too (only the AGENTS.md link at Stage 0) | Gives up a cheap door for the agents outside contributors already use |
| Gazetta generates them for every site now, and gazetta.studio uses that | More work, and it reverses the 2026-10-23 decision for the product without new evidence |

Later the same day, research on agent files ("Agent files" below) split the question. No AI platform says it reads other sites' `llms.txt`, and Google says Search ignores it; coding agents (Claude Code, VS Code Copilot, OpenCode) do ask for Markdown. So the door on gazetta.studio is an experiment: the site serves its docs pages in Markdown when an agent asks for Markdown, serves an `llms.txt`, links to both, and logs requests to them by user agent. The product feature stays Deferred as two rows in ROADMAP, each with its own trigger: `llms.txt` for every site waits for evidence that AI platforms read it, or an operator asking; Markdown versions of every site's pages wait for gazetta.studio's logs to show agents fetching its Markdown docs.

Decided: maintainer, 2026-10-24 (#1268)

| Rejected | Why |
|---|---|
| Markdown by content negotiation for every Gazetta site now, as a design pass in Next | The evidence covers coding agents reading documentation; most Gazetta sites are marketing sites and blogs, whose readers' assistants fetch HTML. The worker's cache key and the templates would change before there's first-party evidence |
| `llms.txt` and Markdown copies for every site, as one design pass in Next | Builds the half with no evidence (`llms.txt`) along with the half with some |
| Leave it as #1266 merged it | One Deferred row with one trigger can't tell the two halves apart, and gazetta.studio would serve the files without measuring whether anything reads them |

### Releases (#1178)

Decided with the maintainer on 2026-10-24, answering #1178's discovery questions:

- **When:** the maintainer decides when to release, using today's process (team rule 9).
- **The next release:** after the whole Stage 1 gate, not before. 0.8.0 stays npm's `latest` until then, with no deprecation warning, although three security problems are fixed on `main` and not released: `gazetta dev` and `gazetta admin` accept connections from the network with no login (#1074), `init`'s `.gitignore` lets `.env`, history and the audit log be committed (#1075), and `gazetta serve` on a static target serves the audit log and history (#1071).
- **Release notes:** a GitHub Release per version, drafted from the merged PRs and edited, breaking changes first; the site's release notes page and the npm README link to it. The first one also covers #1158's breaking change (a filesystem target without `editable: true` is no longer editable).
- **The npm page:** the repo's README.md, copied into `packages/gazetta/` at publish ([#1280](https://github.com/gazetta-studio/gazetta-studio/issues/1280)).
- **A new site's dependency:** `gazetta init` writes `^<the CLI's own version>` instead of `*` ([#1281](https://github.com/gazetta-studio/gazetta-studio/issues/1281)); for 0.x versions the caret allows only patch updates.

Decided: maintainer, 2026-10-24 (#1282)

| Rejected | Shown to the maintainer as |
|---|---|
| Every merge publishes `next`; a bot proposes promoting it to `latest` weekly, the maintainer approves | One yes or no a week; `main` always installable as `@next` |
| A release every two weeks, cut by a bot | No decisions; whatever has landed ships |
| Every merge releases to `latest` | Fully automatic; every new site would get each merge |
| Release 0.9.0 now | Ships the three security fixes to everyone who installs today; #1177 and the newcomer bugs in a later release |
| Release after #1177 and #1181–#1184 | A new site's first run works end to end; weeks |
| Warn on install with `npm deprecate gazetta@0.8.0`, plus the status line | Every install prints it, `npx gazetta init` included; reversible |
| The status line only | People who install with npx see neither the site nor the README |
| A 0.8.1 patch with only the three fixes | A release, and the fixes may depend on other changes on `main` |
| CHANGELOG.md through Changesets | Notes written while the change is fresh, but one more file in every PR, the bots' included |
| CHANGELOG.md and GitHub Releases both | Two copies |
| A separate short README for npm | Two READMEs to keep in step |
| An npm README generated from the site | One source, but a generator to build and keep |
| An exact version in new sites (`"0.9.0"`) | No updates until the author upgrades, fixes included |
| Keep `"*"` | Every install takes npm's `latest`, breaking minors included |

### First run (#1177)

Decided with the maintainer on 2026-10-24, answering #1177's discovery questions:

- **What `gazetta init` creates:** `local` plus a `staging` target shaped like the starter's (`./dist/staging`, `publicStorage: false`, `environment: 'staging'`), served by `gazetta serve staging` ([#1284](https://github.com/gazetta-studio/gazetta-studio/issues/1284)). A new user can publish with no accounts, and staging keeps history.
- **The admin with one target:** no Publish button, as `design-editor-ux.md`'s progressive disclosure says ([#1285](https://github.com/gazetta-studio/gazetta-studio/issues/1285)).
- **`gazetta publish` with one target:** stops with a message and a docs link, and writes nothing ([#1286](https://github.com/gazetta-studio/gazetta-studio/issues/1286)).
- **Adding a public host:** a "Put it online" section in getting-started now; a command that writes the target comes with #214. No admin wizard.

Decided: maintainer, 2026-10-24 (#1282)

A new user's first live site is a local `gazetta serve` address.

Follows from "Stages and gates": Stage 1's gate is a publish on a second target by someone with no accounts.

| Rejected | Shown to the maintainer as |
|---|---|
| `init` keeps one target; the next step is in the docs | The admin's Publish leads nowhere until the user edits `site.config.ts` |
| One target plus a commented-out cloud target | Uncommented without keys, it stops `gazetta dev` (#1185) |
| `init` asks where the site will live | CI and scripted `init` need a flag for it |
| Keep Publish on a one-target site, with a pointer to adding a target | Changes the design's rule |
| No Publish button, plus a one-time hint | Rule 23 warns this can become a tooltip patching the UI |
| `gazetta publish` keeps rendering the editing target into itself and says so | Keeps today's behaviour, with output saying what happened |
| A general `gazetta target add` command now | Built here, ahead of #214 |
| An admin wizard that edits `site.config.ts` | Config is code, loaded once at boot; new auth, audit and multi-instance questions |

### Docs (#1272)

Decided with the maintainer on 2026-10-24, after research on how other CMSes publish their docs, what fits Gazetta's code, and docs tooling:

- **How the docs reach the site:** a generator (`npm run docs:site`) turns each published `docs/*.md` into a committed page under `sites/gazetta.studio/targets/local/pages/docs/`, plus one `docs-nav` fragment. A check in the core test suite fails when the committed pages differ from `docs/`. The suite is the one CI and the bots already run, so no workflow change is needed. A docs PR therefore also changes `sites/gazetta.studio/**`, which triggers the existing deploy ([#1272](https://github.com/gazetta-studio/gazetta-studio/issues/1272)).
- **Which files are published:** a list in the site (`docs-nav.json`): published docs in groups, internal files, and removed slugs. The check fails on a top-level `docs/*.md` the list doesn't classify, and on any difference from AGENTS.md's "Public docs". `adr/` and `audits/` are never published.
- **Sidebar groups:** Start (getting-started, which becomes `/docs`); Deploy (deploy, cloudflare, self-hosted, runtime-capabilities); Content and templates (content-assets, template-assets, migration, transform-adapters, soft-delete); Admin and operations (auth, audit, hooks, cache, offline).
- **Which version, now:** `main`, with one generated line on every docs page: "These docs describe Gazetta's `main` branch. The latest release on npm, 0.8.0, is older and works differently in places, and it lacks security fixes made since. To follow these docs, run Gazetta from `main`." The version comes from `packages/gazetta/package.json`, and the security clause is tied to it, so it disappears at the next release.
- **Which version, from Stage 1:** the release commit's docs at `/docs/<slug>`, and `main` at `/docs/unreleased/<slug>` with `noindex`.
- **Search:** none for now (sidebar, "On this page", the browser's find). Pagefind, built at publish and served from R2, once the docs pass about 40 pages, people report they can't find things, or Stage 2 starts. That step needs a workflow edit from the maintainer.

Decided: maintainer, 2026-10-24 (#1292)

Two details follow from generated pages. The admin refuses saves to them, naming the doc to edit instead ([#1289](https://github.com/gazetta-studio/gazetta-studio/issues/1289)). A removed or renamed doc becomes an archived page that redirects or answers 410, because publish can't yet remove a page from a target ([#1290](https://github.com/gazetta-studio/gazetta-studio/issues/1290)).

Follows from the generated-pages decision above.

| Rejected | Shown to the maintainer as |
|---|---|
| Generate the pages at deploy, nothing committed | Two workflow edits; no docs in `gazetta dev` or the admin; render errors only at deploy |
| A Gazetta feature for Markdown pages | Weeks of work; ROADMAP keeps it deferred |
| Starlight or VitePress on a subdomain | The docs stop being built with Gazetta |
| The worker fetches Markdown from GitHub per request | No target holds the content; GitHub becomes a runtime dependency |
| Edit in the admin, export to `docs/` | Inverts the source AGENTS.md gives bots and contributors |
| Thin pages whose template reads `docs/*.md` | A docs-only edit would never reach production (publish is incremental and the hash doesn't cover files a template reads; inferred from code) |
| Link to GitHub instead | Reverses #1266 |
| The generator reads AGENTS.md's list directly | Navigation tied to the prose layout of agent instructions; no room for order, groups or redirects |
| Publish every top-level doc unless excluded; a front-matter flag; separate folders; an underscore prefix | Leaks new internal files, shows on GitHub, or breaks existing links |
| Docs from the v0.8.0 tag; `main` with no line; both versions now | Describes code 900 commits old; contradicts what npm installs with no hint; versions a release nobody is meant to use |
| The line without the security clause | The same line without "and it lacks security fixes made since" |
| `main` at its own host from Stage 1; one tree held until release; a copy per release | More operations; release-held docs PRs; fixes in every copy |
| Pagefind now; another search library or service | A worker route and a workflow edit now; DocSearch usually refuses sites that aren't production ready |
| One flat sidebar list; the fleet proposes groups | Harder to scan; one more review |

### Agent-files experiment (#1273)

Decided with the maintainer on 2026-10-24, after research on how published studies measured agent traffic and how Gazetta's worker serves pages:

- Everything runs in gazetta.studio's own worker middleware, with no product change; the Markdown comes from each docs page's `page.json`, already in R2.
- Requests are logged to Workers Analytics Engine (three months' retention), with no IP addresses, cookies or full referrers stored; flags such as "IP matches the operator's published ranges" and "the maintainer's own traffic" are computed in memory and only the booleans kept.
- The project's own traffic is excluded: probe URLs, the deploy check, the maintainer's own address, and the fleet's own fetches.
- Steps: a one-week shakedown, four weeks with Markdown and `/llms.txt` served but linked from nowhere, then four weeks linked from the pages, the footer, the README and AGENTS.md.
- The rule, fixed before counting: over the eight counted weeks, at least 10 organic Markdown responses on at least 5 days from at least 2 agent families moves the Deferred Markdown row to a design pass (every page of every site in scope if at least 5 Markdown requests reach non-docs pages, otherwise an opt-in); 2 or fewer keeps it Deferred; anything between gets one eight-week extension, then the same rule. `/llms.txt` fetches are reported separately, against that row's own trigger.

Decided: maintainer, 2026-10-24 (#1292)

| Rejected | Shown to the maintainer as |
|---|---|
| Shorter steps (2 + 2 weeks) | Likely too few events on a small site to apply the rule |
| Set the rule after seeing the numbers | Any result can then be read as support |

### How it runs

- **One rule for every channel:** a check keeps it true (it fails when the channel drifts from the code or the release), or the maintainer writes it. Doors that need users wait until there are users.
- **At each gate the maintainer decides to open the next stage** and closes any channel that brought nothing: one decision per stage, not one per channel.
- **What tells a stage is working:** Stage 0, outside PRs merged and contributors coming back; Stage 1, strangers finishing the tutorial and issues from strangers; Stage 2, other people's sites and returning users. Stars and npm downloads aren't measures: both are easy to inflate.
- **The maintainer's own words are needed only for** the Show HN post, the essays, the comparison wording, release approvals and social posts. Everything else is fleet work.

Decided: maintainer, 2026-10-24 (#1266)

| Rejected | Why |
|---|---|
| Write everything by hand, as competitors did before AI | The fleet makes producing and checking cheap; the maintainer's decisions are what's scarce |
| Let AI write anything, including the Show HN post and essays | HN: "Don't post generated text or AI-edited text." |
| Many AI-written comparison pages for search | Google's spam policy on scaled content abuse |
| Stars or npm downloads as targets | Both are inflated by bots and fake stars; they follow use, they don't measure it |

Docs quality belongs to this plan: the Claude Code session that runs it also owns whether the public docs are correct, complete and well structured, along with the site, the README, getting-started and the Stage 1 tutorial. Its helper session audits one doc at a time against the code, starting with getting-started. Each finding becomes an issue for the fleet, and AGENTS.md's same-PR rule keeps the docs in step after that. Doc changes inside bot PRs stay with the PR-shepherding session.

Decided: maintainer, 2026-10-24 (#1307)

| Rejected | Shown to the maintainer as |
|---|---|
| A separate docs session | Full attention on doc quality, but a third session to coordinate, overlapping with this plan (pipeline, tutorial, getting-started) and with doc changes in bot PRs |
| Leave it as it is | Doc mistakes are found only by chance, as in the onboarding walk, and Stage 1's tutorial has no owner |

A separate docs session can follow if the audits find more than the helper can handle, or Stage 2 needs a lot of new writing.

## Evidence

### Early-stage sites: one screen, one artefact that persuades

From Wayback Machine captures of 13 developer tools and 13 CMSes at their first public release.

- **At first release the homepage was close to the docs:** one sentence naming what the tool replaces, one command to copy, links to docs, GitHub and chat. htmx's launch-day homepage led with a `<script>` tag for `htmx.org@0.0.4` ([Wayback 2020-05-27](https://web.archive.org/web/20200527230045/https://htmx.org/)) and drew 728 points ([HN 23330881](https://news.ycombinator.com/item?id=23330881)). Bun's put "Install Bun CLI v0.1.0 (beta)" above `curl https://bun.sh/install | bash` ([Wayback 2022-07-07](https://web.archive.org/web/20220707000604/https://bun.sh/)) and drew 1,431 ([HN 31993429](https://news.ycombinator.com/item?id=31993429)).
- **Many lived in the README for years and still grew.** Zod was README-only from 1.0.0 (March 2020) through 3.0.0 (May 2021); zod.dev began as a docsify render of the README ([Wayback 2022-05-20](https://web.archive.org/web/20220520135716/https://zod.dev/)). Vite's site appeared the day 2.0.0-beta.1 shipped ([Wayback 2021-01-02](https://web.archive.org/web/20210102072515/https://vitejs.dev/)). Deno's 2018 site was a link to GitHub ([Wayback 2018-10-26](https://web.archive.org/web/20181026024522/https://deno.land/)).
- **Waitlists belonged to teams with an audience and code that wasn't public:** Tailwind ([Wayback 2017-10-22](https://web.archive.org/web/20171022184449/https://tailwindcss.com/)), Bun's "Request early access" ([Wayback 2021-10-29](https://web.archive.org/web/20211029082214/https://bun.sh/)), Payload's "Get Email Updates" ([Wayback 2020-09-21](https://web.archive.org/web/20200921065550/payloadcms.com)). None of the solo-run projects in the sample ran one.
- **For solo CMSes, stars followed one Hacker News thread.** Pages CMS: 351 points ([HN 39467132](https://news.ycombinator.com/item?id=39467132)), about 900 stars 11 days later. Outstatic: 4 points on its first Show HN ([HN 32973903](https://news.ycombinator.com/item?id=32973903)), then 203 a month later ([HN 33306029](https://news.ycombinator.com/item?id=33306029)) and about 1,300 stars 2.5 weeks after. A weak first attempt was recoverable.
- **A landing page alone often didn't explain a new CMS.** On Pages CMS's thread a visitor wrote that they "really didn't get a grasp of what it was offering or how it worked… Only after I watched the video", and that "It's over 2 minutes before the background of the video even changes"; the maintainer agreed ([HN 39467132](https://news.ycombinator.com/item?id=39467132)).
- **Status was one plain line next to the install.** Vite: "highly experimental… not suitable for production use". Keystatic's 2023 banner: "read this website the way you would a poster for an unreleased movie", beside "Take it for a (really early) spin" ([Wayback 2023-02-26](https://web.archive.org/web/20230226180226/keystatic.thinkmill.com.au/)).
- **"No database" is crowded:** Kirby, Statamic, Keystatic, Outstatic and Pages CMS all led with it. Gazetta's sharper claims are that the CMS keeps no state at all, that publishing works in either direction between any two targets, and that every target keeps its own history.

### CMS sites today (checked 2026-10-24)

Fourteen sites: Payload, Sanity, Strapi, Storyblok, Directus, TinaCMS, Decap, Keystatic, Pages CMS, Outstatic, Ghost, Statamic, Kirby, Craft.

- The hero is a one-line claim with two calls to action; six put a copyable scaffold command in the hero.
- 11 of 14 serve `llms.txt`; 9 of 14 offer a Markdown copy of each page or copy/"Open in ChatGPT/Claude" buttons.
- 9 confirmed building their site with their own product, 2 partly. Payload, TinaCMS, Statamic and Kirby render their docs with it.
- The lowest-friction try paths: Kirby's `/try` (one click, no login, "erased after an hour") and Decap's demo, which runs in the browser and resets on reload.
- A dormant blog makes a project look stale: Keystatic has one post, from June 2023.

### Go-to-market guidance

- **Show HN** ([guidelines](https://news.ycombinator.com/showhn.html)): "If your work isn't ready for users to try out, please don't do a Show HN." "Please make it easy for users to try your thing out, ideally without barriers such as signups or emails." "Don't post landing pages or fundraisers." "The community is comfortable with work that's at an early stage."
- **PostHog** launched on HN only once "Users could sign up and use the product without our help" ([newsletter](https://newsletter.posthog.com/p/how-we-got-our-first-1000-users)).
- **Supabase's** jump came from one tagline, "Open-source Firebase alternative", not a redesign ([First Round Review](https://review.firstround.com/how-supabase-became-the-essential-infrastructure-for-the-ai-era-paul-copplestone-co-founder-ceo/)).
- **How developers choose libraries** (Larios-Vargas et al., [arXiv 2005.12574](https://arxiv.org/pdf/2005.12574)), share rating each factor highly influential: maturity and stability 62%, usability 55%, documentation 51%, licence 45%, active maintenance 44%, popularity 30%. A company behind a library raises trust, which a solo project can't claim, so visible activity matters more.
- **Console** ([criteria](https://console.dev/selection-criteria)) lists pre-1.0 tools and requires "the word 'beta', 'preview' or similar" to be easy to find on the site.
- **Where sources disagree:** "launch early and often" (YC, opensource.guide) against "don't launch until it works without you" (Show HN, PostHog). Read together: share early with small audiences, and save Show HN for when a stranger can succeed alone.

### Contributors

- **The usual path runs from user to contributor.** Ye & Kishida's onion model: "New members are attracted to an OSS community because the system can solve one of their own problems" ([ICSE 2003](https://web.archive.org/web/20240511112739/https://flosshub.org/sites/flosshub.org/files/YeKishida.pdf)). Needing the software is the most common reason to start (Lakhani & Wolf 2005; Gerosa et al., [ICSE 2021](https://arxiv.org/abs/2101.10291)). No study measures contributors becoming users.
- **Most leave.** Casual contributors are 48.98% of contributors and made 1.73% of commits (Pinto et al., [SANER 2016](https://web.archive.org/web/20240415202212/https://www.ime.usp.br/~gerosa/papers/saner2016.pdf)).
- **Fast attention keeps them.** Newcomers who had an issue fixed in their first month doubled their odds of becoming long-term contributors (Zhou & Mockus, [TSE 2015](https://doi.org/10.1109/tse.2014.2349496)).
- **Projects that grew contributors first** (SerenityOS, Ladybird, Rust, Zig, Servo) all had large outside attention and a founder who used the software every day.
- **Netlify CMS** had three equal buttons in April 2017, including "Make it better →" to the contributor guide ([Wayback](https://web.archive.org/web/20170403193340/https://www.netlifycms.org/)); by December one main button, with "Contributing" in the nav ([Wayback](https://web.archive.org/web/20171203100426/https://www.netlifycms.org/)).
- **Fogel:** "One of the worst things a project can do is attract users before the software is ready for them" ([Producing OSS](https://producingoss.com/en/getting-started.html)).

### AI-era limits

- **Hacker News guidelines** ([page](https://news.ycombinator.com/newsguidelines.html)): "Don't post generated text or AI-edited text."
- **Google** ([spam policies](https://developers.google.com/search/docs/essentials/spam-policies)): scaled content abuse is "when many pages are generated for the primary purpose of manipulating search rankings and not helping users… no matter how it's created", including "Using generative AI tools… to generate many pages without adding value for users".
- **Projects are closing the door to agent PRs:** Ladybird stopped accepting public pull requests in June 2026 ([post](https://ladybird.org/posts/changing-how-we-develop-ladybird/)); Ghostty auto-closes PRs from people not vouched for ([CONTRIBUTING](https://github.com/ghostty-org/ghostty/blob/main/CONTRIBUTING.md)); LLVM: "AI tools must not be used to fix GitHub issues labelled good first issue" ([policy](https://llvm.org/docs/AIToolPolicy.html)); curl ended its bug bounty on 31 January 2026 ([post](https://daniel.haxx.se/blog/2026/01/26/the-end-of-the-curl-bug-bounty/)).
- **GitHub:** "The cost to create has dropped but the cost to review has not" ([12 Feb 2026](https://github.blog/open-source/maintainers/welcome-to-the-eternal-september-of-open-source-heres-what-we-plan-to-do-for-maintainers/)). Repos can restrict PRs to collaborators ([13 Feb 2026](https://github.blog/changelog/2026-02-13-new-repository-settings-for-configuring-pull-request-access/)) and cap open PRs from users without write access, with a bypass list ([17 Jun 2026](https://github.blog/changelog/2026-06-17-limit-open-pull-requests-for-users-without-write-access/)).
- **Gazetta's position is the opposite:** its fleet makes review cheap and fast, and fast attention is what keeps newcomers. "Agents welcome" is a real difference (inference).

### Ways to try it

- **Cheap now:** a Playwright-recorded video ([Playwright: `video: 'on'`](https://github.com/microsoft/playwright/blob/main/docs/src/videos.md)); an "Open in Codespaces" button (visitors use their own GitHub allowance, [billing](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)).
- **StackBlitz** needs a test: native modules don't run in WebContainers, `sharp` has a WebAssembly build, and whether Gazetta's Node 22 floor and `gazetta dev` work there is unverified. The WebContainer API needs a commercial licence for production use ([page](https://webcontainers.io/enterprise)); an "Open in StackBlitz" link to the repo uses StackBlitz's own product.
- **Per-visitor sandboxes** on Cloudflare Containers need the $5/month Workers Paid plan ([pricing](https://developers.cloudflare.com/containers/pricing/)); an estimate from that page puts it at about 60–90 included sessions a month, then about $6 per 1,000.
- **A demo in the browser** (Decap's and Sveltia's model) costs nothing to host and has nothing to moderate, but needs the admin API, templates and storage to run in the browser.

### Agent files (checked 2026-10-24)

- **Google:** "It's completely fine if you decide to create and maintain LLMS.txt files … for other services or systems that use these files. Doing so will neither harm nor help your site's visibility or rankings in Google Search, as Google Search ignores them" ([AI optimization guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide), updated 2026-07-10).
- **OpenAI, Anthropic and Perplexity** document their crawlers and assistants ([OpenAI](https://developers.openai.com/api/docs/bots), [Anthropic](https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler), [Perplexity](https://docs.perplexity.ai/guides/bots)) without saying they read other sites' `llms.txt`. They publish their own for their developer docs.
- **Server logs:**
  - Ahrefs, 137,210 domains in May 2026: 97% of the `llms.txt` files got no requests at all ([study](https://ahrefs.com/blog/llmstxt-study/)).
  - 83 small-business sites over 12 weeks: OpenAI fetched `llms.txt` 7 times against 3,990 `robots.txt` fetches; Anthropic 9 against 3,120; Perplexity 0 against 775 ([EZY Research](https://www.ezy.ai/research/do-ai-bots-read-llms-txt)).
  - Claude Code received Markdown on 76% of 23,300 requests to one site that offers it ([Evil Martians](https://evilmartians.com/chronicles/which-ai-actually-reads-your-site-two-months-of-llm-traffic-measured)), and on about 98 in 100 at another ([GoodBarber](https://www.goodbarber.com/blog/do-ai-agents-read-markdown-what-two-weeks-of-our-own-server-logs-say-a1622/)). ChatGPT, Claude.ai, Perplexity and Googlebot fetched HTML.
  - All of these are vendors' or site owners' own measurements, classifying bots by user agent.
- **Coding agents:** Claude Code's WebFetch sends "an `Accept` header that prefers Markdown over HTML so servers that support content negotiation can return Markdown directly" ([tools reference](https://code.claude.com/docs/en/tools-reference.md)). VS Code's Copilot and OpenCode ask for Markdown in their source code. No coding agent documents fetching `llms.txt` unprompted; agents read it when a page links to it.
- **The spec:** llms.txt v2 (August 2026) puts each page's Markdown copy "at the same URL as the original page, either with .md appended (page.html.md) or with the extension replaced by .md (page.md)", or `index.md` for addresses without a file name, and links it with `rel="alternate" type="text/markdown"` and `rel="describedby"` ([llmstxt.org](https://llmstxt.org/)). No standards body handles it.
- **Cloudflare:** "Markdown for Agents" converts HTML to Markdown when asked, but its docs list Pro, Business, Enterprise and SSL for SaaS, not the Free plan, and don't say whether pages a Worker generates are converted ([docs](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/)). AI Crawl Control, on all plans, has a Content Format chart of what AI systems request against what the origin serves ([docs](https://developers.cloudflare.com/ai-crawl-control/features/analyze-ai-traffic/)).
- **gazetta.studio today:** `/llms.txt` answers 404, and a request asking for Markdown gets the cached HTML. The worker caches by address and publish generation, so Markdown responses would need the format in the cache key.
- **The experiment's design** is decided under "Agent-files experiment (#1273)" above.

### Docs and release sync

- Build the default docs from the latest release tag and put `main`'s docs at an "unreleased" address, as Vite does (`main.vite.dev`).
- Put the version in the install line, as Bun ("Install Bun v1.4.4") and Deno ("Install Deno 2.9.8") do, so drift shows at once.
- Don't version docs before 1.0: "If your documentation rarely changes, don't add versioning" ([Docusaurus](https://docusaurus.io/docs/versioning)).
- Static search without a service: Pagefind ([repo](https://github.com/CloudCannon/pagefind), MIT). Algolia DocSearch "usually turn[s] down applications when they are not production ready" ([eligibility](https://docsearch.algolia.com/docs/who-can-apply/)).

## Open items

- **How the October contributors found Gazetta, and whether any of them uses it for a site.** mangomac answered on #1277 (2026-10-24): through GitHub issue search, where the `ready-for-agent` label and the issues' acceptance criteria stood out; they contribute and don't use Gazetta for a site. The others haven't answered yet.
- **Channel rules checked on 2026-10-24** (rows above). Reddit's are read from archived copies only, since Reddit blocks automated reading; re-check them by hand before posting.
- **The StackBlitz test** (Node version, `sharp`, `gazetta dev` on port 3000).
- **Stage 1 also waits on publish undo.** The tutorial ends with an undo, but undo on a publish destination doesn't yet change what visitors see; that's what publish undo fixes ([#1092](https://github.com/gazetta-studio/gazetta-studio/issues/1092), in Now).

## Fact-check ledger

| Claim | Status |
|---|---|
| HN points for every thread cited | Verified: HN Algolia API, 2026-10-24; six re-checked by hand |
| Show HN and HN guideline quotes | Verified: fetched |
| Early homepage wording and calls to action | Verified: Wayback captures at the timestamps linked |
| Past star counts (Pages CMS, Outstatic) | Verified: archived GitHub pages; day-level star curves unavailable |
| CMS sites today (llms.txt, dogfooding, demos, comparisons) | Verified: fetched 2026-10-24 by a research agent; headlines re-fetched |
| Library-selection percentages, onion model, retention studies | Verified: papers read |
| GitHub PR-limit features, Ladybird, Ghostty, LLVM, curl | Verified: re-fetched by the research agent |
| Google's scaled content abuse policy | Verified: fetched |
| Gazetta's repo, npm and traffic figures | Verified: GitHub API and npm registry, 2026-10-24 |
| Cloudflare Containers session estimate | Inference from the pricing page |
| Google ignores `llms.txt`; Claude Code asks for Markdown | Verified: fetched 2026-10-24 |
| `llms.txt` and Markdown server-log figures (Ahrefs, EZY, Evil Martians, GoodBarber) | Third-party measurements: read, method not audited |
| VS Code Copilot and OpenCode ask for Markdown | Verified by the research agent in their source code; not re-checked |
| "Agents welcome" as a difference; no study of contributors becoming users | Inference; searched, nothing found |
| Time costs | Estimates; no source gives hours |

# Website and channels for gazetta.studio

**Question:** what should gazetta.studio, the repo, the npm page and every other channel do for Gazetta at its current stage, and in what order should each channel open?

**Why asked:** the site sends almost nobody anywhere, and the path it offers newcomers breaks. In the 14 days to 2026-10-24 the repo had 30 unique visitors, and one came from gazetta.studio. The site's "Get Started" leads to docs written for `main`, while `npx gazetta init` installs npm's 0.8.0 from May, about 780 commits behind ([#1178](https://github.com/gazetta-studio/gazetta-studio/issues/1178)). The npm page has no README. Meanwhile three outside contributors, working with AI agents, found the repo on their own in October and merged 36 PRs.

**Provenance:** compiled on 2026-10-24 in one Claude Code session, from eight research agents and direct checks. Repo facts were read on `main` at `a94488a1`; external claims were fetched that day, with the URL given. "Unverified" means it couldn't be confirmed from a primary source. Outcome evidence (Hacker News points, star counts, self-reported revenue) is correlational: no source measures how many site visitors go on to install a tool, and no source shows that a site strategy caused adoption. Time costs are estimates.

## Where Gazetta stands (2026-10-24)

| Channel | State |
|---|---|
| gazetta.studio | Three pages. Home: hero "The CMS that stores nothing", a "How it works" section, a "Why not a traditional CMS?" table, an animated quick start, "Get Started" → /docs. Docs: one long page, an older hand-copied version of the repo's `docs/`. Blog: a placeholder. Built and published with Gazetta (R2 + a Cloudflare Worker), which the site doesn't say. |
| GitHub repo | Public since 2026-04-05. 0 stars, 4 forks. 30 unique visitors in 14 days; referrers: github.com, Google, gazetta.studio (1). CONTRIBUTING.md, `good first issue` and `ready-for-agent` labels, AGENTS.md, public design docs. The README's quick start is for contributors ([#1189](https://github.com/gazetta-studio/gazetta-studio/issues/1189)). |
| npm ([gazetta](https://www.npmjs.com/package/gazetta)) | `latest` 0.8.0, published 2026-05-14; 12 versions since 0.1.0. No README: `packages/gazetta/` has none and the package ships only `dist/` and `admin-dist/`. Description, keywords, MIT, links to the site, repo and issues are filled in. Downloads per month, May to October: 1,857, 465, 307, 316, 175, 990 (bots and mirrors included, so an upper bound). |
| Outside contributors | Since 1 October: mangomac 30 merged PRs (opened over about 2.6 days), Vidit-Yadav 5, Golden007-prog 1, Oikantik Basu 1 commit. Golden007-prog's PR says "implemented and validated with Codex"; the maintainer reports the others work with agents too. Their PRs update the matching design docs, as AGENTS.md asks. mangomac's #1253 fixed [#1191](https://github.com/gazetta-studio/gazetta-studio/issues/1191) (an editor could publish to production). How they found Gazetta is unknown. |
| Delivery | Twelve bots (triage, discovery prep, cut planning, features, fixes, reviews, review on comment, flaky tests, mutation tests, mutation scope, dead code, the roadmap board) plus local Claude Code, which handles PRs and brings the maintainer only decisions. The scarce resource is the maintainer's decisions, not review time. |
| First run | A new site has one target, so its first publish goes nowhere ([#1177](https://github.com/gazetta-studio/gazetta-studio/issues/1177)). The Onboarding sprint in ROADMAP's Next targets time to first deploy. |

## What a site can be for

Thirteen main jobs came out of the research, plus three from the maintainer's ideas (contributors first, covering more with AI, the bot fleet as a story).

| Option | Evidence | Fit for Gazetta now | Verdict |
|---|---|---|---|
| **Contributors first** | Supported before 1.0: "In the early stages… Most of the interested visitors you get will be developers" ([Fogel](https://producingoss.com/en/getting-started.html)); newcomers prefer young, small, active projects with clear guidelines ([Nirmani et al. 2026](https://arxiv.org/abs/2607.25126)). Already happening here. No study shows contributors become users. | Works today: contributors run `main` | Main button now |
| **Path to a first install** | htmx 2020, Bun 2022, Vite 2021, Pages CMS, Outstatic, TinaCMS. Pages CMS had about 900 stars 11 days after a 351-point Show HN; Outstatic about 1,300 after a 203-point one | Broken today | Main button after the release |
| **A door for coding agents** | 11 of 14 CMS sites serve `llms.txt`; Deno: "Paste this into any coding agent: Read deno.com/agents.md"; Outstatic: "Install with Claude" | Cheap: generated from the docs | Yes |
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

Decided: maintainer, 2026-10-24 (#PR)

| Rejected | Why |
|---|---|
| "Use it" as the main button now | It leads into the path that breaks |
| Two equal buttons | Every visitor has to choose before understanding what Gazetta is |
| Stage 1 gated on CI alone | Misses steps that pass but confuse people |

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
| 0 | **Door for coding agents** | `llms.txt`, a Markdown copy of every page, a link to AGENTS.md | Fleet | — |
| 0 | **up-for-grabs.net** | A PR adding a YAML entry pointing at the label | Fleet | ✓ |
| 0 | goodfirstissue.dev | Listing requirements | Fleet checks first | ✗ |
| 0 | **PR limits, ready but off** | GitHub's open-PR cap with a bypass list; on only if PRs outpace the fleet | You decide when | ✓ |
| 1 | **npm** | A release from `main`; README built from the same source as the site; version and "preview" in the install line | Fleet; you approve the release | ✓ (npm updates the README only on publish) |
| 1 | **Site: Use it** | Becomes the main button; a tutorial ending in a publish and an undo, run in CI | Fleet | — |
| 1 | **Docs by version** | Default docs from the release tag; `main`'s docs at a separate "unreleased" address | Fleet | — |
| 1 | **Demo video** | Recorded by Playwright at each release | Fleet; you approve the script once | ✓ |
| 1 | **Release notes page** | Drafted from merged PRs | Fleet; you edit | — |
| 1 | **Honest comparison** | 2–3 named alternatives, facts re-checked monthly by a bot | Fleet; you approve the wording | ✓ |
| 1 | **Codespaces / StackBlitz button** | StackBlitz only if a one-hour test passes (`sharp`, Node 22) | Fleet | Partly |
| 1 | **Console.dev** | Submit; requires "beta" or "preview" visible on the site | You submit | ✓ |
| 1 | Lists: awesome-lists, the jamstack.org CMS list, Hono and Cloudflare community lists | Inclusion rules | Fleet checks, then opens PRs | ✗ |
| 2 | **Show HN** | Link the repo; in the maintainer's own words | **You** | ✓ |
| 2 | **Launch essay** | "Why a CMS should store nothing", posted separately | **You** | ✓ |
| 2 | **"How Gazetta is built"** | Page plus the essay on one maintainer and a bot fleet | You write, fleet builds the page | — |
| 2 | Newsletters: JavaScript Weekly, Node Weekly, Bytes | How to submit | Fleet checks | ✗ |
| 2 | Reddit (r/webdev, r/javascript, r/selfhosted, r/CloudFlare) | Self-promotion rules per subreddit | You check by hand | ✗ |
| 2 | Lobsters | Accounts are invite-only | Only if invited | ✓ |
| 2 | dev.to / Hashnode | Copy of the essay pointing back to the original on gazetta.studio | Fleet | — |
| 2 | The maintainer's own social accounts | The maintainer's voice | You | — |
| when #49 ships | **Official MCP Registry** | Publish the MCP server | Fleet | ✓ |
| 3 | Showcase | A list others add to by PR | Fleet | — |
| 3 | GitHub Sponsors | A link once there's an audience | You | — |
| 3 | Hacktoberfest (October) | Current rules; only if the fleet can take the volume | Fleet checks | ✗ |
| 3 | Cloudflare and Hono ecosystem | Templates and showcases, guest posts, talks, podcasts | You choose | ✗ |
| 3 | Monthly devlog | Only if the maintainer enjoys writing | You | — |
| 4 | Docs per major version, stability policy, migration guides | — | Fleet | ✓ |
| never | Waitlist, mass comparison pages, benchmark claims, paid ads | — | — | — |

Decided: maintainer, 2026-10-24 (#PR)

### How it runs

- **One rule for every channel:** a check keeps it true (it fails when the channel drifts from the code or the release), or the maintainer writes it. Doors that need users wait until there are users.
- **At each gate the maintainer decides to open the next stage** and closes any channel that brought nothing: one decision per stage, not one per channel.
- **What tells a stage is working:** Stage 0, outside PRs merged and contributors coming back; Stage 1, strangers finishing the tutorial and issues from strangers; Stage 2, other people's sites and returning users. Stars and npm downloads aren't measures: both are easy to inflate.
- **The maintainer's own words are needed only for** the Show HN post, the essays, the comparison wording, release approvals and social posts. Everything else is fleet work.

Decided: maintainer, 2026-10-24 (#PR)

| Rejected | Why |
|---|---|
| Write everything by hand, as competitors did before AI | The fleet makes producing and checking cheap; the maintainer's decisions are what's scarce |
| Let AI write anything, including the Show HN post and essays | HN: "Don't post generated text or AI-edited text." |
| Many AI-written comparison pages for search | Google's spam policy on scaled content abuse |
| Stars or npm downloads as targets | Both are inflated by bots and fake stars; they follow use, they don't measure it |

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

### Docs and release sync

- Build the default docs from the latest release tag and put `main`'s docs at an "unreleased" address, as Vite does (`main.vite.dev`).
- Put the version in the install line, as Bun ("Install Bun v1.4.4") and Deno ("Install Deno 2.9.8") do, so drift shows at once.
- Don't version docs before 1.0: "If your documentation rarely changes, don't add versioning" ([Docusaurus](https://docusaurus.io/docs/versioning)).
- Static search without a service: Pagefind ([repo](https://github.com/CloudCannon/pagefind), MIT). Algolia DocSearch "usually turn[s] down applications when they are not production ready" ([eligibility](https://docsearch.algolia.com/docs/who-can-apply/)).

## Open items

- **How the October contributors found Gazetta, and whether any of them uses it for a site.** Ask them; the pinned Discussion is the Stage 0 way to ask everyone.
- **Channel rules not yet checked:** goodfirstissue.dev, the newsletters, Reddit (blocks automated reading), awesome-lists, the jamstack.org CMS list, Hacktoberfest 2026. Each is checked before its channel opens.
- **The StackBlitz test** (Node version, `sharp`, `gazetta dev` on port 3000).

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
| "Agents welcome" as a difference; no study of contributors becoming users | Inference; searched, nothing found |
| Time costs | Estimates; no source gives hours |

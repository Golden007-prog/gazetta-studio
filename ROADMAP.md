# Roadmap

Forward-looking priorities for Gazetta. What's committed, what's planned, what's parked, what's not happening.

**Updated**: 2026-10-24

## How to read this

- **Now** — committed; in flight or starting in the next 4-8 weeks
- **Next** — planned for the quarter after Now
- **Later** — sequenced behind Now / Next; dependency-ordered
- **Deferred** — real gaps, no current trigger to start
- **Non-goals** — explicit strategic non-fits (see [`docs/non-goals.md`](docs/non-goals.md))

**Capacity assumption**: estimates assume single-maintainer evenings + weekends. "Demand-driven" items have no estimate — the trigger is the estimate.

Priorities derive from [`docs/audits/cms-feature-audit.md`](docs/audits/cms-feature-audit.md). When the audit changes, this roadmap re-derives. Every open issue is bucketed below per the "Issue-classification discipline" in [`feature-design-process.md`](.claude/rules/feature-design-process.md). Shipped status is in the appendix at the bottom; this is a forward-looking document.

## Now (committed, 4-8 weeks)

The publishing-safety designs and the review workflow's cuts ship one cut at a time through feature-bot's nightly run (`night-shift.yml`), so 4–8 weeks covers their first cuts, not their completion. Target removal's first cut waits for its planner issue (see its row).

### Publishing safety

October's designs fix wrong results on live sites: deleted pages stay live, undo doesn't change what visitors see, and a target's private files can be public. Where a design has a planner issue, its cuts reach feature-bot one at a time through it.

| Design | Tracking |
|---|---|
| Live check ([`design-live-check.md`](.claude/rules/design-live-check.md)) | planner [#1081](https://github.com/gazetta-studio/gazetta-studio/issues/1081) |
| Public storage ([`design-public-storage.md`](.claude/rules/design-public-storage.md)) | planner [#1085](https://github.com/gazetta-studio/gazetta-studio/issues/1085) |
| Publish undo ([`design-publish-undo.md`](.claude/rules/design-publish-undo.md)) | planner [#1092](https://github.com/gazetta-studio/gazetta-studio/issues/1092); one snapshot per publish ([#1527](https://github.com/gazetta-studio/gazetta-studio/issues/1527)) is its cut 7 |
| Target indices ([`sidecars.md`](.claude/rules/sidecars.md)) | planner [#1093](https://github.com/gazetta-studio/gazetta-studio/issues/1093) |
| Target removal ([`design-target-removal.md`](.claude/rules/design-target-removal.md)) | [#1094](https://github.com/gazetta-studio/gazetta-studio/issues/1094); its planner issue opens after publish undo cut 2, target indices cut 2 and review workflow cuts 12–13 |
| Archived pages on plain-static hosts ([`design-soft-delete.md`](.claude/rules/design-soft-delete.md) Q10) | [#1152](https://github.com/gazetta-studio/gazetta-studio/issues/1152); cut 1 shipped; cut 2 waits for target removal cut 1 |

### Review workflow — finish

The back end's first cuts, the UI primitives, the story runner and screenshots in bot PRs shipped (see the appendix). Queued for feature-bot: [#521](https://github.com/gazetta-studio/gazetta-studio/issues/521) (API routes), then [#525](https://github.com/gazetta-studio/gazetta-studio/issues/525) (review banner and dialog) and [#531](https://github.com/gazetta-studio/gazetta-studio/issues/531) (pending-review queue). [#526](https://github.com/gazetta-studio/gazetta-studio/issues/526) and [#527](https://github.com/gazetta-studio/gazetta-studio/issues/527) (publish requests) wait for publish undo cut 1 (`design-review-workflow.md`, lock 1), and [#528](https://github.com/gazetta-studio/gazetta-studio/issues/528)–[#530](https://github.com/gazetta-studio/gazetta-studio/issues/530) and [#532](https://github.com/gazetta-studio/gazetta-studio/issues/532) wait for them. [#533](https://github.com/gazetta-studio/gazetta-studio/issues/533) (docs) is labelled `ready-for-human`. Design: [`design-review-workflow.md`](.claude/rules/design-review-workflow.md); request [#199](https://github.com/gazetta-studio/gazetta-studio/issues/199), tracking issue [#514](https://github.com/gazetta-studio/gazetta-studio/issues/514).

### MCP server design pass

[#49](https://github.com/gazetta-studio/gazetta-studio/issues/49): design now, build in Next. The design starts from one decision: agents save through the same path as the admin, as their own principal with their own capabilities, and the audit log records them. By default they can't publish, so a person decides what reaches visitors, and undo covers mistakes. Bulk edits ([#1170](https://github.com/gazetta-studio/gazetta-studio/issues/1170)) are one of its use cases. Still to design: how an agent authenticates (scripts and CI share the single `GAZETTA_TOKEN` today), how agents appear in the audit log, and how an agent's run is undone without undoing other people's saves (undo and rollback restore whole revisions).

### Creation UX design pass

[#103](https://github.com/gazetta-studio/gazetta-studio/issues/103) page/fragment/component creation UX — needs Discovery + UX-grilling pass per [`feature-design-process.md`](.claude/rules/feature-design-process.md). Labeled `ready-for-human`; design before implementation.

### Website and channels

The plan in [`docs/audits/website-and-channels.md`](docs/audits/website-and-channels.md): every channel (the site, the repo, npm, communities, newsletters) opens at one of five stages, and a stage opens only when its gate is met. Each channel is kept true by a check, or the maintainer writes it. Stage 0 starts now, with Contribute as the home page's main button and a small "Try it" beside it. Stage 1 makes "Use it" the main button; its gate is the Onboarding sprint's release that matches the docs ([#1178](https://github.com/gazetta-studio/gazetta-studio/issues/1178)) and a first publish that reaches a second target ([#1177](https://github.com/gazetta-studio/gazetta-studio/issues/1177)), checked by a tutorial in CI and by 3–5 people completing it without help. The tutorial and its CI check are designed in [`design-tutorial.md`](.claude/rules/design-tutorial.md) (#1338); planner [#1497](https://github.com/gazetta-studio/gazetta-studio/issues/1497). The tutorial rewrite ([#1543](https://github.com/gazetta-studio/gazetta-studio/issues/1543)) waits for the scaffold's hero image field ([#1545](https://github.com/gazetta-studio/gazetta-studio/issues/1545)).

Stage 0:

- GitHub README's first screen: one sentence, a status line, Contribute and Try it ([#1189](https://github.com/gazetta-studio/gazetta-studio/issues/1189))
- gazetta.studio home page: a status line, "Built and published with Gazetta", the blog link removed ([#1269](https://github.com/gazetta-studio/gazetta-studio/issues/1269))
- A Contribute page: agents welcome, what `ready-for-agent` means, which paths the maintainer reviews personally, PR response time, the good first issues, design docs, credits; Contribute becomes the home page's main button ([#1270](https://github.com/gazetta-studio/gazetta-studio/issues/1270))
- Docs on the site generated from the repo's `docs/` as committed pages, kept true by a check ([#1272](https://github.com/gazetta-studio/gazetta-studio/issues/1272))
- The admin refuses saves to the generated docs pages ([#1289](https://github.com/gazetta-studio/gazetta-studio/issues/1289))
- Removed or renamed docs become archived pages that redirect or answer 410 ([#1290](https://github.com/gazetta-studio/gazetta-studio/issues/1290))
- An experiment on gazetta.studio only: its docs pages in Markdown when an agent asks for Markdown, an `llms.txt`, links to both, and a link to AGENTS.md, with requests to them logged by user agent ([#1273](https://github.com/gazetta-studio/gazetta-studio/issues/1273)). Gazetta doing this for every site stays Deferred
- A listing on up-for-grabs.net; goodfirstissue.dev once its rules are checked ([#1275](https://github.com/gazetta-studio/gazetta-studio/issues/1275))
- GitHub's open-PR cap ready but off, switched on only if outside PRs outpace the fleet ([#1276](https://github.com/gazetta-studio/gazetta-studio/issues/1276))

Decided: maintainer, 2026-10-24 (#1266)

### Media works end to end

The asset library is broken at several layers: published images return 404 on deployed servers ([#1330](https://github.com/gazetta-studio/gazetta-studio/issues/1330); static `gazetta serve` corrupts them, [#1249](https://github.com/gazetta-studio/gazetta-studio/issues/1249)), the asset picker never renders ([#1345](https://github.com/gazetta-studio/gazetta-studio/issues/1345)), a target's `transforms` setting is never read ([#1332](https://github.com/gazetta-studio/gazetta-studio/issues/1332)), asset edits and locale images never reach targets ([#1334](https://github.com/gazetta-studio/gazetta-studio/issues/1334), [#1350](https://github.com/gazetta-studio/gazetta-studio/issues/1350)), and the resolver drops an asset's own focal point ([#1346](https://github.com/gazetta-studio/gazetta-studio/issues/1346)). These are fix-bot one-shots. The rest of the editor flow (per-reference overrides, same-name uploads, per-locale alt, documents and fonts) waits on a UX design round ([#1357](https://github.com/gazetta-studio/gazetta-studio/issues/1357)). The Stage 1 tutorial adds an image, so #1330, #1249 and #1345 are Stage 1 gate items (`design-tutorial.md` Q14).

Decided: maintainer, 2026-10-24 (#1358)

### Bug backlog

User-visible bugs, with fix-bot or outside contributors ([#1162](https://github.com/gazetta-studio/gazetta-studio/issues/1162) waits for its contributor):

- [#1068](https://github.com/gazetta-studio/gazetta-studio/issues/1068) closing the tab during a publish stops it
- [#1146](https://github.com/gazetta-studio/gazetta-studio/issues/1146) publish and serving ignore a target's language settings
- [#1149](https://github.com/gazetta-studio/gazetta-studio/issues/1149) `_redirects`: 410 rows hosts don't support, and no warning past 2,000 rows
- [#1159](https://github.com/gazetta-studio/gazetta-studio/issues/1159) the publish panel sends target-only rows
- [#1162](https://github.com/gazetta-studio/gazetta-studio/issues/1162) component tree: a fast second keyboard move acts on the old order
- [#1165](https://github.com/gazetta-studio/gazetta-studio/issues/1165) capability checks don't know `gazetta serve` serves a static target
- [#1180](https://github.com/gazetta-studio/gazetta-studio/issues/1180) `gazetta publish` and `gazetta history` wait 10 seconds after they finish
- [#1181](https://github.com/gazetta-studio/gazetta-studio/issues/1181) the `.gitignore` from `gazetta init` doesn't cover what publish writes
- [#1182](https://github.com/gazetta-studio/gazetta-studio/issues/1182) the capability-gap warning on a new site links to a page that answers 404
- [#1183](https://github.com/gazetta-studio/gazetta-studio/issues/1183) a new site fails its own broken-links check
- [#1184](https://github.com/gazetta-studio/gazetta-studio/issues/1184) `gazetta dev` on a busy port prints a Node stack trace
- [#1193](https://github.com/gazetta-studio/gazetta-studio/issues/1193) the offline docs say offline saves are sent later, and "Send now" only checks the connection
- [#1465](https://github.com/gazetta-studio/gazetta-studio/issues/1465) pages and fragments with a dot in the name can be created but not saved
- [#1471](https://github.com/gazetta-studio/gazetta-studio/issues/1471) History treats a stray file in `revisions/` as the newest revision
- [#1499](https://github.com/gazetta-studio/gazetta-studio/issues/1499) `gazetta dev` logs `.json` changes outside the content root
- [#1538](https://github.com/gazetta-studio/gazetta-studio/issues/1538) publishing a page also copies its nested pages' manifests
- [#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262) requests refused before a route is matched (401) aren't recorded in the audit log. Decided: maintainer, 2026-10-24 (#1259).

Decided: maintainer, 2026-10-23 (#1179)

### Discovery in progress

Research by discovery-prep-bot, then a design round with the maintainer where one is needed:

- [#1483](https://github.com/gazetta-studio/gazetta-studio/issues/1483) Markdown in the admin: which Markdown support authors and template developers need
- [#1484](https://github.com/gazetta-studio/gazetta-studio/issues/1484) content trust: whether editors can put markup or script on published pages
- [#1485](https://github.com/gazetta-studio/gazetta-studio/issues/1485) AI direction: forms, AI helpers in forms, or agents operating the CMS; its answer feeds the MCP design pass ([#49](https://github.com/gazetta-studio/gazetta-studio/issues/49))
- [#1540](https://github.com/gazetta-studio/gazetta-studio/issues/1540) executable specifications for AI-written code (Dave Farley's four layers)
- [#1542](https://github.com/gazetta-studio/gazetta-studio/issues/1542) PrimeVue 5 and `@primeuix/themes` 3 are no longer MIT; the admin stays on the MIT 4.x line until a choice is made

## Next (planned, the quarter after Now)

### Onboarding sprint

Reduce time-to-first-deploy for new operators. Moved from Now on 2026-10-23.

- [#214](https://github.com/gazetta-studio/gazetta-studio/issues/214) first-run Cloudflare setup
- [#213](https://github.com/gazetta-studio/gazetta-studio/issues/213) container deployment guide
- [#79](https://github.com/gazetta-studio/gazetta-studio/issues/79) Docker example for `gazetta serve`
- Function-based adapters on the v1 contract: [#204](https://github.com/gazetta-studio/gazetta-studio/issues/204) Cloudflare Pages + Functions, [#206](https://github.com/gazetta-studio/gazetta-studio/issues/206) Vercel Edge
- [#1177](https://github.com/gazetta-studio/gazetta-studio/issues/1177) a new site's first publish: decided 2026-10-24 on the issue
- [#1284](https://github.com/gazetta-studio/gazetta-studio/issues/1284) `gazetta init` adds a `staging` target, and getting-started publishes to it
- [#1285](https://github.com/gazetta-studio/gazetta-studio/issues/1285) the admin shows no Publish button on a site with one target
- [#1286](https://github.com/gazetta-studio/gazetta-studio/issues/1286) `gazetta publish` on a one-target site stops with a message
- [#1178](https://github.com/gazetta-studio/gazetta-studio/issues/1178) docs, npm and gazetta.studio describe different versions: decided 2026-10-24 on the issue; the next release follows the website plan's Stage 1 gate
- [#1280](https://github.com/gazetta-studio/gazetta-studio/issues/1280) the npm package shows the repo's README.md, copied in at publish
- [#1281](https://github.com/gazetta-studio/gazetta-studio/issues/1281) `gazetta init` depends on `^` its own version instead of `*`
- Found on the 2026-10-23 onboarding walk, each waiting for a decision or a test on a real host:
  - [#1185](https://github.com/gazetta-studio/gazetta-studio/issues/1185) a site with an R2 target can't run `gazetta dev` without the R2 keys
  - [#1186](https://github.com/gazetta-studio/gazetta-studio/issues/1186) docs and code disagree on a cloud target's default environment
  - [#1187](https://github.com/gazetta-studio/gazetta-studio/issues/1187) the generated `wrangler.toml` uses a subdomain as `zone_name` (needs a test on a real account)
  - [#1188](https://github.com/gazetta-studio/gazetta-studio/issues/1188) docs and `init` put pages in different folders, and new pages need a `gazetta dev` restart
- [#1171](https://github.com/gazetta-studio/gazetta-studio/issues/1171) starter themes
- [#209](https://github.com/gazetta-studio/gazetta-studio/issues/209) Netlify static, after [#1152](https://github.com/gazetta-studio/gazetta-studio/issues/1152)'s cuts 1–2 and [#1149](https://github.com/gazetta-studio/gazetta-studio/issues/1149). #1152's cut 2 waits for target removal cut 1, whose planner issue opens after publish undo cut 2, target indices cut 2 and review workflow cuts 12–13

### Phase 1 — Remaining foundations

| Foundation | Estimate | Status |
|---|---|---|
| `NotificationProvider` (in-admin only) | 1w | ☐ pending |

Other foundations (TS config / AuthIdentity / Component IDs / AdminCache / Audit / Hooks) all ✓ shipped — see appendix.

### Phase 2 — Features composing against foundations

| Feature | Depends on | Estimate |
|---|---|---|
| Per-field translation ([#192](https://github.com/gazetta-studio/gazetta-studio/issues/192)) and AI translation ([#1167](https://github.com/gazetta-studio/gazetta-studio/issues/1167)): one discovery and design pass, since both have to settle which fields get translated and how a translation is reviewed and marked | i18n design + Component IDs (both shipped) | — |
| Comments-first collaboration v1 | AuthIdentity + Audit + Component IDs (shipped) + NotificationProvider (pending) | 3w |

### Static targets

What remains wrong or undecided on static targets:

- [#202](https://github.com/gazetta-studio/gazetta-studio/issues/202) an admin publish of a fragment misses nested pages that use it
- [#1175](https://github.com/gazetta-studio/gazetta-studio/issues/1175) save doesn't render on editable static targets, though the design says it should (in discovery)
- [#1176](https://github.com/gazetta-studio/gazetta-studio/issues/1176) pages with a dynamic route (`[param]`) answer 404 (in discovery)

### Page listings for templates

[#1168](https://github.com/gazetta-studio/gazetta-studio/issues/1168): a discovery and design pass. Templates can't list pages yet (`PageQuery` in [`design-rendering.md`](.claude/rules/design-rendering.md) Q4 isn't built), and RSS ([#58](https://github.com/gazetta-studio/gazetta-studio/issues/58)) and pagination ([#57](https://github.com/gazetta-studio/gazetta-studio/issues/57)) both need it, so they follow it.

### `gazetta validate` checks target connectivity

[#91](https://github.com/gazetta-studio/gazetta-studio/issues/91).

### Offline: save queue, editor offline and e2e tests

Three pieces of offline mode that aren't built or tested yet, planned together:

- The save queue (`design-offline-implementation.md`, "Cut 9c: Save queue"): a save made offline goes out by itself once the connection returns. Its audit events carry replay metadata (Cut 15).
- Opening a page in the editor on an offline cold load ([#969](https://github.com/gazetta-studio/gazetta-studio/issues/969)), which #253's reload step needs. It needs a decision first: how custom editor and field modules are cached offline.
- The e2e tests in [#253](https://github.com/gazetta-studio/gazetta-studio/issues/253) for the two scenarios no test covers yet: editing offline, reloading, then reconnecting and saving; and the offline save conflict. Cold load offline (`tests/e2e/production-offline.test.ts`) and drafts surviving an online reload are covered.

### MCP server build

[#49](https://github.com/gazetta-studio/gazetta-studio/issues/49), after its design pass in Now.

### CSP design passes

Two research+design issues filed 2026-05-13. Tier 3 implementation; the design work is in Next.

- [#361](https://github.com/gazetta-studio/gazetta-studio/issues/361) Content Security Policy: admin surface
- [#362](https://github.com/gazetta-studio/gazetta-studio/issues/362) Content Security Policy: target / published-site surface

Decided: maintainer, 2026-10-23 (#1179)

## Later (sequenced behind Now / Next)

### Additional deploy adapters (demand-driven)

Post-contract additions to the onboarding sprint:

- [#205](https://github.com/gazetta-studio/gazetta-studio/issues/205) Deno Deploy
- [#207](https://github.com/gazetta-studio/gazetta-studio/issues/207) Netlify Edge Functions
- Static hosts:
  - [#208](https://github.com/gazetta-studio/gazetta-studio/issues/208) GitHub Pages (static-only)
  - [#210](https://github.com/gazetta-studio/gazetta-studio/issues/210) Cloudflare Pages (static-only, no Functions)
  - [#211](https://github.com/gazetta-studio/gazetta-studio/issues/211) S3 static website
  - [#212](https://github.com/gazetta-studio/gazetta-studio/issues/212) Azure Blob static website

### Operability cluster (demand-driven)

Operator-facing features for mature production deployments:

- [#19](https://github.com/gazetta-studio/gazetta-studio/issues/19) configure cache from CMS admin UI
- [#38](https://github.com/gazetta-studio/gazetta-studio/issues/38) cache dynamic route lookups in worker
- [#39](https://github.com/gazetta-studio/gazetta-studio/issues/39) minimal observability for Cloudflare worker
- [#75](https://github.com/gazetta-studio/gazetta-studio/issues/75) publish uploads rendered pages and history one file at a time; dependency-index writes have no limit
- [#76](https://github.com/gazetta-studio/gazetta-studio/issues/76) in-memory cache for `gazetta serve`
- [#195](https://github.com/gazetta-studio/gazetta-studio/issues/195) webhooks: a first-party webhook hook factory (an npm contribution, [ADR-0009](docs/adr/0009-no-plugin-runtime-factory-contributions.md)), after live-check cut 7a makes CLI publishes run hooks. Admin publishes already run `afterPublish` hooks; CLI publishes run none.
- [#198](https://github.com/gazetta-studio/gazetta-studio/issues/198) scheduled publishing — composes with scheduling primitive when shipped

### Compare polish (~1 week)

- [#109](https://github.com/gazetta-studio/gazetta-studio/issues/109) compare targets — polish and edge cases
- [#111](https://github.com/gazetta-studio/gazetta-studio/issues/111) standalone compare view

### Content features

- [#1170](https://github.com/gazetta-studio/gazetta-studio/issues/1170) bulk edits; also a use case in the MCP design pass
- [#1169](https://github.com/gazetta-studio/gazetta-studio/issues/1169) template schema changes: starts when publish undo refuses content on a real site, or a template developer reports the problem (scenario TD3 in [`docs/actor-scenarios.md`](docs/actor-scenarios.md)). Until then undo stays correct by refusing.

### Tier 3 strategic bets (parallel tracks)

These can run alongside Phase 2 since they don't block foundations:

- SEO metadata editor ([#193](https://github.com/gazetta-studio/gazetta-studio/issues/193)): what's left is the OG preview and JSON-LD helpers; the SERP preview and reload-safe metadata edits shipped
- Large-site editor UX ([#196](https://github.com/gazetta-studio/gazetta-studio/issues/196)) — `design-scale.md` shipped; implementation pending
- Environment-specific content ([#62](https://github.com/gazetta-studio/gazetta-studio/issues/62)) — design pass needed first

Decided: maintainer, 2026-10-23 (#1179)

### Docs

- [#1205](https://github.com/gazetta-studio/gazetta-studio/issues/1205) self-hosting an ESI target (`type: 'dynamic'`) behind a CDN: after a publish the CDN serves the previous page for up to `cache.edge` unless it's purged

Decided: maintainer, 2026-10-24 (#1243)

## Deferred — real gaps, no current trigger

| Item | Trigger to revisit |
|---|---|
| Real-time presence MVP | Operator demand for live collaboration awareness |
| Concurrent editing with OT/CRDT (3-6 months investment) | Presence ships first + product positioning clear |
| AI tag suggestion task | After translation ships |
| AI image generation | Concrete operator request |
| Per-locale comments | Concrete demand |
| Approval-blocking comments | Compliance archetype demand |
| File attachments on comments | Operator asks |
| Markdown formatting in comments | Operator asks |
| Activity feed | Operator asks |
| Reactions on comments | Operator asks |
| Email/Slack/Teams/Discord NotificationProviders | Operator demand (expected order locked in `design-collaboration.md` Q3) |
| Edge SSR for `dynamic` Targets (WinterTC origin) | WASM-compiled templates or framework support catches up |
| Soft-delete extension to assets | Concrete demand for "rename asset without manual ref cleanup" |
| Per-locale archive (archive only French variant of a page) | Concrete demand for "archive only one locale; default + others stay live" |
| Bulk archive UI in admin | CLI works today (`gazetta archive purge --filter=...`); UI lands when authors ask |
| Page move (parent route reparenting) as distinct concept | Today's rename + alias works through filesystem reparenting; needs design pass |
| Page duplicate / copy as standalone feature | Authors can copy directories today; UI affordance when concrete demand surfaces |
| Find-and-replace across content (string match) | Operator asks; orthogonal to existing dependents-walking |
| Versioned aliases (`@header-v1` + `@header-v2` simultaneously) | Strategic-bet level; would require revising `design-soft-delete.md` Q3 — needs its own design pass |
| Branch / PR-style workflows | Strategic bet; depends on concurrent-editing positioning |
| Snapshot-named revisions ("v1.5 release snapshot") | Concrete demand from operators wanting recoverable named checkpoints |
| Bulk import from other CMSes (Notion, WordPress, Sanity) | Concrete operator request; manifest format is import-friendly |
| Hidden but live (visible at URL, not in nav/sitemap) | Concrete demand; composes with publish flow + sitemap generation |
| Time-windowed visibility (live between dates) | Composes with scheduling primitive when shipped |
| Lock / immutability (lock published version) | Compliance archetype; archive transitions imply this — explicit lock when distinct intent surfaces |
| Editorial calendar / planning view | Operator asks |
| Search index CLI | Operator asks; integrate Algolia/Meilisearch |
| Synced blocks (inline content reuse) | Inline-reuse demand materializes; Fragments cover ~80% today |
| Visual editing mode (parallel to form-driven) | Marketing-team operator asks specifically |
| Bidirectional relations beyond Usages | Wiki-style use case surfaces |
| Admin `theme.ts` JS preset bridge ([#135](https://github.com/gazetta-studio/gazetta-studio/issues/135)) | Per `css-theming.md`: product matures past prototype phase |
| Google Cloud Storage provider ([#8](https://github.com/gazetta-studio/gazetta-studio/issues/8)) | Operator asks |
| Pass dynamic route params at request time ([#80](https://github.com/gazetta-studio/gazetta-studio/issues/80)) | Composes with `design-rendering.md` request-SSR work when shipped |
| Publish from static target ([#92](https://github.com/gazetta-studio/gazetta-studio/issues/92)): CLI publishes to a static target copy no fragment manifests, so it can't be a publish source | A real "publish from a static target" workflow surfaces |
| `llms.txt` for every site Gazetta publishes | Evidence that AI platforms read other sites' `llms.txt` (none found on 2026-10-24: Google says Search ignores it), or an operator asks |
| Markdown versions of every site's pages, served when an agent asks for Markdown | gazetta.studio's own logs show agents fetching its Markdown docs (Stage 0 experiment); coding agents already ask for Markdown |
| Agent instructions (skills) for template developers | The MCP server ships |
| Asset folders and a crop rectangle | Operators ask |
| Per-target publish lock: one write to a target at a time ([#1537](https://github.com/gazetta-studio/gazetta-studio/issues/1537)) | Concurrent publishes to one target become common, or two writes to a target overwrite each other |

Decided: maintainer, 2026-10-23 (#1179)

The two rows for agent files were one row until 2026-10-24, when the evidence split them: no AI platform says it reads other sites' `llms.txt`, while Claude Code, VS Code Copilot and OpenCode ask for Markdown ([`docs/audits/website-and-channels.md`](docs/audits/website-and-channels.md), "Agent files").

Decided: maintainer, 2026-10-24 (#1268)

## Non-goals

See [`docs/non-goals.md`](docs/non-goals.md) for full rationale. Summary:

- Memberships / subscriptions / paywalls / native newsletters → Ghost territory
- Content branching (git-like content branches) → multi-Target covers it
- Content federation at CMS level → templates handle external data
- Built-in full-text site-wide search → delegate to Algolia / Meilisearch
- Visual editing as primary editor paradigm → form-first by design
- Database integration → stateless CMS is a defining property
- E-commerce primitives → out of scope
- Solid.js / Svelte template support — niche; existing template contract already supports any framework
- Broad plugin system beyond documented extension surfaces — see [ADR-0009](docs/adr/0009-no-plugin-runtime-factory-contributions.md)

## Process

When a Now item ships, the next item from Next promotes (or is deliberately re-prioritized). When a design pass completes, the corresponding implementation moves from Later to Next.

Every issue is classified into a bucket above at file time per [`feature-design-process.md`](.claude/rules/feature-design-process.md) "Issue-classification discipline." Unclassified issues are a process bug.

Tier transitions are tracked here. Ship-status of individual cuts lives in each feature's planner or tracking issue ([ADR-0015](docs/adr/0015-impl-doc-artifact-retires.md)).

---

# Appendix: Shipped status

Historical record. Forward planning is above this line.

## Foundational design passes — all complete 2026-05

Cross-cutting dimensions every feature design must respect (see [`feature-design-process.md`](.claude/rules/feature-design-process.md) "Foundational dimensions"). Each landed a `design-{name}.md` and adds a check to every new feature design.

1. **[`design-scale.md`](.claude/rules/design-scale.md)** — operating envelope (5K pages / 20K assets / 50 components-per-page); tree virtualization; paginated `/api/pages`; search-driven navigation; lazy-load asset library. Implementation pending: [#88](https://github.com/gazetta-studio/gazetta-studio/issues/88) (nested route tree + search), [#196](https://github.com/gazetta-studio/gazetta-studio/issues/196).
2. **[`design-i18n.md`](.claude/rules/design-i18n.md)** — migrated from `i18n-plan.md`. Locale as closed dimension peer to theme; locale-priority cross-dimension fallback; whole-file overlay model; subpath / per-domain / hybrid routing strategies; hreflang via HTML or sitemap. 13 of 15 implementation steps shipped; per-field translation tracked in [#192](https://github.com/gazetta-studio/gazetta-studio/issues/192).
3. **[`design-themes.md`](.claude/rules/design-themes.md)** — presentation theming (light/dark, color schemes, accessibility variants) as a render-context dimension. Pages/fragments stay theme-agnostic at the data layer; theme reaches templates via `params.theme` peer to `params.locale`.
4. **[`design-auth-rbac.md`](.claude/rules/design-auth-rbac.md)** — covers [#194](https://github.com/gazetta-studio/gazetta-studio/issues/194). Trust modes (configurable v1, plugin reserved); hybrid built-in + custom roles; capability-based authorization gates.
5. **[`design-audit.md`](.claude/rules/design-audit.md)** — covers [#200](https://github.com/gazetta-studio/gazetta-studio/issues/200). `AuditProvider` extension surface #11; v1 ships `HistoryAuditProvider`; v2 external sinks expected order: HTTP webhook → file → OTel → CloudWatch → Azure Monitor → syslog.
6. **[`design-review-workflow.md`](.claude/rules/design-review-workflow.md)** — covers [#199](https://github.com/gazetta-studio/gazetta-studio/issues/199). Per-content review state machine + per-target publish approval; 5 archetype recipes; capability extensions; single reject with mandatory comment.
7. **[`design-rendering.md`](.claude/rules/design-rendering.md)** — three target types (`static` / `esi` / `dynamic`); three fragment rendering types; worker boundary discipline; content-addressed worker cache.
8. **[`design-hooks.md`](.claude/rules/design-hooks.md)** — save / publish / load / upload / review lifecycle phases; return-new-payload contract; priority-based composition.
9. **[`design-config.md`](.claude/rules/design-config.md)** — TS config replaces YAML; `defineGazetta` / `defineSite` identity functions; `process.env.X` for secrets; per [ADR-0005](docs/adr/0005-typescript-config-format.md).
10. **[`design-plugins.md`](.claude/rules/design-plugins.md)** — TS-import discovery; factory exports returning contributions; per [ADR-0009](docs/adr/0009-no-plugin-runtime-factory-contributions.md) there is no `Plugin` runtime contract.
11. **[`design-cache.md`](.claude/rules/design-cache.md)** — L4 cache; ships `MemoryCache` (per-instance v1; 10K entries / 50MB LRU); deterministic-derived principle; SSE broadcast for cross-instance coordination.
12. **[`design-offline.md`](.claude/rules/design-offline.md)** — always-on UX; pending edits vs save queue distinction; IndexedDB primary + MemoryCache fallback; service worker for app-shell; conflict surfaces diff with no force-overwrite.
13. **[`design-collaboration.md`](.claude/rules/design-collaboration.md)** — comments-first v1; mentions; in-admin notifications via `NotificationProvider` Extension Surface #12.
14. **[`design-soft-delete.md`](.claude/rules/design-soft-delete.md)** — **implementation also shipped 2026-05** — all 15 cuts merged on `soft-delete-v1`. Archive + alias + rename + restore + purge for pages/fragments. HTML comment marker as the universal mechanism; capability-gap UX surfaced at four points.
15. **[`design-scheduling.md`](.claude/rules/design-scheduling.md)** — single-shot actions + time-windowed visibility. Background scheduler with lock-with-TTL multi-instance coordination; lazy visibility evaluation at render time. Implementation pending in [#198](https://github.com/gazetta-studio/gazetta-studio/issues/198) (12 cuts + UX research pass, ~22 days).

## Publishing-safety design passes — complete 2026-10

Implementation is in Now (see "Publishing safety").

1. **[`design-live-check.md`](.claude/rules/design-live-check.md)** — after each publish or deploy, check that the live site serves what was published; published-version marker, route planner, reports on the target.
2. **[`design-public-storage.md`](.claude/rules/design-public-storage.md)** — a target whose storage visitors can reach keeps no history, audit or review state; `isPublicSitePath`; a probe that locks publishing on a leak.
3. **[`design-publish-undo.md`](.claude/rules/design-publish-undo.md)** — undo and rollback on a publish destination restore the previous content and re-render it through one shared target-publish function.
4. **Target indices that describe the target** ([`sidecars.md`](.claude/rules/sidecars.md), [#1077](https://github.com/gazetta-studio/gazetta-studio/issues/1077)) — each published item's edges replaced from its own forward record.
5. **[`design-target-removal.md`](.claude/rules/design-target-removal.md)** — items deleted on the source are removed from a target only when the author chooses, after a check that nothing staying there uses them.
6. **Archived pages on plain-static hosts** ([`design-soft-delete.md`](.claude/rules/design-soft-delete.md) Q10, [#1152](https://github.com/gazetta-studio/gazetta-studio/issues/1152), decided in [#1163](https://github.com/gazetta-studio/gazetta-studio/pull/1163)) — static publish leaves no marker file at an archived route; plain hosts apply their `_redirects` rows, serve a redirect page at an alias's old route, or answer 404 with the target's `404.html`.

## Phase 0 — Implementation planning artifacts (complete 2026-05)

All 19 `design-{feature}-implementation.md` docs shipped: ai, audit, auth-rbac, cache, collaboration, config, hooks, i18n, media, offline, plugins, provider-config, rendering, review-workflow, scale, scheduling, soft-delete, themes, validation.

## Phase 1 — Foundations (largely shipped 2026-05)

| Foundation | Status |
|---|---|
| TS config migration | ✓ shipped |
| AuthIdentity layer | ✓ shipped (6 trust-mode providers; 9 test files; 66 admin-API integrations) |
| RBAC ([#194](https://github.com/gazetta-studio/gazetta-studio/issues/194)) | ✓ shipped 2026-05-13 (capabilities, built-in and custom roles, route gates; [`docs/auth.md`](docs/auth.md)); the per-target `publish:production` check since [#1253](https://github.com/gazetta-studio/gazetta-studio/pull/1253) ([#1191](https://github.com/gazetta-studio/gazetta-studio/issues/1191)) |
| Component IDs | ✓ shipped (`component-ids.ts`; called from page + fragment save handlers) |
| AdminCache abstraction | ✓ shipped (interface + `MemoryCache` + per-site + 6 test files) |
| Audit log ([#200](https://github.com/gazetta-studio/gazetta-studio/issues/200), v1 scope) | ✓ shipped (recorder + middleware + `HistoryAuditProvider`, audit drawer, retention; [`docs/audit.md`](docs/audit.md)). Denied write requests are recorded since [#1256](https://github.com/gazetta-studio/gazetta-studio/pull/1256) ([#1192](https://github.com/gazetta-studio/gazetta-studio/issues/1192)), except the 401s returned before a route is matched ([#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262)). External sinks are demand-driven; CSV export, role and config-change events, a target filter, and date and item filters in the drawer are in `design-audit.md`'s future directions |
| Hooks lifecycle | ✓ shipped (factory contributions via `admin.hooks` per ADR-0009; 10 test files) |
| Deploy adapter contract (#203) | ✓ shipped 2026-05-14 ([`design-deploy.md`](.claude/rules/design-deploy.md) + [ADR-0010](docs/adr/0010-deploy-publish-independence.md) + [`docs/deploy.md`](docs/deploy.md); `cloudflareWorkersDeploy()` + 2 validators + `target.worker` deleted; verified end-to-end against `sites/gazetta.studio` — real CF deploy, live worker on https://gazetta.studio) |
| NotificationProvider (in-admin) | ☐ pending — see Next |

**Plugin loader retired** per [ADR-0009](docs/adr/0009-no-plugin-runtime-factory-contributions.md). The locked plugin design pre-2026-05 was collapsed: Path X ([ADR-0008](docs/adr/0008-provider-factory-returns-instance.md)) covers Provider surfaces; Hooks Cut 9 ships factory contributions; Validators / Routes follow the contribution-array pattern.

## Phase 2 — Features composing against foundations

- ✓ Validation Cut 2 (background scanner) — scanner manages its own memoization
- ✓ Validation Cut 3 (render-for-analysis + a11y)
- ✓ Offline mode v1 — AdminCache + Vue Query + `idb` + `vite-plugin-pwa` + 5-state connection machine + conflict UI + 9 test files
- ✓ Offline drafts scoped to their author, and the site tree offline ([#962](https://github.com/gazetta-studio/gazetta-studio/issues/962)); drafts survive a reload, page metadata included (2026-10-18)
- ✓ A fragment edit made from a page comes back after a reload, and a restored draft stays stored until it's saved or discarded ([#1108](https://github.com/gazetta-studio/gazetta-studio/issues/1108)); each edit saves against the version it was made on, so reverting a restored draft gives no false conflict and one made on an older version conflicts instead of saving over newer content ([#1109](https://github.com/gazetta-studio/gazetta-studio/issues/1109))
- ✓ Review workflow back end ([#515](https://github.com/gazetta-studio/gazetta-studio/issues/515)–[#520](https://github.com/gazetta-studio/gazetta-studio/issues/520)) and its UI primitives and story runner ([#522](https://github.com/gazetta-studio/gazetta-studio/issues/522)–[#524](https://github.com/gazetta-studio/gazetta-studio/issues/524)), with Storybook stories running in CI ([#524](https://github.com/gazetta-studio/gazetta-studio/issues/524)); feature-bot screenshots the stories a cut changes for its reviewer to check, and shows them in its PR ([#535](https://github.com/gazetta-studio/gazetta-studio/issues/535))

Remaining: per-field translation and comments-first collaboration (Next); the review workflow's remaining cuts (Now).

## Publish correctness and safer defaults — shipped 2026-10

- ✓ CLI publishes record history ([#1079](https://github.com/gazetta-studio/gazetta-studio/issues/1079)); concurrent history writes keep every revision ([#1089](https://github.com/gazetta-studio/gazetta-studio/issues/1089), [#1112](https://github.com/gazetta-studio/gazetta-studio/issues/1112)); a revision lists only the items it changed ([#1078](https://github.com/gazetta-studio/gazetta-studio/issues/1078))
- ✓ Translated pages publish their own hash, metadata and noindex setting ([#1000](https://github.com/gazetta-studio/gazetta-studio/issues/1000), [#1024](https://github.com/gazetta-studio/gazetta-studio/issues/1024), [#1048](https://github.com/gazetta-studio/gazetta-studio/issues/1048)); static pages update when a nested fragment changes ([#1090](https://github.com/gazetta-studio/gazetta-studio/issues/1090)); an admin publish of a translation copies its manifest to the target, and publish history records translations ([#1174](https://github.com/gazetta-studio/gazetta-studio/issues/1174))
- ✓ Served sites honour archive markers ([#1060](https://github.com/gazetta-studio/gazetta-studio/issues/1060)); `gazetta serve` and the worker serve every language ([#1138](https://github.com/gazetta-studio/gazetta-studio/issues/1138)); `_redirects` has rows for every language ([#1130](https://github.com/gazetta-studio/gazetta-studio/issues/1130)); every publish to a static target writes a `404.html` at its root, and static `gazetta serve` answers a missing path with it ([#1164](https://github.com/gazetta-studio/gazetta-studio/issues/1164), cut 1 of [#1152](https://github.com/gazetta-studio/gazetta-studio/issues/1152))
- ✓ The worker's cache key includes a per-publish generation, so pages update within 5 seconds of a publish, even when a request read the old page during it ([#1125](https://github.com/gazetta-studio/gazetta-studio/issues/1125))
- ✓ `gazetta dev` and `gazetta admin` listen on 127.0.0.1 ([#1074](https://github.com/gazetta-studio/gazetta-studio/issues/1074)); static `gazetta serve` answers 404 for private paths ([#1071](https://github.com/gazetta-studio/gazetta-studio/issues/1071)); `gazetta init` gitignores `.env` and `.gazetta/` ([#1075](https://github.com/gazetta-studio/gazetta-studio/issues/1075)); the admin's publish and fetch reject item names that could reach outside the site (a `..` segment, a leading `/`, a backslash) ([#1196](https://github.com/gazetta-studio/gazetta-studio/issues/1196))
- ✓ gazetta.studio checks its live site after each deploy (CI)

## Validation Cuts 1-6 — shipped

Closes [#40](https://github.com/gazetta-studio/gazetta-studio/issues/40).

- Cut 1: save-time integrity (`Validator` interface, save-delta orchestrator, 5 ref-existence validators, 409 wiring, `ValidationBanner.vue`)
- Cut 2: background scanner + `SiteHealthDrawer.vue` + 3 background-only validators (`schema-conformance`, `orphaned-locale-file`, `unused-fragment`)
- Cut 3: render-for-analysis + a11y (axe-core) + html-validity + `altRequired`
- Cut 4: pre-publish audit step in `PublishPanel.vue` + `publish-audit.ts` + internal-link check (`validators/broken-links.ts`)
- Cut 5: `gazetta validate` CLI rewrite (15 tests)
- Cut 6: template-developer surfaces (`template-impact.ts`)
- Plus 5 soft-delete-related validators beyond the original scope

**Lighthouse validator** (originally Cut 4) **deferred indefinitely** — see `design-validation-implementation.md` deferred-items table.

## Editor papercut cluster — largely shipped

- ✓ [#104](https://github.com/gazetta-studio/gazetta-studio/issues/104) metadata editing UX — via soft-delete; rename composes archive + create + alias
- ✓ [#105](https://github.com/gazetta-studio/gazetta-studio/issues/105) component ordering UX — drag-and-drop (`@formkit/drag-and-drop` in `ComponentTree.vue`); closed 2026-05-08
- ✓ [#82](https://github.com/gazetta-studio/gazetta-studio/issues/82) breadcrumb navigation — closed 2026-05-09
- ✓ [#45](https://github.com/gazetta-studio/gazetta-studio/issues/45) component duplication — closed 2026-05-08
- ✓ [#364](https://github.com/gazetta-studio/gazetta-studio/issues/364) manual redirect creation in admin — 7 cuts shipped 2026-06; see [`design-redirect-ui.md`](.claude/rules/design-redirect-ui.md) and [`docs/soft-delete.md`](docs/soft-delete.md) "Manual redirect creation"
- ☐ [#103](https://github.com/gazetta-studio/gazetta-studio/issues/103) creation UX — see Now

## Hygiene

- ✓ Dependabot [#219](https://github.com/gazetta-studio/gazetta-studio/issues/219)
- ✓ `@hono/node-server` v2 bump (PR #224)
- ✓ Component reordering immediate-save ([#106](https://github.com/gazetta-studio/gazetta-studio/issues/106), PR #225)

## Other shipped

- ✓ [#1348](https://github.com/gazetta-studio/gazetta-studio/issues/1348) `Content<T>` types optional, nullable and array asset fields (closed 2026-10-29)
- ✓ [#1490](https://github.com/gazetta-studio/gazetta-studio/issues/1490) `gazetta init`'s templates are typed (closed 2026-10-26)
- ✓ [#1491](https://github.com/gazetta-studio/gazetta-studio/issues/1491) the worker answers routes with a trailing slash (closed 2026-10-26)
- ✓ [#1271](https://github.com/gazetta-studio/gazetta-studio/issues/1271) GitHub topics and a steady supply of good first issues (closed 2026-10-24)
- ✓ [#1274](https://github.com/gazetta-studio/gazetta-studio/issues/1274) GitHub Discussions with a pinned "How did you find Gazetta?" (closed 2026-10-24)
- ✓ [#88](https://github.com/gazetta-studio/gazetta-studio/issues/88) nested route tree + search/filter (closed 2026-05-04)
- ✓ [#184](https://github.com/gazetta-studio/gazetta-studio/issues/184) reload target registry on `site.config.ts` change (closed 2026-05-12)
- ✓ [#61](https://github.com/gazetta-studio/gazetta-studio/issues/61) 301 redirects via soft-delete (closed 2026-05-12)
- ✓ [#201](https://github.com/gazetta-studio/gazetta-studio/issues/201) image transformations (closed 2026-05-12)
- ✓ [#56](https://github.com/gazetta-studio/gazetta-studio/issues/56) pages export fragments for cross-page linking (closed 2026-05-12)

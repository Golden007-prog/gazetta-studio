# Checking that a target's live site is healthy

**Question:** should Gazetta itself, not an external uptime product, check that each published target's live site is up and serving what was published? If so, what should it check, where should the check run, and how would an operator hear about a failure?

**Why asked:** today the only live-site check is a CI step in `.github/workflows/deploy-site.yml` ("Check the live site", #1056). It fetches `/` and `/docs` on gazetta.studio and expects 200 plus a marker string, and fetches a missing page and expects 404. Each request carries a fresh cache-busting query and retries six times, 10 s apart. It covers one site, only right after a deploy, only from CI. Separately, bug #1060 showed a whole feature (archived pages → 301/410) was silently broken on the served site: both runtimes serve the archive marker as a blank `200`. The e2e tests checked the admin, never a served site. A live-site check would have caught it.

**Provenance:** compiled on 2026-10-21 by a research sub-agent. Repo facts were read from the files named, on `main` at `048cdc0c`. External claims come from official docs fetched that day, except where marked. "Not found" means a short search found nothing; it does not prove the feature doesn't exist. This is Discovery only: nothing here is locked.

## Findings: prior art

| Product | What it checks | Who sees it, where | How often | Status |
|---|---|---|---|---|
| **WordPress core** (Site Health) | Configuration and environment: background updates, loopback request (the site calling itself), HTTPS status, reaching WordPress.org, Authorization header, PHP version, debug settings, file permissions. No check of public pages, status codes or response time. | Admins, at Tools > Site Health (Status + Info tabs) and a dashboard widget | When the screen is opened. No core email; weekly digests come from third-party plugins | VERIFIED ([Site Health screen](https://wordpress.org/documentation/article/site-health-screen/), [REST tests](https://developer.wordpress.org/rest-api/reference/wp-site-health-tests/), [Trac #47606](https://core.trac.wordpress.org/ticket/47606)); "no core email" from search only, UNVERIFIED |
| **Drupal core** (Status report) | Module "runtime requirements", e.g. when cron last ran. Errors also show as a notice on the Configuration page. No public-page reachability check found | Admins, at `/admin/reports/status` | When the page is opened (an open issue proposes running checks on cron and caching) | VERIFIED ([`hook_runtime_requirements`](https://api.drupal.org/api/drupal/core!lib!Drupal!Core!Extension!module.api.php/function/hook_runtime_requirements/11.x), [issue #3336621](https://www.drupal.org/project/drupal/issues/3336621)); the Status report user doc URL 404'd |
| **Craft CMS** | Utilities > System Report: PHP, OS, database, plugins, pending updates. Environment only | Control panel | On open | UNVERIFIED (official [glossary](https://craftcms.com/glossary/utility) via search; rest from a host's tutorial) |
| **Vercel** | Deployment Checks hold a production deployment until required checks pass: native lint/typecheck, imported GitHub Actions results, or Marketplace integrations "for testing, monitoring, and observability". Vercel itself does not probe the live site here | Project settings + deployment detail view | Per deployment, before promotion | VERIFIED ([Deployment Checks](https://vercel.com/docs/deployment-checks)) |
| **Netlify** | Observability: request traffic, cache status, functions. "Alerting: Not available"; Netlify recommends log drains to a third-party tool for alerting. No uptime probe found | Site dashboard | Retention 24 h (Free) to 30 days (Enterprise) | VERIFIED ([Observability overview](https://docs.netlify.com/manage/monitoring/observability/overview/)); log drains Enterprise-only per search, UNVERIFIED |
| **Cloudflare** | Health Checks (now part of Smart Shield): probes a hostname or IP from Cloudflare's edge for chosen status codes on a chosen path; analytics show uptime, latency, failure reasons. Notifications when health changes, sent once a majority of selected regions agree | Dashboard + email | Configurable interval | VERIFIED ([Health Checks](https://developers.cloudflare.com/health-checks/), [notifications](https://developers.cloudflare.com/health-checks/how-to/health-checks-notifications/)). Not on the Free plan; Pro 10 checks |
| **Cloudflare certificates** | Expiry alerts: custom certificates emailed 30 and 14 days before expiry; Universal SSL alerts on all plans | Email / Notifications | Event-driven | VERIFIED ([custom cert renewal](https://developers.cloudflare.com/ssl/edge-certificates/custom-certificates/renewing/), [Universal SSL alerts](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/alerts/)) |
| **Headless CMSes** (Sanity, Contentful, Strapi, Payload, Storyblok) | No live-site health feature found. They don't host the front end, so "is my site up?" is the host's question, not theirs | — | — | Not found (reasoning, not a doc claim); UNVERIFIED |
| **Ghost, Statamic** | Not researched in this pass | — | — | UNVERIFIED |

### Synthesis

- **CMSes check themselves, not the public site.** WordPress, Drupal and Craft report on the CMS's own environment. None of them, in the docs read, fetches public pages and checks their status codes. WordPress's loopback test is the closest thing, and it checks that the server can call itself.
- **Hosts check the deploy, or sell probing as a separate product.** Vercel gates promotion on checks but leaves live probing to integrations. Netlify has no alerting. Cloudflare's probe is a paid add-on and checks status codes, not content.
- **Nobody checks that the served page is the published content.** This is the gap Gazetta is placed to fill. Gazetta knows what it published (sidecars, `site.json`, per-page markers), so it can say what the live site *should* return, page by page. An external uptime product only knows whether a URL answers. #1060 is the example: an uptime probe sees `200` on `/about` and reports healthy.

**For Gazetta:** the distinctive value is not "is the root up" (any uptime product does that) but "does the live site serve what this target says was published, including archived routes and 404s". That is content-aware checking, from the same source of truth publish uses.

## What "healthy" could mean for Gazetta

Candidate checks, roughly cheapest first. "At 5K" refers to the operating envelope in `design-scale.md` (5,000 pages).

| # | Check | Pass | Applies to | Cost at 5K pages | Notes |
|---|---|---|---|---|---|
| C1 | Site root reachable | `/` returns 200 with HTML | All targets with `siteUrl` | 1 request | Same as #1056's first check |
| C2 | Unknown route | A random path returns 404 | All | 1 request | Catches a catch-all that serves 200 everywhere |
| C3 | Sample of published routes | Each returns 200 | All | N requests; must be a sample (e.g. home + N most recently published + random K) | Fetching all 5K pages per run is too slow and costly (worker requests are billed) |
| C4 | Archived routes | Alias → 301 with right `Location`; gone → 410 | Worker / `gazetta serve` targets (plain static uses `_redirects`) | One per archived page; archives are a subset | Would have caught #1060. Plain-static targets hit the existing capability gap (`archive-not-supported-on-target`) |
| C5 | Content matches what was published | Served bytes match what storage holds for that page | Static/ESI | Per sampled page: one request + one storage read | Today the served HTML carries no content hash. `serve.ts` sends an ETag (sha256 of the assembled HTML, first 16 hex chars); the Cloudflare worker's page responses were not checked for one. ESI pages are assembled per request, so the comparison needs care (compare the page's own HTML, or add a published-hash marker) |
| C6 | Runtime self-report | `/health` answers | Worker targets | 1 request | The worker's `/health` returns `{ ok, pages, fragments }` from R2 prefix listings (`workers/cloudflare-r2.ts:140`). `gazetta serve` returns only `{ ok: true }` (`serve.ts:205`). Comparing the worker's counts to storage is a cheap "is it reading the right bucket" check. Note: two `bucket.list` calls per hit; unauthenticated |
| C7 | Sitemap / robots | `sitemap.xml` and `robots.txt` return 200 | Targets that publish them | 2 requests | Cheap; catches missing root files |
| C8 | TLS certificate expiry | Days left above a threshold | HTTPS `siteUrl` | 1 TLS handshake | Needs a Node TLS socket, not `fetch`. Hosts like Cloudflare already alert on this (see above): possibly redundant |
| C9 | Response time | Under a threshold | All | Free with C1/C3 | Single-location timing is noisy; report, don't fail |
| C10 | Broken internal links on the live site | — | — | High | Already covered pre-publish by the `broken-links` validator against rendered output. Out of scope here |

Two care points apply to every check:
- **Caches.** The live site sits behind CDNs. #1056 adds a fresh query per attempt so a retry never gets a cached answer. A cache-busting query can also *miss* a bad cached copy that visitors still get, so the design must choose which it tests (both have value).
- **Propagation.** Right after publish/deploy, edge caches and worker rollouts lag. #1056 retries for about a minute. Any after-publish check needs the same grace period, or it reports false failures.

## Where the check could run

The core tension: the CMS is stateless, may run as several instances, and may not be running at all when the site breaks. A check that lives only in the admin can't catch an outage that happens at 3 a.m. while nobody has it open.

| Option | Catches | Misses | Multi-instance | Dimensions touched |
|---|---|---|---|---|
| **(a) After each publish/deploy, inline** | Broken publish/deploy (e.g. #1060, a wrong bucket binding) | Later breakage (expired cert, host outage, someone edits storage by hand) | Runs on the instance that published; no coordination | Audit (record result), Hooks (`afterPublish` exists in `hooks/types.ts` and is dispatched in `hooks/dispatch.ts`), Deploy (`gazetta deploy` has no hooks per `design-deploy.md` Q9b) |
| **(b) On demand, "Check live site" per target in the admin** | Whatever is wrong right now, when someone asks | Anything nobody asks about | Stateless request; trivially correct | Auth/RBAC (which capability?), capability gap UX (no `siteUrl` → can't check), validation surfaces |
| **(c) Periodic, via the scheduling foundation** | Breakage between publishes, while the admin runs | Everything when the admin isn't running (common for local-only or CI-only setups) | Needs the lock-with-TTL from `design-scheduling.md` C2 so N instances don't all probe. **The scheduler isn't implemented** (no `.gazetta/scheduled/` code in `packages/gazetta/src`) | Scheduling, Audit, Hooks, Notifications, Cache |
| **(d) CLI `gazetta check <target>`** | Whatever the operator's cron/CI runs it against, admin or not | Nothing on its own schedule; depends on operator wiring | One-shot process; no shared state | CLI, exit codes, logging. Tension: `design-scheduling.md` lists "external cron integration" as out of scope ("Gazetta's scheduler IS the source of truth"). That line is about scheduled *content actions*; a check command is a different thing, but the wording needs reconciling |
| **(e) Inside the worker (synthetic self-check)** | Runtime/storage mismatch, from the edge, with no admin | Anything that stops the worker itself (DNS, cert, host outage); a site can't report its own death | Worker cron triggers run per deployment | Deploy adapters, rendering, worker billing; only for worker targets; plain-static has no runtime |
| **(f) Combinations** | The union | — | — | — |

**Observations:**
- **(a), (b) and (d) can share one check engine.** The same function ("check target X, return issues") can run after publish, behind a button, and from the CLI. That's the cheapest path and the CI step in #1056 becomes a one-liner (`gazetta check production`).
- **The check's output already has a shape.** The validation framework's `Issue[]` (`design-validation.md`) and its deferred "Target-side validation … Target health drawer" item (`design-validation-implementation.md`, deferred-items table) describe this almost exactly: a peer scanner that reads what the target actually serves, shown in a "Target health" drawer next to Site health. Its revisit trigger is "3+ operator reports of drift surprise OR a compliance ask". #1060 is one real drift incident, inside the project.
- **(c) is blocked** on the scheduler, and on its own doesn't catch "admin not running".
- **(e) is the only option that runs without any Gazetta process up**, but it can't see a dead site from inside the site.
- **Only an outside prober catches "the whole site is down".** That is what external uptime products are for. Gazetta can make wiring one trivial (a stable check URL, or a CLI for the operator's own cron) rather than become one.

## Notification

What exists in Gazetta's designs and code, without inventing anything new:

| Surface | State | Use for health checks |
|---|---|---|
| **Audit log** (`design-audit.md`) | Shipped (`audit/`). Closed action enum (`save`, `publish`, `delete`, …) | A failed check could record an event. Needs a new action value, closed-enum-additive like `create-redirect` |
| **Hooks** (`design-hooks.md`) | Shipped (`hooks/`). Phases include `afterPublish`; no deploy or health phases | An `afterHealthCheck` (or similar) observe-only hook would let a site-local or npm hook post to Slack. Phases are a closed list, so adding one is a design decision |
| **NotificationProvider** (`design-collaboration.md`, Extension Surface #12) | Designed, not in code (no `Notification` symbols in `packages/gazetta/src`). v1 = in-admin only; email, Slack, webhook are v2 | The natural long-term channel. In-admin alone doesn't help an operator who isn't in the admin |
| **CLI exit code + structured logs** (`design-logging.md`) | Logging conventions exist | For (d): cron/CI fails loudly and the host's own alerting (GitHub Actions email, etc.) tells the operator. Zero new surface |
| **Webhooks / post-publish hooks** (#195, ROADMAP Operability cluster) | Open issue | Overlaps with hooks above |

**Honest gap:** today the only way to reach an operator outside the admin is a non-zero CLI exit inside something that already alerts (CI, cron mail), or a hook the operator writes. Email/Slack wait on NotificationProvider v2.

## Scope recommendation (draft, for grilling)

**Smallest useful v1** — one check engine, three entry points, no scheduler:

1. **A check engine** in `packages/gazetta` that takes a target and returns `Issue[]`: C1 root 200, C2 unknown → 404, C3 a small route sample → 200, C4 archived routes → 301/410 (skipped with a capability-gap info issue on plain-static targets), C6 `/health` answers, with #1056's retry-and-cache-bust behaviour built in.
2. **`gazetta check <target>`**: runs the engine, prints results, exits non-zero on error. Replaces the bash in `deploy-site.yml`. Operators who want periodic checks run it from their own cron/CI.
3. **After publish (optional per target)** and **an admin "Check live site" action**, both calling the same engine, showing results in the publish result / a small panel. Records an audit event.
4. **Capability-gap UX** for targets without `siteUrl`: the check can't run, said plainly at the four points (`design-soft-delete.md` Q10 pattern).

**Defer:**

| Item | Why defer | Revisit when |
|---|---|---|
| Periodic checks inside the admin | Scheduler not built; doesn't help when the admin is down | Scheduling Cut lands and an operator asks |
| Worker self-check (cron trigger) | Worker-only; can't see its own outage; adds per-adapter work | Worker targets need checks without CI |
| C5 content-hash match | Needs a published-hash marker or careful ESI handling; render-path change | After v1, if drift beyond status codes shows up |
| TLS expiry (C8) | Hosts like Cloudflare already alert; needs raw TLS socket | Self-hosted operators ask |
| Email/Slack notifications | Wait on NotificationProvider v2 / hooks | NotificationProvider v2 ships |
| A "Target health" drawer with history | v1 shows the latest result; history is audit's job | Operators want trends |

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| **Gazetta becomes an uptime monitor** (always-on probing, multi-region, alert routing) | Needs an always-running process outside the site, which contradicts the stateless CMS and the solo/local project scope. External products do this well; Gazetta should be easy to plug into them |
| **Only the CI step (status quo)** | Covers one site, one deploy path; every other operator rewrites the bash; it can't know about archived pages or what was published |
| **Check every page every run** | Doesn't hold at 5K pages (time, worker request billing); a sample plus all archived routes gives most of the signal |
| **Fold it into the existing Site health drawer** | Site health validates *source*; this validates what a *target serves*. Mixing them hides which one is broken (the deferred-items row already proposes a separate "Target health" view) |
| **Make the worker's `/health` the whole answer** | It reports that the worker runs and can list R2. It says nothing about status codes, archives or content |

**Possible ROADMAP home:** the "Operability cluster (demand-driven)" in `ROADMAP.md`, next to #39 (worker observability) and #195 (post-publish hooks). The validation doc's "target-side validation" deferred item is the closest existing design hook. No collision found with `docs/non-goals.md` (no monitoring or observability non-goal listed).

## Open questions

1. **Product boundary.** Is "Gazetta checks the live site" limited to checks Gazetta can do better than an uptime product (content-aware: archives, 404s, published-vs-served), with "is it up at 3 a.m." left to external tools? Or should Gazetta own periodic probing too?
2. **Where results live.** Audit events only, a new "Target health" surface, the validation `Issue[]` model, or a sidecar on the target? This decides whether results survive the stateless admin and are visible across instances.
3. **Notification without NotificationProvider.** Is a non-zero CLI exit plus a hook (e.g. a new observe-only phase) enough for v1, or does the feature wait for email/webhook notifications?
4. Smaller: does an after-publish check block or only report? (A failed live check after the bytes are already written can't undo the publish.) And does `design-scheduling.md`'s "no external cron integration" line need rewording to allow `gazetta check` from cron?

## Fact-check ledger

| Claim | Source | Status |
|---|---|---|
| WordPress Site Health has Status and Info tabs at Tools > Site Health; lists loopback, background updates, WordPress.org reachability, debug display, PHP version checks | https://wordpress.org/documentation/article/site-health-screen/ | VERIFIED |
| Site Health async tests are REST routes: background-updates, loopback-requests, https-status, dotorg-communication, authorization-header | https://developer.wordpress.org/rest-api/reference/wp-site-health-tests/ | VERIFIED |
| Site Health dashboard widget introduced (target 5.4) | https://core.trac.wordpress.org/ticket/47606 | VERIFIED (via search summary of the Trac ticket) |
| WordPress core sends no Site Health email; weekly digests are plugins | Search of wordpress.org plugin listings | UNVERIFIED (absence not proven) |
| Drupal status report entries come from `hook_runtime_requirements()`, shown at `/admin/reports/status`; errors notice on Configuration page; cron last-run check | https://api.drupal.org/api/drupal/core!lib!Drupal!Core!Extension!module.api.php/function/hook_runtime_requirements/11.x | VERIFIED (via search summary of the API page) |
| Open Drupal issue on running requirements on cron and caching | https://www.drupal.org/project/drupal/issues/3336621 | VERIFIED (via search) |
| Craft System Report covers PHP, OS, DB, plugins | https://craftcms.com/glossary/utility (glossary) + third-party tutorial | UNVERIFIED |
| Vercel Deployment Checks hold production promotion until checks pass; sources: native lint/typecheck, GitHub Checks, Marketplace integrations | https://vercel.com/docs/deployment-checks | VERIFIED |
| Netlify Observability: alerting not available; recommend log drains; retention 24 h–30 days by plan | https://docs.netlify.com/manage/monitoring/observability/overview/ | VERIFIED |
| Netlify log drains are Enterprise-only | https://docs.netlify.com/manage/monitoring/log-drains/ (search result) | UNVERIFIED |
| Cloudflare Health Checks: edge probes for status codes on a path; analytics for uptime/latency; part of Smart Shield; not on Free, Pro 10 checks | https://developers.cloudflare.com/health-checks/ | VERIFIED |
| Cloudflare Health Checks notifications fire when a majority of selected regions agree | https://developers.cloudflare.com/health-checks/how-to/health-checks-notifications/ | VERIFIED (via search summary) |
| Cloudflare emails custom-certificate expiry 30 and 14 days ahead; Universal SSL alerts on all plans | https://developers.cloudflare.com/ssl/edge-certificates/custom-certificates/renewing/, https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/alerts/ | VERIFIED (via search summary) |
| Headless CMSes (Sanity, Contentful, Strapi, Payload, Storyblok) have no live-site health feature | none | UNVERIFIED (reasoning) |
| Ghost, Statamic | none | NOT RESEARCHED |

Repo facts (read directly, not external): `deploy-site.yml` "Check the live site" step; worker `/health` at `workers/cloudflare-r2.ts:140`; `serve.ts:205` `/health` and the ETag at `serve.ts:213`/`:294`; archive marker parser in `runtime/archive-marker.ts` unused by runtimes (#1060); `broken-links` validator checks internal links in rendered output only; `afterPublish` dispatched in `hooks/dispatch.ts`; no scheduler or NotificationProvider code in `packages/gazetta/src`; ROADMAP Operability cluster lists #39 and #195.

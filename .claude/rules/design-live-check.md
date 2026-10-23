# Live check

After a publish or deploy, Gazetta checks that the target's live site serves what was published: changed pages answer with the version just published, renamed pages redirect, archived pages return 410, removed pages 404. Authors see the result in the publish panel; operators get it from `gazetta check` and a hook.

**Status**: design pass complete (2026-10-21), grilled Q1–Q8. Implementation not started.

**Companion docs:**
- [`docs/audits/live-site-health.md`](../../docs/audits/live-site-health.md): Discovery research (prior art, candidate checks, where checks can run), with a fact-check ledger
- [`design-publishing.md`](design-publishing.md): targets, publish, the stateless CMS this feature must respect
- [`design-soft-delete.md`](design-soft-delete.md): archive markers (Q10), the alias flatten (Q3), and the four-point capability-gap UX this feature reuses
- [`design-validation.md`](design-validation.md): the `Issue` model results use; its deferred "target-side validation" item is the closest earlier idea
- [`design-hooks.md`](design-hooks.md): the hook phases `afterLiveCheck` joins
- [`design-deploy.md`](design-deploy.md): `gazetta deploy`, after which the smoke check runs
- [`sidecars.md`](sidecars.md): the reverse-dependency indices the route planner reads
- Related bugs: [#1060](https://github.com/gazetta-studio/gazetta-studio/issues/1060) (served sites ignore archive markers, the failure this feature would have caught), [#1068](https://github.com/gazetta-studio/gazetta-studio/issues/1068) (a disconnect stops a publish; the same fix lets the check outlive the connection)

## Scope

**In v1:**
- A check engine that compares what a target's live site serves with what was published, and returns `Issue[]`
- Triggers: after every publish and every `gazetta deploy` to a target with a `siteUrl`, plus on demand (admin, `gazetta check <target>`)
- A published-version marker in every published page (and, on ESI targets, every fragment body)
- Route planning from the target's own dependency graphs, with a request cap
- Reports stored on the target; a `live-check` audit event; an `afterLiveCheck` hook
- Admin: progress and results in the publish panel, a top-bar warning on failure, Re-check and Check all
- CLI: `gazetta check` (including `--last-publish`), and checks after `gazetta publish` and `gazetta deploy`

**Out of v1:**
- Periodic checks (waits on the scheduler; see Future directions)
- Email or Slack delivery built into Gazetta (operators use the hook; NotificationProvider later)
- TLS certificate expiry, response-time thresholds
- Checking content quality (validators do that; this checks delivery)

**Non-goals:**
- **Uptime monitoring.** "Is my site up right now, at any hour?" needs a process running outside the site, multi-region probes and alert routing. External uptime services do that well. Gazetta documents how to point one at the site, and `gazetta check` can run from the operator's own cron.

## Locked decisions

### Q1 — The job is publish verification

The feature answers "did my publish land correctly?", not "is my site up right now?". It runs at a known moment (after a publish or deploy), and Gazetta knows the expected answer page by page. An uptime probe can't: it would report #1060's blank archived page as a healthy `200`.

| Rejected | Why |
|---|---|
| Content-aware checks plus built-in periodic checks | Only works while an admin instance runs, and needs the unbuilt scheduler. Deferred, not rejected outright (Future directions). |
| A full uptime monitor | Needs an always-running process outside the site, against the stateless-CMS rule (`design-decisions.md` #1); duplicates external services. |

### Q2 — When it runs

After every publish and every `gazetta deploy` to a target that has a `siteUrl`, plus on demand. On by default; opt out per target with `liveCheck: false`.

- **Report only.** A check never blocks or rolls back: the bytes are already on the target.
- **Waits for propagation.** Retries until a per-target wait (`liveCheck.waitSeconds`, defaults by target type) runs out. Running out is "not live yet", not "wrong".
- **Two views of each route.** One request bypasses caches (a fresh query value per attempt), one doesn't. If they differ, the result is "correct, but visitors still see an older copy". A CDN can ignore query strings in its cache key, so the bypass request is checked too: if its `Age` header is above 0, it came from a cache, that view is marked unavailable, only the visitor view is judged, and the report says "couldn't bypass the cache" (info).
- **Sites behind login.** Optional `liveCheck.headers` (values from env vars in `site.config.ts`, e.g. a Cloudflare Access service token). A login redirect is "needs credentials", not "broken". The headers are sent only to `siteUrl`'s origin, and the check never follows a redirect to another origin (Q3, redirects). `siteUrl` itself isn't restricted: it comes from `site.config.ts`, which is code, so whoever can change it can already run code; blocking private addresses would add no protection and would break local targets.
- **CLI:** the check prints after the publish result. `--no-check` skips it; the exit code is non-zero only with `--check-strict`. The standalone `gazetta check <target>` is a gate, not a report: it exits non-zero when any result has error severity (`wrong`, `unreachable`, `needs-credentials`), and with `--strict` on warnings too, so CI and cron can rely on it. CI flows that publish then deploy (like `deploy-site.yml`) pass `--no-check` to the publish and run `gazetta check <target> --last-publish` after the deploy, so the post-publish check doesn't test the old runtime. A `--no-check` publish still runs the route planner (no HTTP requests) and writes the plan as a report with `status: deferred` (Q5). `gazetta check <target> --last-publish` runs the newest deferred plan for that target, so it checks exactly what the publish wrote, removals included. With no deferred plan it falls back to the smoke set and the report says so. If the target has history turned off, it falls back to the smoke set and the report says so.

| Rejected | Why |
|---|---|
| Opt-in per target | Misses the people who don't know they need it. |
| Production environments only | Staging is where a broken rename should be caught. The environment sets how careful to be, not whether the site is correct. |
| Ask at publish time | A question on every publish is noise; the answer is almost always yes. |
| On demand only, or CLI only | Most authors would never run it; admin-only authors get nothing. |
| `gazetta check` exiting 0 unless `--strict` | Run from CI or cron, a failing check would pass silently. |
| Only the smoke set after a deploy that follows a `--no-check` publish | The pages the publish changed, their dependents and re-pointed aliases go unchecked. |
| Reading `Revision.items` | It lists the whole snapshot, so changed pages get no priority under the cap (#1078). |
| Comparing the latest publish revision's snapshot with the previous one | CLI publishes write no revision ([#1079](https://github.com/gazetta-studio/gazetta-studio/issues/1079)); snapshots hold only manifests, so template-only changes and `--force` republishes show no difference. |
| Restricting `siteUrl` to public addresses | The config is code: no protection gained, and local targets break. |
| After deploy only | Misses content publishes, the frequent case. |
| Periodic, or the runtime checking itself | Out of scope by Q1; a site can't see its own outage. |

### Q3 — What gets checked

**Publish** — every route the publish could have changed, each with an expected answer:
- published pages, per published language: `200` with the new version (Q4); archived with an alias: `301` to the alias route in the same language, or, on a static target whose alias destination has no version in that language, to the destination's default-language route (follows from `design-soft-delete.md` Q10); archived without one: `410`;
- removed pages: `404`, archives included (`design-target-removal.md` Q5); a removed translation on worker and ESI targets: the default-language page (`design-target-removal.md` Q3);
- pages using a published fragment, from the target's `fragment-deps` index (walked transitively);
- archives aliasing a renamed or archived page, from the target's `alias-targets` index (publish must start writing it to targets; today only `asset-refs` and `fragment-deps` are written, `publishDepIndices` in `publish-rendered.ts`);
- a replaced asset's URL (`200`) and the pages using it, from `asset-refs`;
- site files the publish wrote (`sitemap.xml`, `robots.txt`, `_redirects` behaviour);
- always the root and one unknown URL (`404`).

**Expected answers follow the target's runtime capabilities** (`redirects`, `gone-status`; `docs/runtime-capabilities.md`). Without `gone-status`, an archive without an alias is expected to answer `404`; without `redirects`, alias routes are `not-checked`, except on a static target without `redirects.format`: there an alias's old route is expected to answer 200 with the redirect page, its first line the archive marker and an instant refresh to the alias's route (`design-soft-delete.md` Q10, #1152), so a leftover blank marker file is flagged too.

Decided (the redirect-page answer): maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Keep those alias routes `not-checked` | The redirect page would never be checked after a publish, and a leftover blank marker file at an alias route would go unflagged. |

**Redirects are checked, not followed.** Requests use manual redirect handling (`redirect: 'manual'`): a `301` passes only when its `Location`, resolved against the request URL, has the expected alias route as its path (the query string is ignored: a host may carry the cache-bypass value into the redirect), and a redirect to a login page is `needs-credentials`. A `401` is `needs-credentials`; a `403` is only when the route is expected to answer `200`. Where `404` or `410` is expected, a `403` counts as not served, with an info note that the host answers missing files with `403` (S3, for example, does when the caller can't list the bucket). The check follows a redirect only to confirm the destination answers, and only on the same origin.

Only the languages that changed are expanded. Dynamic routes (`/blog/:slug`) are checked through the instances published to target storage; the template route itself is skipped with an info note. The planner reads the **target's** indices after publish has rewritten them. Those indices are rebuilt from the whole source site (`rebuildDepIndex`, `publish-rendered.ts`), so they can name pages the target doesn't have. The planner therefore checks a dependent route only when the target has that page: its per-item `.{hash}.hash` sidecar exists there, the file `compareTargets` reads. Missing pages are skipped and not counted. Edges can still differ from what the target serves (the published version of a page uses `@header`, the source no longer does); the planner then misses that route, a gap rather than a false alarm. Making the target's indices describe the target is a separate publish fix ([#1077](https://github.com/gazetta-studio/gazetta-studio/issues/1077)).

**Priority and cap.** Routes are checked in priority order (published routes, then direct dependents, then deeper ones) within `liveCheck.maxRequests` (default 1,000 HTTP requests per target per run, counting both views and redirects). Past the cap the report says so ("checked 1,000 of 4,800"). The operator can read the value from an env var in `site.config.ts` (`maxRequests: Number(process.env.LIVE_CHECK_MAX ?? 1000)`); `gazetta check --max-requests` overrides it once.

**Deploy and on demand** — a smoke set with one of each kind of response the runtime produces: the root, a 404, one page per language, one alias redirect and one 410 if any exist, `sitemap.xml`, `robots.txt`, one fingerprinted asset. About 10 requests. `--all` (CLI) and Check all (admin) check every page, at the same request rate.

| Rejected | Why |
|---|---|
| Following redirects automatically | The 301's `Location` and login redirects are hidden behind the destination's answer. |
| A fixed random sample each time | Usually misses the page just changed. |
| Only the items published | Misses fragment dependents, re-pointed redirects, changed assets. |
| Trusting the target's indices as they are | They're rebuilt from the source, so pages the target never received would be expected to answer `200` and reported `wrong`. |
| A fixed 10-page sample per fragment | The graph gives the exact set for free; sampling throws accuracy away. |
| Every page, every run | Doesn't hold at 5K pages: time, and billed worker requests (Cloudflare's free plan allows 100,000 a day). |
| A Gazetta-specific env var for the cap (`GAZETTA_LIVE_CHECK_MAX_REQUESTS`) | One value for all targets; invisible in `site.config.ts`; against `design-config.md`'s "no Gazetta-specific env wrapper". |

### Q4 — What makes a page "the version just published"

Publish writes `<!-- gazetta:published hash=ab12cd34 -->` at the end of each page's `<head>`. On ESI targets each fragment body carries its own marker. The hash is of the **rendered output** (computed without the marker), so content, template and asset-URL changes all change it. Line 1 stays reserved for the cache comment and archive markers.

The check reads the markers and compares them with what publish wrote: the page's, and each fragment's, so a stale `@header` on an otherwise current page is reported as exactly that. A route can answer with the expected status while its version can't be compared: it carries no marker, or it's rendered per request and has no published hash. That is `status-only` (info), never `live`; `live` means the version was confirmed. If other pages in the same run carry markers, a missing one means the page was published before this feature, and the report says "republish to verify". A plain republish would skip those pages, since incremental publish compares manifest hashes (`sidecars.md`) and the marker doesn't change them. So cut 1 adds a render-format version to the publish hash input, bumped whenever publish output changes: introducing the marker invalidates every hash once, and the next publish republishes everything (one full publish, in the changelog). Until then the report names `gazetta publish --force`. If no page in the run carries one, the host probably strips HTML comments, the report says so, and it doesn't suggest republishing.

| Rejected | Why |
|---|---|
| Status code only | A stale or old page passes. |
| Counting a `200` without a version as `live` | A stale page on a dynamic route, or on a host that strips comments, reads as confirmed. |
| Compare served bytes with storage (assembling ESI pages like the worker) | A storage read and an assembly per page; any byte a host injects fails every page; doesn't work for dynamic routes. |
| A response header (`X-Gazetta-Published`) | Plain static hosts can't set headers. |
| Compare ETags | Each host computes its own. |
| Compare `<title>` with the manifest | A body edit doesn't change the title. |
| Hash the manifest instead of the output | Misses changes outside the manifest (a template edit, a re-rendered asset URL). |

### Q5 — Where results live

Each run writes `.gazetta/live-check/{timestamp}-{random}.json` on the target it checked (the random suffix keeps two runs that start in the same second apart): the trigger, every route with its expected and actual answer, counts. A `--no-check` publish writes the same file with `status: deferred`: the planned routes, no results (Q2). The file is written when the run starts (`status: running`, with a deadline of the wait plus the request cap times the timeout) and rewritten when it ends. A reader treats a `running` report past its deadline as `incomplete`, so a crashed run is visible without a recovery job. No personal data: who triggered the run goes only into the audit event. The newest file is the latest result. If #1070 moves `.gazetta/` to separate private storage, reports move with it. The last 20 are kept per target (configurable), pruned like history. One `live-check` audit event per run carries the trigger and counts (an additive value in the closed action list).

`.gitignore` gains `**/targets/**/.gazetta/live-check/`. Reading a report needs `read:pages`.

| Rejected | Why |
|---|---|
| The publish response only | Lost when the tab closes; other instances never see it. |
| The audit log only | Audit records actions, not 1,000-row reports; authors can't read it by default. |
| The validation scanner's store (Site health) | In memory per instance; describes the source, not a target. |
| One "latest" file, overwritten | Two runs at once overwrite each other; no history. |
| Writing the report only at the end | A crash mid-run leaves no trace, and readers can't tell "interrupted" from "never ran". |
| A recovery job that marks abandoned runs | Needs a running process to notice; the deadline in the file does the same without one. |
| A marker file per route | Thousands of files per run, each to clean up; a report gives per-page status from one read. |
| The publish's history revision | Written before the check finishes and never changed; deploys and on-demand runs have none. |
| The source site's directory | State about a target kept away from it; another CMS connected to the same target wouldn't see it. |
| Browser storage, the admin cache, an external database | Per person, evictable, or against the stateless-CMS rule. |
| The publish-state marker (`.pub-{ts}`) | Mixes "published when" with "is it live"; deploys and on-demand runs don't publish. |

### Q6 — Telling someone who isn't watching

A new observe-only hook phase, `afterLiveCheck`, fires once per run with the final result (after the wait): `outcome`, `previousOutcome` for that target (so a hook can alert on new failures and recoveries only), the failing issues, counts, `triggeredBy: { kind: 'publish' | 'deploy' | 'on-demand' | 'schedule', actorId? }`, and the report's path. It fires after the report is written. The audit event is recorded before the final report write. The report carries `notified: false` until the hook phase has run, then is updated to `true`; `previousOutcome` comes from the last report with `notified: true`. So a crash between writing the report and firing the hook doesn't swallow the alert: the next run still sees the failure as new. A failing or slow hook never blocks (after-hook rules, 5 s default timeout). The docs give an example hook that posts failures and recoveries to a Slack webhook.

**CLI commands load hooks.** Today only the admin servers build the hook registry (`setupCmsApi`, `setupProductionMode` in `cli/index.ts`); `gazetta publish`, `deploy` and `check` run no hooks, and `publishRun`'s hook steps are marked reserved. They will load the same `admin.hooks` contributions. This also makes existing `afterPublish` hooks fire for CLI publishes, a behaviour change that needs a changelog note and a line in `docs/hooks.md`.

Optional `admin.url` lets messages link to the report; without it they name the target and time.

When NotificationProvider ships (`design-collaboration.md`), the same event becomes a `live-check` notification to whoever published, and to the requester when an approver published on their behalf.

| Rejected | Why |
|---|---|
| Nothing beyond the admin and the exit code | An admin-only author learns nothing until someone opens the admin. |
| Wait for NotificationProvider | Not built, so v1 would notify nobody; and its first version is in-admin only. |
| A built-in webhook setting | A second way to send events out, next to hooks and #195. |
| Built-in email | NotificationProvider's job. |
| Rely on CI | Covers CI-driven publishes only. |
| `previousOutcome` from the last report, notified or not | A crash before the hook fires makes the next run treat the failure as old, and the alert is never sent. |

### Q7 — How a check runs

One check engine, three callers:
- **Admin:** the publish stream (`POST /api/publish/stream`) sends the publish events, then `live-check` events. The check runs on the server independently of the connection: if the author leaves, it still finishes, writes the report and fires the hook. (#1068 fixes the same problem for the publish itself; the check must use the same pattern.)
- **CLI:** the engine runs after `publishRun` returns, or after the deploy, and prints.
- **On demand:** a separate route (admin) or `gazetta check` (CLI).

At most 10 requests at a time per process, across all running checks; 10 s timeout per request. A restart mid-check loses that run; its `running` report passes its deadline and reads as `incomplete` (Q5), and the next publish or a Re-check recovers.

| Rejected | Why |
|---|---|
| The publish request waits for the check | Publishing looks slower; proxy timeouts could make a successful publish look failed. |
| Background, delivered later by polling or a separate event | A second channel for the same result. |
| A queued job any instance can claim | Survives restarts, but adds claiming, retries and cleanup for a minute-long, report-only check. |
| The author's browser does the checks | CORS, the browser's own cache and network; stops when the tab closes. |
| The live runtime checks itself | Can't see its own outage; plain static hosts have no runtime. |

### Q8 — Build order: a thin end-to-end slice first

The riskiest assumption, that the marker reaches visitors through the worker, ESI assembly and CDNs, is tested in the second cut, on gazetta.studio. Each cut is real code that stays. Independent cuts run in parallel: 7a at any time; 4 and 5 after 2; 8a and 8b after 5.

| Rejected | Why |
|---|---|
| Bottom-up layers | Nothing usable for weeks; the marker risk tested last. |
| Admin UI first on a placeholder engine | Stubs (team rule 18), and UI designed before the engine's behaviour is known. |
| CLI only in v1 | Admin authors, the main scenario (CA1), get nothing. |
| One big PR | Unreviewable; no piece-by-piece rollback (team rule 17). |
| A publish-check slice first | A bigger first slice than the smoke slice, with the marker risk still later. |
| Status codes first, marker last | Ships the check Q4 rejected, and delays the riskiest assumption. |

## Result categories

Every failure is an `Issue` (`design-validation.md`), so severity words and drawer components match the rest of the admin.

| Category | When | Severity |
|---|---|---|
| `live` | Expected answer, current version, in both views | — (not an issue) |
| `not-live-yet` | Wait ran out before the new version appeared | warn |
| `stale-for-visitors` | Correct when bypassing the cache, older copy in the visitor view | warn |
| `wrong` | Wrong status, wrong redirect target, or wrong version | error |
| `unreachable` | DNS, TLS or connection failure for the site as a whole | error |
| `needs-credentials` | A login redirect, a 401, or a 403 on a route expected to answer 200 | error |
| `status-only` | Expected status, but the version couldn't be compared: no marker (published before this feature, or the host strips comments) or rendered per request | info |
| `not-checked` | Skipped: past the cap, a dynamic template route, or a host that can't produce the expected answer (e.g. an S3 website can't redirect) | info |
| `incomplete` | The run stopped before finishing (its `running` report passed its deadline) | warn |

## UX check

Following `team-preferences.md` rule 23. Results are worded for authors; technical detail sits under Details.

### Publish panel row (cut 8a)

Root `data-testid="live-check-row"`, with `data-state`.

| State | Copy | Controls (`data-testid`) |
|---|---|---|
| `checking` | "Checking the live site…" | — |
| `live` | "Live ✓" (fades after a few seconds) | — |
| `not-live-yet` | "Published, but the live site doesn't show it yet. This usually clears within minutes." | Re-check (`live-check-recheck`) |
| `stale-for-visitors` | "Published. Visitors may see the previous version until the cache refreshes." | Details (`live-check-details`) |
| `wrong` | "The live site isn't serving this correctly. Your content is saved; tell your site operator." | Details |
| `unreachable` | "We couldn't reach the live site to check it." | Details |
| `needs-credentials` | "The live site asked for a login, so we couldn't check it." | Details |
| `status-only` | "Published. The live site answers, but we couldn't confirm it's the new version." | Details |
| `incomplete` | "The check stopped before it finished." | Re-check |
| `capped` (with any of the above) | Adds "Checked 1,000 of 4,800 pages." | Check all (`live-check-all`) |
| `skipped` | Nothing rendered (no `siteUrl`, or `liveCheck: false`) | — |

Large publishes show one summary line first ("28 live, 2 not live yet"); the list is collapsed under it (`live-check-summary`, `live-check-list`).

### Top-bar warning (cut 8b)

A warning icon on a target (`target-live-check-warning`) appears only when its latest report with `status: complete` has a final failure: `wrong`, `unreachable`, `needs-credentials`, or `not-live-yet` that a later check confirmed. No icon means fine. `running`, `deferred` and `incomplete` reports neither set nor clear it; only a later complete run that passes clears it. Clicking opens the report view (`live-check-report`).

### Buttons and capability gaps (cut 8c)

- Re-check and Check all need the publish capability for that target (`publish:non-production` or `publish:production`). Viewers see results but not the buttons.
- A `staging` or `production` target without a `siteUrl` shows "Add `siteUrl` to verify the live site" at the four points (boot validation, publish panel, a validator, the pre-publish audit). Local targets skip silently.

## Foundational checks

- **Multi-instance:** per-run report files never overwrite each other; any instance reads the newest. The check runs on the instance that published. No shared in-memory state.
- **Scale:** the route set comes from directory reads of the target's indices, not a site scan; requests are capped. Report size about 150 bytes per route.
- **Locale:** only changed languages are expanded; each result records its locale.
- **Themes:** no separate URLs, so nothing to check.
- **Auth + RBAC:** reading reports needs `read:pages`; running on demand needs the target's publish capability; automatic runs inherit the publish's authority.
- **Audit:** a `live-check` event per run (additive closed-enum value).
- **Review:** an approval that publishes triggers the check like any publish; the requester hears through the hook, and later NotificationProvider.
- **Hooks:** new observe-only phase `afterLiveCheck`; CLI commands load hook contributions.
- **Render:** publish adds the marker to rendered output; no render-time behaviour changes. Line 1 stays reserved.
- **Validation:** results use the `Issue` model; the missing-`siteUrl` warning is a validator.
- **Plugin:** extension through the hook phase only.
- **Cache:** the two-view check reports stale CDN copies; nothing is cached by the check.
- **Offline:** checks need the network; an offline admin shows the last report it read.
- **Collaboration:** everyone sees the same report.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Published-version marker at the end of `<head>` in pages and (ESI) fragment bodies, rendered-output hash; parser in `runtime/`; render-format version in the publish hash input (`sidecars.md` updated); changelog notes for HTML snapshot tests and the one full republish | — | unit-first | Medium |
| 2 | Thin slice: check engine with the smoke set, two views, wait and retries, `Issue[]`; `gazetta check <target>`; `liveCheck` config basics (`waitSeconds`, `headers`); CLI docs. Integration test against CI's `e2e-prod` server, including a deliberately broken route | 1 | integration | Medium |
| 3 | gazetta.studio: replace `deploy-site.yml`'s check step with `gazetta check production` (maintainer PR: workflow file) | 2 | (CI) | Low |
| 4 | Route planner: affected routes from the target's `fragment-deps`, `alias-targets` and `asset-refs`; publish writes `alias-targets` to targets; removals, changed languages, dynamic-route instances, priority order, `maxRequests` | 2 | unit + api | Medium-high |
| 5 | Reports on the target, retention, `.gitignore` line, `live-check` audit event; `--json` | 2 | api-first | Low |
| 6 | Checks after `gazetta publish` and `gazetta deploy` (CLI layer only); `--no-check`, `--check-strict`, `--all`, `--max-requests`, deferred plans from `--no-check` publishes and `gazetta check --last-publish`; plus a maintainer PR adding `--no-check` to `deploy-site.yml`'s publish step and `--last-publish` to its check | 4, 5 | integration | Medium |
| 7a | CLI commands load hook contributions; changelog note and `docs/hooks.md` line (existing `afterPublish` hooks now fire for CLI publishes) | — | api-first | Medium |
| 7b | `afterLiveCheck` phase with `outcome`, `previousOutcome`, `triggeredBy`; optional `admin.url`; Slack example in the docs; changelog note for exhaustive switches over phases | 6, 7a | api-first | Low |
| 8a | Admin: check events in the publish stream, the check outliving the connection (#1068's pattern), panel rows and summary per the state table; Storybook stories from the table | 5, #1068 | component + e2e | Medium |
| 8b | Admin: top-bar warning from the latest report; report view | 5 | component | Medium |
| 8c | Admin: Re-check and Check all with capability gates; missing-`siteUrl` message at the four points (staging and production only) | 8a | component + api | Low |
| 9 | `docs/live-check.md` (delivery, not content quality; uptime services and cron for "is it up"; container deploys run `gazetta check` after their platform's deploy), ROADMAP, changelog | all | docs | Low |

Each user-facing cut updates its own docs; `docs/live-check.md` grows with them, marking parts "available" or "coming". Cuts 3 and 6's workflow edit are maintainer PRs (bots can't push workflow files, #840).

## Migration

Nothing breaks. Pages published before cut 1 have no marker and report `status-only` until republished; the first publish after cut 1 republishes everything, because the render-format version changes every hash. Targets without a `siteUrl` are skipped. Operators with `afterPublish` hooks see them fire for CLI publishes after cut 7a (changelog).

## Open questions

1. **Do hosts and CDNs keep HTML comments?** The worker does (`parseCacheComment` strips only the first-line cache comment; `assembleEsi` replaces only ESI placeholders), but a minifying CDN might not. Cut 2 tests gazetta.studio. A host that strips them degrades to `status-only` results, and the report says the host may strip comments (Q4).
2. **Default waits per target type.** Measured on gazetta.studio in cut 2; other hosts start from labelled guesses.
3. **The check outliving the connection** depends on #1068's fix landing first, since Hono's `streamSSE` aborts when the client leaves.
4. **Plain static hosts serve `.gazetta/`.** On GitHub Pages or an S3 website, storage is the public site, so reports (and history) are downloadable. Reports carry no personal data. `gazetta serve` on a static target serves the folder too ([#1071](https://github.com/gazetta-studio/gazetta-studio/issues/1071)). Operator steps are in `docs/audit.md` ("Where Gazetta keeps its own files"); the structural fix, keeping `.gazetta/` in separate private storage, is [#1070](https://github.com/gazetta-studio/gazetta-studio/issues/1070).
5. **`design-scheduling.md` says "no external cron integration".** That line is about scheduled content actions; running `gazetta check` from cron is a different thing, but the wording should be reconciled when the scheduler is designed.

## Future directions

- **Periodic checks** once the scheduler exists: re-check each target every N hours while an admin runs, same engine, `triggeredBy.kind: 'schedule'`.
- **NotificationProvider delivery** of `afterLiveCheck` results.
- **A Target health view** with report history and trends, alongside Site health.
- **TLS expiry and response-time reporting** if self-hosted operators ask.
- **A worker self-check** on worker targets that want checks without CI.

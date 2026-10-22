# Public storage

Every target keeps Gazetta's own files in a `.gazetta/` folder next to the published site: history, the audit log, review state, dependency indices, live-check reports. When a host serves the target's storage directly, those files are downloadable by anyone. This design makes that impossible by default: a target whose storage visitors can reach keeps no sensitive state, Gazetta assumes cloud storage is reachable unless told otherwise, and a detected leak stops publishing to that target until it's fixed.

**Status**: design pass complete (2026-10-21), grilled Q1–Q8. Implementation not started.

**Companion docs:**
- [#1070](https://github.com/gazetta-studio/gazetta-studio/issues/1070): the issue this design resolves, with the options considered before the pass
- [`docs/audit.md`](../../docs/audit.md) "Where Gazetta keeps its own files, and when they're public": the operator guidance that ships today
- [`design-live-check.md`](design-live-check.md): the probe and the lock run as part of the live check; reports hold the probe result
- [`design-publishing.md`](design-publishing.md): targets, history inside the target (`design-decisions.md` #18 still holds: a public target simply keeps no history)
- [`design-audit.md`](design-audit.md): where audit events are recorded; external sinks
- [`design-review-workflow.md`](design-review-workflow.md), [`design-scheduling.md`](design-scheduling.md): state that must not land on a public target
- [`design-deploy.md`](design-deploy.md): static deploy adapters (#208, #209, #211) copy only site files
- [`docs/runtime-capabilities.md`](../../docs/runtime-capabilities.md): the per-target capability matrix the capabilities view extends
- ADR-0017 (cut 8): target storage is assumed public unless declared private
- Related bugs: [#1071](https://github.com/gazetta-studio/gazetta-studio/issues/1071) (static `gazetta serve` serves `.gazetta/`; cut 1), [#1074](https://github.com/gazetta-studio/gazetta-studio/issues/1074) (`gazetta dev`/`admin` listen on every interface), [#1075](https://github.com/gazetta-studio/gazetta-studio/issues/1075) (`init`'s `.gitignore`), [#1077](https://github.com/gazetta-studio/gazetta-studio/issues/1077) (target indices built from the source)

## Scope

**In v1:**
- A per-target `publicStorage` setting, resolved by `isPublicStorage(target)`, public by default except for an editable filesystem target or a target deployed by a copy adapter
- On a public target: no history, audit or review state; audit events recorded elsewhere; no schedules
- `isPublicSitePath(path)`: one rule, used by every server and deploy adapter, for which stored files visitors may receive
- A registry of `.gazetta/` folders, each marked safe or not on public targets, enforced by the type system and a test
- A target capabilities view (admin and `gazetta targets`)
- A probe in the live check; a detected leak locks publishing to the target

**Out of v1:**
- Separate private storage for a target's state (rejected in Q3; see Future directions)
- A runtime storage guard (Q7; Future directions, triggered by plugins that write state)
- Making a target's dependency indices describe the target ([#1077](https://github.com/gazetta-studio/gazetta-studio/issues/1077))

**Non-goals:**
- Protecting `.gazetta/` on the **source** site directory. It isn't served; committing it to git is [#1075](https://github.com/gazetta-studio/gazetta-studio/issues/1075).
- Securing the admin itself ([#1074](https://github.com/gazetta-studio/gazetta-studio/issues/1074), `design-auth-rbac.md`).

## Discovery

What lives in `.gazetta/` (shipped and designed): `history/` (every past version, plus asset bytes), `audit/` (actor IDs and emails), `review/` (review state, approvers' IDs), `fragment-deps/`, `asset-refs/`, `alias-targets/` (dependency indices), and from designs: `live-check/`, `scheduled/`, `comments/`, `notifications/`, `publish-requests/`, `cache/`, `audit-index/`, `page-index/`, `built-config/`. Per-item sidecars (`.{hash}.hash`, `.pub-{ts}`) sit next to each page.

No reader is on the serving path: the worker (`workers/cloudflare-r2.ts`) and `serve.ts` never mention `.gazetta`. Static `gazetta serve` does serve any stored file (#1071); the worker and ESI `serve` serve any file under `/pages/` and `/fragments/`, sidecars included (read from code, not tested). R2 public access exposes the whole bucket and is off by default; a path can be blocked only on a custom domain with a WAF rule and `r2.dev` off ([Cloudflare](https://developers.cloudflare.com/r2/buckets/public-buckets/)). gazetta.studio's domain returns 404 for `/.gazetta/…` (checked 2026-10-21).

## Locked decisions

### Q1 — `.gazetta/` is never public, and that's enforced

A target whose storage visitors can reach can't keep sensitive state there; validation and the lock (Q6) make that a hard rule, not advice.

| Rejected | Why |
|---|---|
| Warn, don't block | The folder holds personal data and deliberately removed content; a dismissable warning leaves it public, and operators find out afterwards. |
| Promise it only where Gazetta deploys | Misses the worst case: an S3 or Azure static website pointed at the bucket, where Gazetta uploads nothing. |

### Q2 — How Gazetta knows storage is public

A declaration on the target drives enforcement; the live check probes for leaks the declaration got wrong (Q6). Static deploy adapters copy only site files (Q3), so their targets' storage stays private and needs no declaration.

| Rejected | Why |
|---|---|
| Infer from config (static and no worker = public) | Every local target and the starter's `staging` are static and private; enforcement would block normal development. |
| Probe only | Needs a `siteUrl` and the network, finds the problem after it exists, can't run at boot. Kept as the backstop. |

### Q3 — A host that serves storage directly: sensitive state off

The normal path for static hosting is private target storage plus a deploy adapter that copies only site files. For an operator who deliberately points a host at the storage, that target keeps no history, audit or review state. The source's history covers recovery: restore there and publish again.

| Rejected | Why |
|---|---|
| A second, private storage for the target's state | Adds a storage to configure and back up for a rare setup; the copy-deploy pattern already gives private storage to anyone who wants undo on a static host. |
| Keep the state on the source (`.gazetta/targets/X/`) | CI runners are thrown away with their history; two admins on one target diverge. |
| Move only the sensitive folders | Two locations, and a sensitivity decision for every new folder with no default. (The folder table in Q5 is the lighter form: a default of "not written".) |
| Don't support direct serving | Operators who already do it would skip the declaration, leaving only the probe. |
| Encrypt history and audit | Losing the key loses history, dedupe breaks, and names, sizes and timestamps still leak. |
| An unguessable folder name | Hiding, not protection. |
| Turn audit off for all static targets | Static isn't public: the editing `local` target is static and holds most audit events. |

### Q4 — `isPublicSitePath`: which stored files visitors may receive

A path is private if any segment starts with `.`, **except a first segment of exactly `.well-known`** (ACME challenges, `security.txt`, app association files). Dot-prefixed segments below it stay private (`/.well-known/.env` is private). **Gazetta's manifest files are private too**, wherever they sit: `page.json` and `page.<anything>.json`, `fragment.json` and `fragment.<anything>.json`, `<name>.asset.json` and `<name>.asset.<anything>.json`. The suffix isn't checked against valid locales or selectors (the site loader accepts any suffix), so a stray `page.foo.bar.json` is private too. Targets hold them: the admin route copies page and fragment manifests (`publishItems`), the CLI does too once #1082 lands, and asset manifests travel with their bytes. Visitors never need them, and they carry fields that aren't for visitors: `reviewState`, `archived`, `aliasOf`, and on asset manifests `uploadedBy`, a person's identifier. These names are reserved: a site's `public/` folder can't publish a file with one of them. **Public targets don't receive manifests at all** (no page or fragment manifest copy, no asset manifests): a host serving the storage directly never consults `isPublicSitePath`, and nothing on a public target needs them. It keeps no history (so no undo), static pages already carry their asset URLs, and the live check plans from the published items. `isPublicSitePath` filters files that come from storage; a deploy adapter may add host marker files it creates itself (GitHub Pages' `.nojekyll`). One function, `isPublicSitePath(path)`, checked on the decoded, normalised path, used by static `gazetta serve` (cut 1), the worker and ESI `serve` (cut 7), the static deploy adapters, and the probe.

**Convention (locked):** every Gazetta-internal file is dot-prefixed, except the reserved manifest names above. Cut 3's registry test enforces it for `.gazetta/`; per-item sidecars already follow it.

**Per-item sidecars on a public target are accepted.** Publish writes `.{hash}.hash` and `.pub-{ts}` next to each published page, and on direct-served storage they're reachable as soon as they're written. They hold content hashes, publish times and noindex flags for pages that are already public, and incremental publish needs them. They're private to Gazetta's servers (Q4) but not treated as sensitive: the probe ignores them.

| Rejected | Why |
|---|---|
| An allowlist of public file kinds | Sites publish arbitrary files from `public/` (verification files, feeds); an allowlist breaks them and must change with every new output. |
| Hide `.gazetta/` only | Per-item sidecars (publish times, noindex flags) still leak, and any future internal file outside the folder. |
| Dot-prefixed paths only | Manifests aren't dot-prefixed: `page.json` and asset manifests (with `uploadedBy`) would be served. Renaming them to dot names would touch every reader and the on-disk format. |

### Q5 — `publicStorage` on the target implies the rest

```ts
targets: {
  production: {
    storage: s3Storage({ bucket: 'my-site' }),   // an S3 static website serves this bucket
    publicStorage: true,                         // default for cloud storage; shown for clarity
  },
  staging: {
    storage: r2Storage({ bucket: 'my-site-staging' }),
    publicStorage: false,                        // served only through a worker; keeps history
    deploy: cloudflareWorkersDeploy({ /* … */ }),
  },
}
```

The operator states one fact; Gazetta applies the consequences, and validation prints them. Contradictions are errors, not silent overrides.

**Sensitive state is denied by default.** On a public target, Gazetta writes under `.gazetta/` only to folders marked safe:

| Folder | On a public target |
|---|---|
| `history/` | Not written. Undo and rollback are unavailable for that target |
| `audit/` | Not written. Events are recorded elsewhere (below) |
| `review/` | Not written (a public target can't be editable, Q6) |
| `publish-requests/` (designed) | Recorded on the source, so approval works for a public production target |
| `scheduled/` (designed) | Not supported: scheduling against a public target is a validation error naming the copy-deploy setup |
| `fragment-deps/`, `asset-refs/`, `alias-targets/` | Not written until [#1077](https://github.com/gazetta-studio/gazetta-studio/issues/1077) is fixed: they're rebuilt from the whole source site, so they'd reveal **unpublished** page names. Written once #1077 lands, because they then describe only what the target holds; target removal's check needs them (`design-target-removal.md` Q12). The live-check planner falls back to the published items when a target has no indices |
| `live-check/` | Written. No personal data (live-check Q5); holds the probe result |
| Page, fragment and asset manifests (outside `.gazetta/`) | Not written |
| `comments/`, `notifications/` (designed) | Not written |
| `cache/`, `audit-index/`, `page-index/`, `built-config/` (designed) | Not written unless their design says otherwise |
| Any new folder | Not written until its entry in the registry (cut 3) says it's safe |

**Where audit events for a public target go,** in order: the publish's source, if private; otherwise the first private target in `site.config.ts` (usually `local`); otherwise an external audit sink (`design-audit.md` v2); otherwise nowhere, shown as info in `gazetta validate` and the capabilities view, and as a one-line warning in the output of any publish that actually dropped an audit event (a failure, not a setup note). In CI with a throwaway checkout, a durable record needs an external sink; that info shows in `gazetta validate` and at admin boot, not in `gazetta publish` output.

Hooks and plugins read the resolved value through `isPublicStorage(target)`. A plugin that writes its own `.gazetta/` state checks it first (docs rule; no runtime guard in v1).

| Rejected | Why |
|---|---|
| A flag plus manual switches (`history`, `audit`, review off) | Three or four fields and a puzzle for validation; needs a general per-target audit switch. |
| `servedFrom: 'storage' \| 'gazetta'` | Names the mechanism, not the risk. |
| An option on the storage factory (`r2Storage({ public: true })`) | Public access is often a host setting, not a storage property; spreads across four factories. |
| `state: 'full' \| 'none'` | Loses the reason, so new folders and messages can't follow it. |
| A preset helper | Sugar over one of the above; hides the settings. |

### Q6 — Defaults, visibility, and the lock

**Default:** a target is private by default only when its storage is `filesystemStorage` **and** it is an editing target (`editable` set to `true`), or when its deploy adapter declares that it copies site files to the host (the static adapters, Q2). Every other target, including any cloud storage and any filesystem target that only receives publishes, defaults to public until `publicStorage: false`. `environment` plays no part: it defaults to `'local'` when unset, so it can't show privacy. To tell storage types apart, the built-in storage factories carry a `kind` (`'filesystem'`, `'r2'`, `'s3'`, `'azure'`).

**Resolution order:** `publicStorage` resolves first; a public target then defaults to `editable: false`. So a cloud target with neither `environment` nor `editable` set is public and not editable, which is valid. Only an explicit `editable: true` together with public storage is an error. `gazetta init`, the starter and gazetta.studio write the value explicitly. A target left on the default gets one info line in `gazetta validate` and at admin boot: "`production`: storage assumed public, so history and audit aren't kept. Set `publicStorage: false` if visitors can't reach it."

**Validation errors:** `publicStorage` resolved true together with `history: { enabled: true }`, with an explicit `editable: true` (an editing target must keep its own history: "`production` is editable, so its storage must be private (`publicStorage: false`)"), with a schedule against it, or while sensitive state (history, audit, review) still exists in its storage: "`production` is public but still holds history; run `gazetta state remove production`."

**`gazetta state remove <target>`** deletes the sensitive folders (history, audit, review) from a target's storage, after a confirmation that names what goes. It's how an operator moves a target that kept state to public storage, and how a leak (below) is cleaned up.

**The capabilities view** is the one place to look, because this is a one-time setup decision: "About this target" in the admin's target menu (anyone who can see the target), and `gazetta targets` (also in `gazetta validate`). The History panel on a public target shows a short line linking to it; the boot info and audit notes point to it too.

**The lock.** When the probe (below) finds a **sensitive** file served (history, audit, review, or any folder the registry doesn't mark safe), publishing to that target stops. It's one rule for private and public targets. The lock lifts only when a probe passes. There is no override, in the admin or the CLI. The way out is to fix the host, or to declare `publicStorage: true` **and** run `gazetta state remove`; declaring public alone doesn't lift it while sensitive files are still there (validation errors too). Other targets and saves are unaffected. Every publish path checks the lock **before its first write**: the admin route records history before calling `publishRun` today, so the check can't live only in `publishRun`. A publish already running when a lock lands finishes; the next is blocked (accepted limitation). No new audit event: each run already records a `live-check` event.

**The probe** runs whenever a target has a `siteUrl`, **whatever `liveCheck` says**, at most once an hour per target (Re-check always runs it). For each sensitive folder present in storage, it picks one existing file, requests it from `siteUrl` and from every URL in `liveCheck.storageUrls` (optional extra public endpoints, such as an R2 `r2.dev` URL), and compares the body with the stored bytes. Any match is a leak; a `200` fallback page doesn't match and doesn't lock. Safe folders and per-item sidecars are never probed. No sensitive file in storage: `not-checked`. Gazetta can't discover an `r2.dev` URL itself, so the docs tell operators to list it or turn it off.

The result is written into the run's report **as soon as it's known**, not when the run completes, so a crash can't lose a detected leak. The lock reads the newest probe result by probe time, whether its run completed or not, so slow or out-of-order runs can't overrule a newer result. Nothing caches the lock; only the once-an-hour throttle is cached.

| Rejected | Why |
|---|---|
| Private by default (Q2 as first drafted) | A forgotten declaration leaks; only the probe catches it, afterwards. |
| Public by default everywhere | Local targets lose undo unless every project's config says otherwise. |
| Default based on `environment` alone | Unset `environment` is `local`, so a cloud bucket would be assumed private. |
| Auto-protect instead of locking (stop writing state, keep publishing) | Easy to ignore: the leak and a history gap can go on for weeks. |
| Lock with an override for urgent publishes | The way out should be a reviewed config decision, not a button. |
| Declaring public lifts the lock by itself | Old history and audit stay downloadable. |
| The probe as part of the live check only | `liveCheck: false` would turn leak detection off. |
| Probing one sample file | A blocked sample can hide other served folders. |
| Lock state cached per instance | Another instance could keep publishing for up to an hour after a leak is found. |
| Default private for any filesystem target | A publish-only folder may be served by nginx. |
| Lock every target | Punishes all targets for one host's setup. |
| A banner on every public target; a confirmation on every publish | Noise for a deliberate, valid setup (rule 23). |

### Q7 — Enforcement: config gates plus a folder registry

The existing gates read `isPublicStorage`: `isHistoryEnabled(target)` is false for a public target, audit resolves to the fallback order (Q5), review and publish requests to the source, and schedule validation rejects public targets. An integration test runs every path that writes to a target against a public target in memory storage and fails if anything under `.gazetta/` outside the safe folders is written: CLI `gazetta publish`, the admin publish route and its stream, `gazetta deploy`, the live check (reports only), and undo/restore (refused with the "history off" answer).

The **state folder registry** is the only way to build these paths: `stateFolderPath(folder, …)`, where `folder` is a key of the registry, so TypeScript rejects an unregistered folder (including names passed as variables, such as `DepRelation.rootName`). Each entry says whether the folder is safe on public targets. A scan test fails on a `.gazetta` string literal outside the registry file. This is the kind of source check rule 41 keeps: adding a state folder is normal feature work.

| Rejected | Why |
|---|---|
| A storage wrapper rejecting writes at runtime | Guards mostly against code that doesn't exist yet; one more layer. Becomes worth it with the first plugin that writes `.gazetta/` state (Future directions). |
| A check in each writer only | Every new writer must remember; one that forgets leaks. |
| Docs only | Nothing enforces it. |
| A check in `ContentRoot.path()` | History and audit build their own paths and would bypass it. |
| A registry test that scans source for folder names | Misses names built at runtime; the typed helper covers them. |

### Q8 — Cut sequence

See "Cut sequence" below.

## UX check

Rule 23: a valid public target looks quiet; errors appear only for real problems; the setup is explained in one place.

### Capabilities view (cut 5)

Root `data-testid="target-capabilities"`; one row per capability, `data-testid="target-capability-{key}"`.

| Key | Values (copy) |
|---|---|
| `storage` | "Public (assumed)" · "Public (declared)" · "Private (declared)" · "Private (editing folder)" · "Private (copied to the host by `<adapter>`)" |
| `history` | "On" · "Off: storage is public" · "Off: turned off in config" |
| `audit` | "Kept here" · "Kept on `local`" · "Sent to `<sink>`" · "Not kept for this target's publishes" |
| `review` | "Available" · "Not available: storage is public" |
| `scheduling` | "Available" · "Not available: storage is public" |
| `redirects`, `gone` | "Yes" · "No" (from the runtime capability matrix) |
| `live-check` | "On, last result: …" · "Off: no `siteUrl`" · "Off in config" |
| `lock` | absent when not locked · "Publishing paused: Gazetta's private files are reachable (checked <time>)", with Re-check (`target-capability-recheck`) |
| `indices` | "Kept" · "Not kept: storage is public" |
| `deploy` | adapter name · "None" |

### History panel on a public target (cut 5)

`data-testid="history-public-storage"`: "This target doesn't keep history because its storage is public. To roll back, restore the page on `local` and publish it again." with a link to the capabilities view.

### Locked target (cut 6)

Publish panel, `data-testid="publish-locked"`: "Publishing to `production` is paused: its site serves Gazetta's private files. Tell your site operator." Re-check for people with the target's publish capability; no other button. Site health shows the same error. CLI: `gazetta publish production` exits non-zero with the same message.

## Foundational checks

- **Multi-instance:** the setting is config; the lock comes from the latest complete report on the target, which every instance reads. Per-instance cache of the probe result, at most an hour, cleared by Re-check.
- **Scale:** every primitive is constant per request or write; the probe is one listing, one request and one read; the lock check reads one report from a folder bounded by retention. No new sidecar.
- **Locale / Themes:** none.
- **Auth + RBAC:** the capabilities view needs read access to the target; Re-check needs its publish capability (live check). No override, so no new capability.
- **Audit:** events for public targets follow the fallback order (Q5); no new event types.
- **Review:** publish requests and approvals for a public target live on the source.
- **Hooks:** `isPublicStorage(target)` in hook context.
- **Render:** none; serving changes only which stored files are sent (`isPublicSitePath`).
- **Validation:** new errors (contradictions) and info (defaulted public, audit sink); the probe result surfaces in Site health.
- **Plugin:** docs rule to check `isPublicStorage` before writing `.gazetta/` state; runtime guard deferred.
- **Cache:** none beyond the probe result.
- **Offline:** none; the probe needs the network like the live check.
- **Collaboration:** comments and notifications are never written to a public target.

**Non-foundational discipline added** (cut 8, `feature-design-process.md`): anything written under a target's `.gazetta/` declares, through the folder registry, whether it's safe on a public target; the default is no.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `isPublicSitePath` with the `/.well-known/` exception, used by static `gazetta serve` ([#1071](https://github.com/gazetta-studio/gazetta-studio/issues/1071)) | — | unit + api | Low |
| 2 | `publicStorage` and `isPublicStorage(target)` with the default rule and resolution order; storage `kind` on the built-in factories; copy adapters' declaration; validation errors (history on, explicit `editable`, schedules, sensitive state present) and info (defaulted public, audit sink); `gazetta state remove`; explicit values on the starter's and gazetta.studio's targets in the same PR; `gazetta init` writes them | — | unit-first | Medium |
| 3 | State folder registry, `stateFolderPath`, every `.gazetta/` path builder moved to it, safe/not-safe per folder, the scan test | — | unit (structural) | Medium |
| 4 | Gates: history, audit, review and, until #1077 lands, the dependency indices follow `isPublicStorage`; audit fallback order and the dropped-event warning; publish requests on the source; the live-check planner without indices; the write-path integration test | 2, 3 | api-first | Medium-high |
| 5 | Capabilities view: `TargetInfo` capabilities, `gazetta targets`, "About this target", the History panel line; Storybook stories from the UX table | 2, 4 | api + component | Medium |
| 6 | Probe and lock: one byte-exact probe per sensitive folder present, on `siteUrl` and `liveCheck.storageUrls`, independent of `liveCheck: false`, hourly with Re-check forcing it; result written into the report as soon as known; lock from the newest probe result; lock check before the first write in every publish path; publish-panel copy and CLI error | 2, 3, live-check cuts 2 and 5 ([#1081](https://github.com/gazetta-studio/gazetta-studio/issues/1081)) | integration + component | Medium-high |
| 7 | Worker and ESI `gazetta serve` use `isPublicSitePath` (sidecars stop being served) | 1 | unit + api | Low |
| 8 | Docs (`audit.md`, `self-hosted.md`, `deploy.md`, `runtime-capabilities.md`), **Public storage** in `CONTEXT.md`, the discipline line in `feature-design-process.md`, ADR-0017 | 2 | docs | Low |

Cuts 2 and 3 run in parallel; 7 any time after 1. The static deploy adapters (#208, #209, #211) take "upload only paths where `isPublicSitePath` is true" as part of their contract, not as a cut here.

## Migration

No production users, so changes are hard cutovers (ADR-0005, ADR-0008 precedent). After cut 2, cloud targets without `publicStorage: false` stop keeping history and audit; the starter and gazetta.studio set it in the same PR. A target moved to public storage that still holds history or audit fails validation until `gazetta state remove` runs.

## Open questions

1. **Where audit events for a publish are written today** (source, destination, or both). Cut 4 checks before implementing the fallback order.
2. ~~**Whether gazetta.studio's R2 bucket has public access.**~~ **Resolved 2026-10-21:** `wrangler r2 bucket dev-url get gazetta-studio-site` reports public `r2.dev` access disabled, and no custom domain is connected; its site domain returns 404 for `/.gazetta/…`. Its production target should declare `publicStorage: false`.
3. **The worker and ESI `serve` serving sidecars** is from reading code; cut 7 confirms with a test.
4. **Which public endpoints a storage type can have** beyond `siteUrl` (R2 `r2.dev`, S3 website endpoints, Azure static website URLs). `liveCheck.storageUrls` relies on the operator listing them; whether Gazetta can derive any of them is for cut 6.

## Future directions

- **A runtime storage guard** that rejects writes outside safe folders, once a plugin writes its own `.gazetta/` state.
- **Separate private storage for a target's state,** if operators of direct-served storage ask for undo there.
- **Probe without a live check** (e.g. at `gazetta validate --probe`), if operators want it before the first publish.

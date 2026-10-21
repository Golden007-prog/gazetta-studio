# Audit log

Gazetta records every save, publish, delete, and history-restore as a structured audit event. The events live with each target's content under `.gazetta/audit/`, queryable through the admin's audit drawer (top-bar active-target menu → "View audit log") and through `GET /api/audit`.

Audit is **on by default**. Zero config: every Gazetta admin process records to a per-instance JSONL file; the admin drawer reads from it. Operators add config when they want pseudonymization, source-IP recording, retention windows, or external sinks (when those ship).

## What gets recorded

Each event captures **what happened** + **who did it** + **what they touched**:

```jsonc
{
  "timestamp": "2026-05-04T14:23:05.000Z",
  "actor": {
    "id": "alice@example.com",
    "email": "alice@example.com",
    "role": "editor",
    "trustMode": "cloudflare-access"
  },
  "action": "save",
  "outcome": "success",
  "scope": { "kind": "page", "name": "home" },
  "metadata": {
    /* optional, action-specific extras */
  }
}
```

Recorded actions:

| Action            | When                                                           |
| ----------------- | -------------------------------------------------------------- |
| `save`            | A page or fragment manifest is written                         |
| `publish`         | Content is published to a target                               |
| `delete`          | A page, fragment, or asset is deleted                          |
| `restore`         | A history undo or arbitrary rollback executes                  |
| `configure-roles` | Reserved for role-mapping changes (lands when reviews ship)    |

Recorded outcomes:

| Outcome             | Meaning                                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| `success`           | The action completed                                                              |
| `validation-failed` | Save rejected because validators flagged blocking issues                          |
| `forbidden`         | Capability check denied the request (the route fired before the handler ran)     |
| `unauthenticated`   | Upstream auth produced no principal; request rejected                             |

Outcome is required on every event. Failure outcomes (`validation-failed`, `forbidden`, `unauthenticated`) record what the user **tried** to do — useful for forensics ("which editor tried to publish to prod last Friday?").

## Where events live

Per-target, under `.gazetta/audit/`:

```text
target-root/
├── pages/
├── fragments/
└── .gazetta/
    ├── history/
    └── audit/
        ├── events-pod-abc-123.jsonl    # one file per admin instance
        └── events-pod-def-456.jsonl
```

One JSONL file **per admin instance** (Cloud Run revision id, Kubernetes pod name, or `os.hostname()` fallback). Multiple admin instances writing concurrently never collide because each owns its own file. The `GET /api/audit` route aggregates across files.

The `.gazetta/audit/` directory is gitignored — audit events are runtime state, not source.

## Where Gazetta keeps its own files, and when they're public

Every target keeps Gazetta's own files in a `.gazetta/` folder in its storage, next to the published pages:

| Folder | What's in it | Why it matters |
|---|---|---|
| `.gazetta/audit/` | Who saved, published, deleted or restored what, and when | Actor IDs and email addresses, unless `actorPseudonym: 'sha256'` is set |
| `.gazetta/history/` | Every past version of every page and fragment, for undo and rollback | Includes content you later removed or never meant to publish |
| `.gazetta/fragment-deps/`, `.gazetta/asset-refs/` | Which pages use which fragments and assets | The site's structure; low risk |

Visitors never need these files. Whether they *can* get them depends on how the target's storage reaches the web.

### Safe: Gazetta serves the site

These read only pages, fragments, `sitemap.xml` and `robots.txt` from storage, so a request for `/.gazetta/…` gets a 404:

- The Cloudflare worker (`cloudflareWorkersDeploy()`, see [`cloudflare.md`](cloudflare.md)), as long as the R2 bucket itself is private. If you turn on public access for the bucket (an `r2.dev` URL or a custom domain connected to the bucket), every object in it is served directly, without the worker, `.gazetta/` included.
- `gazetta serve` on an ESI target (`type: 'dynamic'`)
- A filesystem target that only `gazetta serve` or `gazetta dev` reads and that is never uploaded anywhere

### Not safe: the storage is the public site

If the web server or host serves the storage folder or bucket directly, `.gazetta/` is downloadable like any other file, for example `https://your-site/.gazetta/audit/events-….jsonl`. This happens when:

- An S3 or Azure Blob static website points at the target's bucket or container
- The target's R2 bucket has public access turned on, even when a worker also serves the site
- A filesystem target's folder (such as `./dist/production`) is uploaded as-is to a static host, or served by nginx, Caddy or Apache
- **`gazetta serve` on a static target (`type: 'static'`)**: it currently returns any file in storage, `.gazetta/` included. Fix tracked in [#1071](https://github.com/gazetta-studio/gazetta-studio/issues/1071); until it lands, put it behind a proxy rule like the one below.

### What to do if your storage is public

Pick one, in this order of preference:

1. **Block `/.gazetta/` at the host.** Return 404 for any path starting with `/.gazetta/`, using your host's access rules (bucket policy, CDN rule, or web-server config). In nginx:

   ```nginx
   location ^~ /.gazetta/ {
       return 404;
   }
   ```

   Then check it by requesting a file, not the folder, since some hosts refuse a folder but serve the files in it. `.gazetta/history/index.json` exists on every target with history on (the default) once something has been saved or published to it. Run it against every public URL the storage has, such as your site and an `r2.dev` URL:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://your-site/.gazetta/history/index.json
   ```

   Anything but `200` means it's blocked. If you get `200`, look at what came back, since some hosts answer every missing path with their home or 404 page and status `200`:

   ```bash
   curl -s https://your-site/.gazetta/history/index.json | head -c 200
   ```

   JSON with `nextId` and `revisions` means the file is public. An HTML page means it isn't. To also check the audit log, do the same with one of the `events-*.jsonl` file names you see in your storage.

2. **Don't upload it.** When you copy a filesystem target to a static host yourself, leave the folder out, for example `rsync -a --exclude '.gazetta/' ./dist/production/ host:/var/www/site/`. Gazetta still has its copy in the target folder, so undo and the audit log keep working.

3. **At least pseudonymise the audit log.** `actorPseudonym: 'sha256'` replaces actor IDs with salted hashes and drops email addresses (see [Pseudonymization](#pseudonymization)). This does **not** protect history: past versions of your pages are still readable. Only use it on its own if that's acceptable. To turn history off for a target instead, set `history: { enabled: false }`; that also removes undo and rollback there.

Gazetta's planned static-host deploy adapters (GitHub Pages [#208](https://github.com/gazetta-studio/gazetta-studio/issues/208), Netlify [#209](https://github.com/gazetta-studio/gazetta-studio/issues/209), S3 [#211](https://github.com/gazetta-studio/gazetta-studio/issues/211)) will leave `.gazetta/` out of what they upload ([#1070](https://github.com/gazetta-studio/gazetta-studio/issues/1070)).

## Configuration

```ts
import { defineSite } from 'gazetta'

export default defineSite({
  // ...
  admin: {
    audit: {
      provider: 'history',        // v1 only option (default; can omit)
      strict: false,              // default — fail-open
      actorPseudonym: 'none',     // 'none' | 'sha256'
      recordSourceIp: 'none',     // 'none' | 'raw' | 'hashed' | 'truncated'
      recordUserAgent: 'none',    // 'none' | 'raw' | 'truncated'
      retention: {
        events: 10000,            // optional; max event count
        maxAgeMonths: 12,         // optional; null or unset = no time limit
      },
    },
  },
})
```

All fields are optional. Defaults: zero-config audit (history provider, no pseudonymization, no IP/UA recording, no retention).

### Privacy posture

`recordSourceIp` and `recordUserAgent` default to **off**. Operators opt in per their compliance posture and consent rules.

| `recordSourceIp` | What's stored                                                              |
| ---------------- | -------------------------------------------------------------------------- |
| `none` (default) | Nothing                                                                    |
| `raw`            | Full client IP — GDPR-personal-data; operator declares processing          |
| `hashed`         | `sha256(ip + GAZETTA_AUDIT_SOURCEIP_SALT).slice(0, 16)` — pseudonymized    |
| `truncated`      | `/24` prefix (IPv4) or `/48` prefix (IPv6) — geographic forensics only     |

`hashed` mode requires the `GAZETTA_AUDIT_SOURCEIP_SALT` environment variable. Rotating the salt breaks correlation by design — document rotation dates so forensic queries can scope by salt-era.

| `recordUserAgent` | What's stored                                                              |
| ----------------- | -------------------------------------------------------------------------- |
| `none` (default)  | Nothing                                                                    |
| `raw`             | Full UA string                                                             |
| `truncated`       | Browser family + major version (e.g., `Chrome/119`); fingerprinting detail dropped |

### Trust-mode-driven source IP extraction

When `recordSourceIp` is enabled, Gazetta extracts the client IP using the auth trust mode's correct source — never naively reading the leftmost `X-Forwarded-For` entry (which is a documented OWASP misconfiguration class).

| Trust mode          | Source                                                                          |
| ------------------- | ------------------------------------------------------------------------------- |
| `none`              | TCP peer (no proxy assumed)                                                     |
| `forwarded-user`    | `X-Forwarded-For` with operator-configured `trustedProxyCount` (counted from rightmost) |
| `cloudflare-access` | `Cf-Connecting-IP` (Cloudflare-signed)                                          |
| `azure-easy-auth`   | `X-Forwarded-For`, `trustedProxyCount: 1` (Azure App Service appends one entry) |
| `aws-cognito`       | `X-Forwarded-For`, `trustedProxyCount: 1` (ALB appends one entry)               |
| `tailscale`         | TCP peer (Tailscale serves direct)                                              |

When the configured header is missing (proxy misconfiguration), `sourceIp` is omitted from the event entirely — explicitly absent is more honest than `'[unparseable]'`.

### Pseudonymization

`actorPseudonym: 'sha256'` replaces `actor.id` with a salted hash:

```text
actor.id  =  sha256(upstream-sub + GAZETTA_AUDIT_ACTOR_SALT).slice(0, 16)
```

When pseudonymization is on, `actor.email` is also redacted (low-entropy emails give weak pseudonymization; we drop them).

When to opt in:

- External-sink configurations where audit events leave Gazetta's process boundary (compliance contexts where the sink might be compromised)
- Regulated contexts demanding pseudonymization-by-default
- Multi-tenant SIEM correlation where you want shared hashes across systems (use a shared salt) without sharing raw subjects

The salt is a credential. Store it in `GAZETTA_AUDIT_ACTOR_SALT` env var; never in `site.config.ts`. 16+ random bytes. Document the creation date as part of operational records.

Salt rotation breaks historic correlation by design — rotate per security policy (annually is typical).

## Retention

Audit retention is configurable independently from history retention because compliance regimes specify retention windows that don't match content history budgets:

```ts
retention: {
  events: 10000,        // max events kept; oldest evicted when exceeded
  maxAgeMonths: 72,     // 6 years for HIPAA; null = no time limit
}
```

Set one or both:

| Configuration                            | Behavior                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Neither set                              | Audit accumulates indefinitely (operator's choice)                      |
| `events` only                            | Hard cap on count; oldest evicted globally across instance files        |
| `maxAgeMonths` only                      | Rolling cutoff; events older than N months evicted                      |
| Both                                     | Age cutoff first, then count cap on the survivors                       |

The pruner runs at admin boot + every 6 hours. Background work; never blocks operations. Pruner failures fail-open — audit just accumulates until the next successful run.

Multi-instance correctness: per-instance files (`events-pod-A.jsonl`, `events-pod-B.jsonl`) prune independently with no coordination. The `events` cap is global across all files (oldest events anywhere lose).

## Strict mode (compliance contexts)

Default is **fail-open**: audit failures never block writes. Per [Universal Provider Requirement #5](.claude/rules/design-plugins.md). Operator's monitoring catches the failure via structured logs.

For HIPAA / SOC 2 contexts where "audit recording confirmed successful" is a hard prerequisite for the write to proceed:

```ts
admin: {
  audit: {
    provider: 'history',
    strict: true,   // any provider failure blocks the write
  },
}
```

Strict mode trades availability for compliance. A storage outage that would otherwise lose an audit record now also blocks the user's save until the issue resolves. Use it only when your compliance posture requires it.

## Reading the audit log

### Admin drawer

Open the top-bar active-target menu → "View audit log". The drawer shows:

- Filter controls (action / outcome / scope kind / actor)
- Inline events list (newest first)
- Outcome badges (success / warn / error)
- Per-event metadata (target name, restored revision id, etc.)

When the configured providers include both queryable (`history`) and external sinks (when those ship), the drawer composes both:

| Configuration                     | Drawer state                                                  |
| --------------------------------- | ------------------------------------------------------------- |
| `history` only                    | Inline events list                                            |
| `history` + external sink with link | Inline events + footer link "Also in: cloudwatch"           |
| External sink only, with link     | "Audit lives in cloudwatch — [link]" (no inline list)         |
| External sink only, no link       | "Configure history as a peer provider for in-admin browsing"  |

### `GET /api/audit`

Programmatic access. Same filter shape as the drawer:

```text
GET /api/audit?action=save&outcome=success&scopeKind=page&scopeName=home&actor=alice&since=2026-05-01T00:00:00Z&until=2026-05-31T23:59:59Z&limit=100
```

Response:

```jsonc
{
  "events": [
    {
      "timestamp": "...",
      "actor": { "id": "...", "role": "editor", "trustMode": "..." },
      "action": "save",
      "outcome": "success",
      "scope": { "kind": "page", "name": "home" }
    }
    // ...
  ],
  "externalSinks": [
    /* { name, url|null } per non-queryable provider */
  ]
}
```

Default limit 100, max 1000. Newest events first.

## Capability gating

`GET /api/audit` requires the `read:audit-log` capability. **Built-in role assignments**:

| Role     | Has `read:audit-log`?     |
| -------- | -------------------------- |
| `admin`  | Yes (via root wildcard `*`) |
| `editor` | **No** (`read:*` is wildcard-exempt for audit) |
| `viewer` | **No** (`read:*` is wildcard-exempt for audit) |

This matches the design's "viewers don't see audit by default" rule. Operators wanting non-admin audit access declare a custom role with the explicit grant:

```ts
admin: {
  auth: {
    trust: 'cloudflare-access',
    // ...
    roles: {
      auditor: ['read:*', 'read:audit-log'],
    },
    map: {
      'gazetta-auditors': 'auditor',
    },
  },
}
```

Custom role members in the upstream group `gazetta-auditors` get full read access including audit; without `read:audit-log` in their role's capability list, the drawer's API call returns 403.

## Recommended deployment patterns

### Single-server admin (default)

Out of the box. `history` provider, zero config, retention to taste.

```ts
admin: {
  audit: {
    retention: { events: 10000 },
  },
}
```

### Multi-instance (Cloud Run / Kubernetes)

Per-instance JSONL files mean concurrent appenders never race. No coordination needed. Set the `K_REVISION` env (Cloud Run does this automatically) or rely on `os.hostname()` (Kubernetes) for instance identity.

### Compliance: history + future external sink

When external-sink providers ship (v2 — `HttpWebhookAuditProvider`, `FileAuditProvider`, `CloudWatchAuditProvider`, etc.), the recommended pattern is to run `history` AND your external sink as peers:

```ts
admin: {
  audit: {
    providers: [
      'history',     // local copy; queryable via admin drawer
      'cloudwatch',  // tamper-evident retention; SOC 2 / HIPAA satisfaction
    ],
    strict: false,   // or true for "audit confirmed before write proceeds"
  },
}
```

Best of both: in-admin browsability + external compliance posture. Until v2, run `history` and use your platform's storage backup for the `.gazetta/audit/` directory.

## What audit doesn't cover

Out of scope for v1:

- **Read events** (every API GET) — compliance-tier; deferred until SOC 2 / HIPAA demand
- **Hook firings** — lands when the hooks foundation ships
- **External sink providers** (CloudWatch, Azure Monitor, syslog, OpenTelemetry, HTTP webhook, file) — v2 demand-driven
- **Index sidecars** for sub-second queries at very large scale (>100K events) — kicks in when query latency p95 crosses 2 seconds
- **`gazetta audit query` CLI** — lands with the validation Cut 5 CLI rewrite
- **Right-to-be-forgotten scrub CLI** — same trigger

## Tampering

Audit log lives in target's writable storage; an admin with write access to the target storage can edit revisions. v1 accepts this; external-sink providers (v2) are the upgrade path for high-stakes operators who need tamper-evident logs.

## Reference

- [`design-audit.md`](../.claude/rules/design-audit.md) — full design pass
- [`design-auth-rbac.md`](../.claude/rules/design-auth-rbac.md) — capability vocabulary + Principal type
- [`design-plugins.md`](../.claude/rules/design-plugins.md) — Universal Provider Requirements

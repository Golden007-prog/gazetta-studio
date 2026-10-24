---
paths:
  - "packages/gazetta/src/history-recorder.ts"
  - "packages/gazetta/src/history.ts"
  - "packages/gazetta/src/admin-api/**"
  - "**/audit*"
---

# Audit log

Foundational dimension #5 of 13. Pluggable audit-event recording with multiple provider implementations (history-extended at v1; external sinks reserved). Composes with auth/RBAC's `Principal` for actor identity and with the real-time event-source discipline (audit log = source of real-time events for presence + live publish status).

**Status**: design pass complete (2026-05); implementation shipped 2026-05 (Cuts 1–10, [`design-audit-implementation.md`](design-audit-implementation.md)). Denied write requests (the capability middleware's 401 and 403, and the production publish gate's 403) are recorded since [#1256](https://github.com/gazetta-studio/gazetta-studio/pull/1256) ([#1192](https://github.com/gazetta-studio/gazetta-studio/issues/1192)). The 401s returned before a route is matched aren't recorded: the `GAZETTA_TOKEN` guard's, and the principal middleware's when the identity provider rejects a request (invalid credentials, an untrusted proxy, no matching role); [#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262) records those on write requests to `/api/*` as `sign-in` events. External audit sinks are demand-driven.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Audit check** every new feature design must answer
- [`design-auth-rbac.md`](design-auth-rbac.md) — auth/RBAC primitives expose the `Principal` to handlers; audit records actions taken with it
- [`design-publishing.md`](design-publishing.md) — history-recorder is the existing primitive that audit extends
- [`design-plugins.md`](design-plugins.md) — Universal Provider requirements apply to `AuditProvider`
- [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md) — pluggable provider pattern

## Why this is foundational

Every write event (save, publish, delete, restore) needs to be recorded with an actor identity, a timestamp, and a target scope. Audit log is the durable record that:
- Compliance auditors trace
- Real-time presence + publish-status observe (per the real-time event-source discipline)
- Forensic incident response queries

Adding audit later means auditing every save/publish/delete consumer and adding actor-recording infrastructure. Joint design with auth/RBAC because audit records actor identity (which RBAC owns) and actions taken (which the capability vocabulary defines).

## Locked invariants (already decided)

- **`AuditProvider` is Extension Surface #11.** Per [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md). Universal Provider requirements per [`design-plugins.md`](design-plugins.md) "Universal Provider requirements."
- **history-recorder is the foundation for audit log.** `recordWrite()` already runs on every save and publish ([packages/gazetta/src/history-recorder.ts](../../packages/gazetta/src/history-recorder.ts)). The audit log adds an `actor` field; doesn't replace the existing primitive.
- **Audit log is the source of real-time events.** Per the real-time event-source discipline in `feature-design-process.md`, save/publish handlers record to audit log; real-time push (presence, live publish status) observes audit log. Not bolted into save/publish handlers directly. Real-time consumers filter by `outcome === 'success'` when they only want state changes.
- **Audit and history are conceptually peer surfaces.** v1 ships them unified in `HistoryAuditProvider` (writes a revision on success; writes an audit event on every outcome). v2 separates them — operators wanting "audit to CloudWatch but history stays local" get a clean split. The `AuditProvider` interface is independent of `HistoryProvider`; `HistoryAuditProvider` implements both because they share storage in v1.
- **Outcome is required on every event.** No implicit "default to success" — recording sites supply outcome explicitly. Cuts a class of "I forgot to record the failure" bugs.
- **Actor is a snapshot, not a live reference.** The recorded `actor.role` reflects the role at decision time. Subsequent role changes don't rewrite history. Capabilities are NOT embedded per event — they derive from role + the site.config.ts revision active at the event's timestamp (recoverable via history). Group claims are NOT embedded — privacy isolation; correlate with upstream auth logs when needed.

## Surface-specific contract

```ts
export interface AuditProvider {
  readonly name: string
  /** Record an audit event. MUST NOT throw on transport errors;
   *  fall back to local recording on failure. Audit failures never block writes
   *  (fail-open default; strict mode opt-in via admin.audit.strict: true). */
  record(event: AuditEvent): Promise<void>
  /** Optional — providers that own queryable storage implement this.
   *  External-sink providers that push events elsewhere omit it. */
  query?(filter: AuditQuery): Promise<AuditEvent[]>
  /** Optional — providers that push to an external destination return
   *  a deep-link to the operator's destination console.
   *  Returning null means "configured but no link available."
   *  Providers that own queryable storage typically omit this. */
  queryUrl?(): string | null
}
```

**Event shape:**

```ts
export interface AuditEvent {
  /** ISO 8601 with Z suffix; matches existing history-recorder convention. */
  timestamp: string
  /** Snapshot of the principal at decision time — not a live reference.
   *  Roles change; events preserve what was authorized when the action ran. */
  actor: {
    /** Upstream stable subject (OIDC `sub`, OAuth subject, Cloudflare Access
     *  identity_nonce, etc.) — NOT email. Email rotates; sub is stable.
     *  When `admin.audit.actorPseudonym: 'sha256'` is configured, this field
     *  is `sha256(sub + GAZETTA_AUDIT_ACTOR_SALT).slice(0, 16)`.
     *  'unknown' for pre-RBAC revisions or trust:none deployments. */
    id: string
    /** Optional human-readable. Only when the auth provider exposes it.
     *  Redacted to undefined when pseudonymization is enabled
     *  (low-entropy email gives weak pseudonymization; we drop it). */
    email?: string
    /** Resolved Gazetta role at decision time. Snapshot, not a live reference. */
    role: string
    /** Trust mode that produced this principal:
     *  'none' | 'forwarded-user' | 'cloudflare-access' | 'azure-easy-auth' |
     *  'aws-cognito' | 'tailscale' | future plugin-supplied modes. */
    trustMode: string
  }
  /** Narrowed enum; configure-roles records role-mapping changes
   *  in site.config.ts as a special "configuration write"; sign-in
   *  records a write request refused before a route is matched. */
  action: 'save' | 'publish' | 'delete' | 'restore' | 'configure-roles' | 'sign-in'
  /** Required. Each recording site supplies its own outcome explicitly —
   *  no implicit default. Closed enum; future ambient-log additions
   *  ('rate-limited', 'session-expired') stay closed-enum. */
  outcome: 'success' | 'forbidden' | 'validation-failed' | 'unauthenticated'
  /** What was acted on. */
  scope: { kind: 'page' | 'fragment' | 'asset' | 'site'; name?: string }
  /** Optional, instance-configurable per privacy / GDPR. Default off. */
  sourceIp?: string
  /** Optional, instance-configurable. Default off. */
  userAgent?: string
  /** Provider-specific extras (publish source target, restore revision id,
   *  missingCapabilities for forbidden outcomes, etc.) */
  metadata?: Record<string, unknown>
}

export interface AuditQuery {
  /** Match against actor.id (most common) or actor.email. */
  actor?: string
  action?: AuditEvent['action']
  outcome?: AuditEvent['outcome']
  scope?: { kind?: AuditEvent['scope']['kind']; name?: string }
  since?: string  // ISO timestamp
  until?: string
  limit?: number
}
```

## Providers

**v1 in-tree:**

- **`HistoryAuditProvider`** — extends existing `Revision` (in `packages/gazetta/src/history.ts`) with audit fields. Audit IS extended history.
  - Per-revision granularity (`rev-{ts}.json`); existing pattern for multi-instance correctness.
  - Pre-RBAC revisions read with synthetic `actor: { id: 'unknown', role: 'unknown', trustMode: 'none' }` (computed on read, not persisted).
  - Retention is configurable independently from history retention (see "Retention" section below).
  - Revisions split by category for retention purposes: content-bearing revisions (success outcomes) vs audit-only revisions (failure outcomes have no content snapshot).

**v2 reserved (deferred, demand-driven). Expected order — demand can reorder:**

| Rank | Provider | Why this order |
|---|---|---|
| **1** | **`HttpWebhookAuditProvider`** — POST events to operator URL with `Authorization` header (env-var-supplied) | Universal — one provider serves dozens of downstream sinks (Datadog Logs, Splunk HEC, Loki, custom SIEMs). Smallest contract surface; smallest implementation cost. Stress-tests fail-open semantics first (operator URL flapping more common than managed-platform outages). |
| **2** | **`FileAuditProvider`** — `.gazetta/audit/{date}/events.jsonl` append-only; rotation via daily timestamp partition | Self-hosted operators with rsyslog / Promtail / Fluent Bit / Vector pulling from a file. Common deployment shape. Multi-instance: filesystem POSIX `O_APPEND` for small writes; R2/S3/Azure use per-instance file (`events.{instance-id}.jsonl`) — no contention. |
| **3** | **`OpenTelemetryAuditProvider`** — emits to any OTel collector | Modern observability standard; one provider serves Datadog, New Relic, Honeycomb, Grafana Cloud, AWS, Azure, GCP — all consume OTel. Reduces in-tree provider proliferation. |
| **4** | **`CloudWatchAuditProvider`** — emits to AWS CloudWatch Logs | AWS-specific; specific operator demand likely from regulated AWS customers. |
| **5** | **`AzureMonitorAuditProvider`** — emits to Azure Monitor Logs | Azure-specific; same shape as CloudWatch. |
| **6** | **`SyslogAuditProvider`** — emits to syslog (RFC 5424) | Niche — classic syslog infra. UDP-default is a security antipattern for compliance contexts (operators needing compliance use TLS-syslog). Lowest priority. |

External-sink Providers don't replace history. Operator can run `HistoryAuditProvider` as a peer for local browsable audit + external sink for tamper-evident retention.

**Plugin promotion trigger** (matching auth identity): 3+ operator requests for an unlisted provider within 6 months → either add in-tree (if mainstream) OR promote to plugin (if long-tail). Same trigger applies per-provider in the expected order; demand can reorder.

**HttpWebhookAuditProvider sub-shape** (first to ship):
- `POST {url}` with body = `AuditEvent` JSON
- Retry: 3 attempts with exponential backoff, then fail-open (logged as `transport` failure category)
- Auth: `Authorization` header from `GAZETTA_AUDIT_WEBHOOK_AUTH` env var
- HTTPS required in non-dev mode (refuses `http://` per existing pattern in `design-media.md`)
- `queryUrl()` returns null (operator's destination is opaque to Gazetta)

## Recording timing — synchronous fail-open

**Locked: synchronous, fail-open, parallel fan-out across providers.**

```ts
async function recordToAll(event: AuditEvent, providers: AuditProvider[]) {
  const results = await Promise.allSettled(
    providers.map(p => p.record(event))
  )
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      // structured log; never propagates to caller; never includes event payload
      logAuditFailure(providers[i].name, event.id, categorize(r.reason))
    }
  }
  // never throws — fail-open per Universal Provider Requirement #5
}
```

**Why synchronous (not fire-and-forget):**
- **Attempt-completion guarantee**: if the user got a success response, the audit attempt was completed (success or fail-open logged). Async queuing would lose in-flight events on process restart.
- **GDPR Article 5(2) accountability**: a deterministic write→audit relationship is documentable for regulator interviews; "events flow through a queue with N retries and may drop" is harder to defend.
- **RTBF safety**: scrub operations operate on stored events. Sync recording means the scrub CLI doesn't race with an in-memory queue.
- **SOC 2 CC7.2 monitoring**: the deterministic relationship is the attestation surface; async queuing makes monitoring depend on queue health.

**Why fail-open (not blocking):**
- Universal Provider Requirement #5 — "Audit fails open (audit failure must never block writes)."
- Audit-failure on a failure path must never block the failure response itself. Validation-rejection responses must not get an additional audit-recording-failed error stacked on top.

**Why parallel fan-out:**
- Two providers' latencies don't stack (matters when one is local + one is external-sink).
- Failures are independent; operators see all failures at once instead of "first failure wins."

**Strict mode opt-in:**

```ts
export default defineSite({
  admin: {
    audit: {
      strict: true,   // any provider failure blocks the write
    },
  },
})
```

For HIPAA / SOC 2 compliance contexts where "audit recording confirmed successful" is a hard prerequisite for the write to proceed. Default off; opt-in.

**Latency budget (informational):**
- `HistoryAuditProvider` (local storage): ~5-50ms
- `CloudWatchAuditProvider`: ~50-200ms
- `HttpWebhookAuditProvider`: ~50-500ms (operator-URL-dependent)
- Multi-provider fan-out: cost of slowest provider (parallel)
- Acceptable on save (50-100ms invisible to authors); ~1-2% overhead on publish (already 1-30s).

## Configuration

Zero-config default — `HistoryAuditProvider` runs automatically; no `admin.audit` block needed.

> **Path X migration note**: the operator-config examples below predate the
> Path X factory-call shape (per [`design-provider-config.md`](design-provider-config.md)).
> When audit foundation ships, it'll move to Pattern 3 (multi-provider fan-out):
> `audit: auditChain([historyAudit(), cloudwatchAudit({ logGroup: 'gazetta-audit' })], { strict: false, actorPseudonym: 'sha256' })`.
> The string-discriminator `provider: 'name'` shape below is pre-cutover and will not ship.

```ts
// Single-string Provider name
export default defineSite({
  admin: {
    audit: {
      provider: 'cloudwatch',    // SDK reads AWS_REGION + credentials from env
      // logGroup: 'gazetta-audit',  // optional; default shown
    },
  },
})
```

```ts
// List form for multi-Provider compliance scenarios
export default defineSite({
  admin: {
    audit: {
      providers: [
        'history',             // local copy in target storage
        'cloudwatch',          // also stream to CloudWatch
      ],
      strict: false,           // default; audit failures never block writes
      actorPseudonym: 'none',  // default; 'sha256' for opt-in pseudonymization
      recordSourceIp: false,   // default; opt-in per GDPR consideration
      recordUserAgent: false,  // default; opt-in per GDPR consideration
    },
  },
})
```

**Defaults per Provider** (sensible — operator overrides only when needed):
- `history` — uses target's `.gazetta/history/`; no override needed
- `cloudwatch` — log group `gazetta-audit`
- `azure-monitor` — workspace from `AZURE_LOG_ANALYTICS_WORKSPACE_ID` env
- `syslog` — facility `local0`
- `file` — `./.gazetta/audit/`
- `opentelemetry` — endpoint from `OTEL_EXPORTER_OTLP_ENDPOINT` env

## Recording scope (v1)

Every write **attempt** — success and write-class rejection:

| Action | Recorded outcomes |
|---|---|
| `save` (page, fragment, or asset edit) | `success`, `validation-failed`, `forbidden`, `unauthenticated` |
| `publish` (any target) | `success`, `forbidden`, `unauthenticated` |
| `delete` (page, fragment, or asset) | `success`, `forbidden`, `unauthenticated` |
| `restore` (history rollback) | `success`, `forbidden`, `unauthenticated` |
| `configure-roles` (`site.config.ts`'s `admin.auth.roleMapping` change) | `success`, `validation-failed`, `forbidden`, `unauthenticated` |
| `sign-in` (a write request refused before a route is matched: the `GAZETTA_TOKEN` guard, or the identity provider rejecting the request) | `unauthenticated` |

A `sign-in` event is recorded for write methods (POST, PUT, PATCH, DELETE) on `/api/*` only, with the request's method and path in `metadata`: no route has been matched, so there's no other action to record, and no table of routes to keep in sync. A refused draft-preview render (`POST /preview/*`) is a read, so it isn't recorded, like other reads. `sign-in` joins the closed action list additively, like `create-redirect`. Decided: maintainer, 2026-10-24 (#1263).

Two POST routes under `/api/*` write nothing (`POST /api/publish/audit`, the publish dialog's pre-publish check, which runs the validators, and `POST /api/assets/:name/suggest-alt`, which returns an alt-text suggestion); refused requests to them are recorded too, since before a route is matched the method is the only signal. Decided: maintainer, 2026-10-24 (#1263).

| Rejected | Why |
|---|---|
| Exclude those two routes | Needs a list of routes kept in sync with the code, which the `sign-in` decision turned down |

A `sign-in` row says which check refused the request: the token, the credentials, an untrusted proxy, no matching role, or `unverifiable`: the identity provider's key endpoint or verification service couldn't be reached, timed out, or answered with a server error, so an outage reads as an outage rather than a scan. An answer that rejects the key (such as Cognito's for a key id it doesn't know) stays `credentials`, so forged tokens still read as a scan. A no-role row's actor is the verified user, pseudonymized like other actors when `actorPseudonym` is set; the others record actor `unknown`, since their identity isn't verified. An operator can tell a user missing from `roleMapping` from someone probing. Decided: maintainer, 2026-10-24 (#1263).

A refusal from an identity provider that doesn't say which check refused it (such as one an operator adds) is recorded as `credentials`, which is what the provider contract means by refusing; #1262 adds the check, and the verified user on no-role refusals, to the built-in providers' refusals. Decided: maintainer, 2026-10-24 (#1263).

| Rejected | Why |
|---|---|
| Method and path only, actor `unknown` | Every row would read alike, and why a request was refused isn't recorded anywhere on the server: its request log has only the method, path and status |
| Four checks, without `unverifiable` | During a key-endpoint outage every legitimate write would read as a `credentials` refusal from `unknown`, like a scan |
| Record a provider's unexplained refusal as `unknown` | In the provider contract, a plain refusal already means an invalid credential |
| Any error from the key endpoint or verification service counts as `unverifiable` | Cognito builds its key URL from the unverified token, so a forged token's made-up key id would read as an outage |

Refused write requests from senders without a verified identity share one allowance per instance: `sign-in` rows refused by the token, the credentials, an untrusted proxy or `unverifiable`, and the capability middleware's `unauthenticated` rows for a request that carries no credential at all, which the identity provider passes through as anonymous. A scan looks the same whichever check refuses it. Each instance records the first 20 of these a day in full, then one row an hour with the count of the rest: about 16,000 rows a year per instance under constant probing. No-role refusals, which only users the identity provider has verified can trigger, get their own allowance, counted the same way, so "Alice matched no role" stays visible during a scan. With `forwarded-user` and `allowAnyOrigin: true`, which `docs/auth.md` limits to development and trusted private networks, the user header isn't verified, so anyone who can reach the admin can claim any user there. The stored path is cut to 200 characters. Decided: maintainer, 2026-10-24 (#1263).

A count row covers one hour, and only an hour in which something was counted: a timer writes it when the hour ends, the way the retention pruner runs on a timer, and quiet hours add nothing. A restart loses only the current hour's count. It's a `sign-in` row for the whole site, actor `unknown`, with the hour and one count per check (`token`, `credentials`, `proxy`, `unverifiable`, `no-role`) plus `none` for requests with no credential at all, each a field of its own in `metadata`, so the drawer shows each count. Decided: maintainer, 2026-10-24 (#1263).

| Rejected | Why |
|---|---|
| Record every one | Anyone who can reach `/api/*` without credentials controls how many: nothing rate-limits requests, retention is off by default, and each event rewrites the instance's whole events file. A scan would show as thousands of identical rows |
| Cap `sign-in` rows only | A request with no credential at all never reaches them: where the identity provider passes it through as anonymous, the capability check would keep recording one row per request |
| 20 an hour | Constant probing would add about 184,000 rows a year per instance, piling up while retention is off, and every author save on that instance waits while the whole file is rewritten |
| One allowance for all checks, no-role included | A scan uses up the allowance within seconds, and a real user refused for having no role would show only inside the count |
| No count: one row saying further refused requests aren't recorded until the allowance resets | Nothing would be counted |
| A count row every hour, zeros included | The drawer would show quiet hours as zero-count rows, and each would rewrite the events file |
| The next refused request after the hour writes the count row | A scan's last hours would wait in memory until then, and a restart or deploy would lose them if none came |
| Leave the count row's action and fields to #1262 | Requests with no credential match none of the five checks, and the drawer would show a nested count as `[object Object]` |
| Store the allowance with the events, so it survives restarts | Every refused request would cost one more read and write on cloud storage, the cost the cap is meant to avoid |

**Recording sites** (the layer that produced the outcome records its own event):
- Save/publish/delete handler success path → `success`
- Save/publish handler validation rejection (409) → `validation-failed`
- Capability middleware 403 path → `forbidden` (with `metadata.missingCapabilities`)
- Production publish gate 403 (publish, publish stream, fetch) → `forbidden` (with `metadata.missingCapabilities`)
- Capability middleware 401 path (a request with no principal) → `unauthenticated`, counted against the shared allowance (not implemented yet: [#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262))
- `GAZETTA_TOKEN` guard 401, and principal middleware 401 when the identity provider rejects the request, for write methods on `/api/*` → `sign-in` / `unauthenticated` (with the method, the path cut to 200 characters, and which check refused it in `metadata`; counted against the shared allowance, or no-role's own; not implemented yet: [#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262))
- Hourly timer → the hour's `sign-in` count row (not implemented yet: [#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262))

**Anti-pattern avoided**: a global "audit interceptor" that wraps every handler and infers outcome from HTTP status. That couples audit to HTTP shape (forbids non-HTTP audit sources later, like CLI commands). Each site explicitly records its own outcome.

**Dedup discipline**: the layer that produced the outcome records once. Capability middleware short-circuits before the handler runs — one event per attempt, no double-recording. Plugin-provided middleware authors must follow the same rule.

**Audit-failure on a failure path must never block the failure response itself.** If a save fails validation and audit-recording the failure also fails, the user gets the validation error — not a separate audit-failed error obscuring the real one. Per Universal Provider requirement #5 (audit fails open).

**Deferred to v2 ambient log:**
- Reads (every API GET)
- Hook firings
- Cache reads / render-for-analysis

## Privacy defaults

- `sourceIp` and `userAgent` recording DEFAULT OFF. Operator opts in via `admin.audit.recordSourceIp` / `recordUserAgent` with documented GDPR consideration.

### Source IP recording (`admin.audit.recordSourceIp`)

```ts
export default defineSite({
  admin: {
    audit: {
      recordSourceIp: 'none',                 // 'none' | 'raw' | 'hashed' | 'truncated'
      trustedProxyHeader: 'X-Forwarded-For',  // forwarded-user trust mode only
      trustedProxyCount: 1,                   // number of trusted proxies in front of Gazetta
    },
  },
})
```

**Modes:**

| Mode | What's stored | Use case | Privacy posture |
|---|---|---|---|
| `none` | nothing (field absent) | Default. No IP recording. | Strictest |
| `raw` | full client IP | Forensic / incident response with full IP. | GDPR-personal-data; operator declares processing |
| `hashed` | `sha256(ip + GAZETTA_AUDIT_SOURCEIP_SALT).slice(0, 16)` | "Same source across events?" queries with pseudonymization. Salt rotation breaks correlation. | Pseudonymized |
| `truncated` | `/24` (IPv4) or `/48` (IPv6) prefix | Geographic / network-segment forensics without device identification. | Privacy-friendly default for operators who want some data |

**Trust-mode-driven header extraction** (security-critical — leftmost-XFF naive read is an OWASP Trust Boundary Violation):

| Trust mode | Correct source for client IP |
|---|---|
| `none` | TCP peer (no proxy assumed) |
| `forwarded-user` | `X-Forwarded-For` with operator-configured `trustedProxyCount` (count back from rightmost; everything to the right is trusted, leftmost is client) |
| `cloudflare-access` | `Cf-Connecting-IP` (Cloudflare-specific, signed/trusted) |
| `azure-easy-auth` | `X-Forwarded-For` (Azure App Service appends one entry; `trustedProxyCount=1`) |
| `aws-cognito` | `X-Forwarded-For` (ALB appends one entry; `trustedProxyCount=1`) |
| `tailscale` | TCP peer (Tailscale serves direct; no proxy chain) |

Future plugin-supplied trust modes declare their own `getClientIp(req): string | null` per the auth-identity provider contract.

**Failure mode**: when the configured header is missing (proxy misconfiguration), `sourceIp` is omitted from the event (not `'[unparseable]'`). Explicitly absent is more honest; operator monitoring catches misconfiguration via "expected sourceIp not present" patterns.

**IPv6**: handled. Truncation uses `/48` for IPv6 (operators routinely receive a /48 from ISPs).

**Salt for `hashed` mode**: `GAZETTA_AUDIT_SOURCEIP_SALT` env var. Different salt from `GAZETTA_AUDIT_ACTOR_SALT` — rotating one shouldn't break the other.

### User agent recording (`admin.audit.recordUserAgent`)

```ts
export default defineSite({
  admin: {
    audit: {
      recordUserAgent: 'none',     // 'none' | 'raw' | 'truncated'
    },
  },
})
```

| Mode | What's stored |
|---|---|
| `none` | nothing (field absent) |
| `raw` | full UA string |
| `truncated` | browser family + major version (e.g., `Chrome/119`); drops fingerprinting detail |

Lower priority than IP — most operators don't enable. No `hashed` mode for UA (low entropy makes hashing weak; if you want privacy, use `truncated` or `none`).
- Right-to-be-forgotten: future `gazetta audit scrub --actor=alice@example.com` CLI replaces actor field with `[scrubbed-{hash}]` in existing revisions. Hash is non-reversible. Required for GDPR-compliant operators. Trigger: validation Cut 5 CLI rewrite.

### Pseudonymization (`admin.audit.actorPseudonym`)

Default: `'none'`. Audit events store the upstream subject as-is.

```ts
export default defineSite({
  admin: {
    audit: {
      actorPseudonym: 'sha256',   // opt-in privacy hardening
      // GAZETTA_AUDIT_ACTOR_SALT env var required when sha256 is enabled
    },
  },
})
```

**When to opt in:**
- External-sink configurations where audit events leave Gazetta's process boundary (CloudWatch, Azure Monitor, OTel collector, HTTP webhook). Pseudonymization limits PII leakage if the sink's storage is compromised.
- Regulated contexts demanding pseudonymization-by-default (some EU healthcare contexts, German telecommunications data retention, etc.).
- Multi-tenant SIEM correlation where the operator wants to share hashes across systems (using a shared salt) without sharing raw subjects.

**Salt management:**
- Salt is a credential. Stored in `GAZETTA_AUDIT_ACTOR_SALT` env var per Universal Provider Requirement #3 ("Configuration via env vars for credentials"). Never in `site.config.ts`.
- 16+ random bytes. Operator generates at site creation; documents the creation date as part of operational records.
- Salt rotation breaks historic correlation by design. Rotate per security policy (annually is typical); document rotation dates so forensic queries can scope by salt-era.
- Multi-instance: every instance reads the same env var → deterministic hash across instances. No coordination needed.

**Forensic implications:**
- Forensic queries by upstream subject: `actor.id == sha256(sub + salt).slice(0, 16)`. Operator who knows the sub and salt computes the hash and searches.
- Cross-system correlation: works when adjacent systems share the salt; otherwise opaque.
- Pre-rotation events become "pre-rotation-era" forensically — degraded but acceptable per the standard pseudonymization pattern.

**Why not Gazetta-internal GUIDs with a stored mapping**: rejected (POV-walked Q2 refinement). New state primitive, race conditions on first-encounter, multi-target correlation problems, and a mapping table that's itself PII to protect — all without delivering any privacy benefit that hashed-sub doesn't deliver more cleanly.

**Migration:**
- A → C (turning on pseudonymization): rolling-compatible. New events hash; old events stay raw. Mixed log forever — historic events typically less queried than recent.
- C → A (turning off): historic hashed events become un-recoverable to identity once the salt is destroyed. Effectively a one-way RTBF for the historic events. Document before turning off.

### Failure-log payload exclusion

When audit recording fails (fail-open per Universal Provider Requirement #5), the failure log entry MUST NOT contain event payload:

```ts
logAuditFailure(providerName: string, eventId: string, errorCategory: 'transport' | 'config' | 'schema')
```

Failure investigation requires re-examining the original audit attempt via providers that DID succeed — not by reading payload from the failure log. Prevents PII side-channels into application stderr / log shipping.

### External-sink data residency (GDPR Article 30)

Each configured external-sink provider is a separate processor for the operator's Article 30 record. Document residency per provider:

| Provider | Data residency |
|---|---|
| `history` | Same target storage as content; operator-controlled |
| `cloudwatch` | AWS region (`AWS_REGION` env) |
| `azure-monitor` | Workspace's region (`AZURE_LOG_ANALYTICS_WORKSPACE_ID` resolves to a region) |
| `syslog` | Operator's syslog destination |
| `opentelemetry` | OTel collector's destination |
| `http-webhook` | Operator URL's region |

Cross-border transfers (EU operators using `cloudwatch us-east-1`) require Standard Contractual Clauses per Schrems II. Documented as an operator obligation; Gazetta provides the structural opt-in.

### In-flight encryption

| Provider | Encryption |
|---|---|
| `history` | Storage-provider-dependent (R2/S3/Azure native; filesystem operator-controlled) |
| `cloudwatch` | TLS via AWS SDK |
| `azure-monitor` | TLS via Azure SDK |
| `syslog` | Default UDP no encryption — operators needing compliance use TLS-syslog (rsyslog `gtls` or similar). Documented limitation. |
| `opentelemetry` | TLS via OTel exporter |
| `http-webhook` | HTTPS required in non-dev mode (refuses `http://` per the existing pattern from `design-media.md`) |

### Forbidden-event scope visibility

`forbidden` events record `scope` and `metadata.missingCapabilities` — useful for diagnosis but informative about user interest in restricted resources. Two postures:
- **v1 (document-only)**: audit logs are themselves access-controlled via `read:audit-log` capability. Admins with audit access see "who tried what." Acceptable for v1.
- **Future**: configurable scope masking (`forbidden` events on scope matching pattern X record scope as `[redacted]`). Reserved for regulated workflows; not v1.

## Retention

Audit retention is configurable independently from content history retention. Defaults to inherit history retention.

```ts
export default defineSite({
  admin: {
    audit: {
      retention: {
        events: 10000,        // max audit events to keep (per provider)
        maxAgeMonths: 72,     // 6 years for HIPAA; null = no time limit
        // When neither set, defaults to history.retention (shared retention)
      },
    },
  },
})
```

**Why separable**: compliance regimes specify retention windows (SOC 2 ~1 year, HIPAA 6 years, financial 7+ years, legal hold indefinite) that differ from content history retention budgets. Forcing `history.retention: 1000` to satisfy HIPAA audit balloons content storage; B lets operators keep 50 content revisions + 6 years of audit events independently.

**Two dimensions**: `events` (max count) AND `maxAgeMonths` (max age) — compliance often specifies both ("keep audit for 6 years AND no fewer than N events"). Operator sets one or both.

**Composition with content retention**:
- **Content-bearing revisions** (success outcomes — saves, publishes, restores with snapshots) — subject to BOTH content retention and audit retention; pruned/stripped per the more permissive.
- **Audit-only revisions** (failure outcomes — `forbidden` / `validation-failed` / `unauthenticated` — no content snapshot) — subject to audit retention only.

**Pruner mechanism** (extending the existing history pruner):
1. **Content pruning pass**: age out content-bearing revisions per `history.retention`.
2. **Audit pruning pass** (new): age out audit fields per `audit.retention.events` and `audit.retention.maxAgeMonths`. Audit-only revisions deleted; content-bearing-but-audit-stripped revisions retain content snapshot, lose actor / outcome / metadata.

**External-sink retention**: applies only to providers Gazetta owns the storage for (`history`, `file`). External-sink providers (CloudWatch, Azure Monitor, OTel) have their own retention configured on the sink side. Operator pattern: "keep 90 days locally for fast queries; 6 years in CloudWatch for compliance" — `audit.retention.maxAgeMonths: 3` locally, CloudWatch log group `retentionInDays: 2192` separately. Documented.

**GDPR storage-limitation alignment** (Article 5(1)(e)): personal data shouldn't be kept longer than necessary. Long audit retention is the documented exception per Article 17(3)(b) — retention required by legal obligation overrides erasure. B lets operators set retention to their actual obligation; A would force inheritance from content retention which is the wrong constraint.

**Migration**: existing sites without `audit.retention` block inherit history retention (no breaking change).

## Tampering limitation

Audit log lives in target's writable storage; an admin with write access can edit revisions. v1 accepts this; external-sink Providers (v2) are the upgrade path for high-stakes operators who need tamper-evident logs. Documented as known limitation.

## Audit drawer — query semantics

The admin audit drawer (gated by `read:audit-log` capability) projects results based on configured providers. Each provider is one of two query shapes:

- **Query-capable** — implements `query()`. Returns events for the filter.
- **External-sink** — omits `query()`, optionally implements `queryUrl()` returning a deep-link to the operator's destination console.

**Drawer behavior matrix:**

| Configuration | Drawer state |
|---|---|
| `history` only | Local events list; no external link |
| `history` + `file` (both query-capable) | Merged events list; dedupe by `event.id` |
| `history` + `cloudwatch` (mixed) | Local events list + footer link "View full audit in CloudWatch" |
| `cloudwatch` only | Empty events list + prominent message "Audit lives in CloudWatch — [link]" |
| `cloudwatch` + `webhook` (no query, no link) | Message: "Audit configured but not queryable. Configure history as a peer provider for in-admin browsing." |

**Recommended operational pattern**: run `history` always (cheap, queryable, multi-instance-correct) + external-sink for tamper-evident retention. Best-of-both: in-admin browsability AND external compliance posture.

**Provider deep-link examples:**
- `cloudwatch.queryUrl()` → `https://console.aws.amazon.com/cloudwatch/home?region={AWS_REGION}#logsV2:log-groups/log-group/{logGroup}`
- `azure-monitor.queryUrl()` → workspace's Log Analytics URL
- `opentelemetry.queryUrl()` → null (collector destination is opaque to Gazetta)
- `http-webhook.queryUrl()` → null (operator's destination is opaque)
- `syslog.queryUrl()` → null (operator's syslog destination is opaque)

**Failure during query**: query() failures are fail-open per Universal Provider Requirement #5. Drawer surfaces "audit query unavailable" with the provider name; doesn't throw. Local query failures don't block external-sink links from being shown.

**Capability gating**: `read:audit-log` gates the drawer entirely. Without it, the drawer is absent — no link, no events, no configuration disclosure.

## Real-time observation pattern

Composes with future presence design:
- Pull-based: real-time consumer polls for new revisions since last seen ID. Multi-instance-correct (storage shared).
- File watcher as optimization where supported (filesystem provider only).
- Push-based webhooks (`HttpWebhookAuditProvider`) for operators who want low-latency external observation.

## Index sidecar pattern (reserved for v1.5/v2)

v1 ships full-scan only — at envelope (~25K events/year per `design-scale.md`), full scan is ~50ms on filesystem, ~500ms on R2/S3, well under the 5-second admin SLA.

**Trigger to move from reserved → designed (any one fires):**
- Query latency p95 > 2 seconds (operator-monitored)
- Event count > 100K per target
- 3+ operator reports of "audit query slow" within 6 months (matches the plugin-promotion trigger pattern)

**Reserved sidecar shape** (when triggered):

```
.gazetta/audit-index/
  actor/
    {actor.id}/
      rev-{ts}            # zero-byte file pointing at the revision
  date/
    {YYYY-MM-DD}/
      rev-{ts}
  scope/
    {scope.kind}.{scope.name}/
      rev-{ts}
  action-outcome/
    {action}-{outcome}/
      rev-{ts}
```

`readDir` on `.gazetta/audit-index/actor/alice@example.com/` returns matching revision IDs in O(N-matching), not O(total events). Per-edge granularity means concurrent writes don't race — validated pattern from asset-refs sidecars.

**Pruner integration when shipped**: index sidecars deleted alongside their revision during retention pruning (per-revision walk; no aggregate-file rewrite).

**RTBF integration when shipped**: scrub CLI moves index sidecars under `actor/{old-id}/` to `actor/[scrubbed-{hash}]/` as part of the rewrite operation.

**Why not ship from day one**: optimizing the 1% case (operators past hard limit) at the cost of the 99% case (operators at envelope) is wrong. Pattern is validated by asset-refs and history; shipping when triggered is cheap (1-2 days design + 3-5 days implementation).

## Foundational checks

How audit log composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Per-revision granularity (existing history pattern). Each instance writes its own revisions to ID-keyed files (`rev-{ts}.json`); reads aggregate via `readDir`. Multi-instance-correct by construction — no shared mutable state.
- Multi-provider fan-out is per-request stateless (parallel `Promise.allSettled`). No coordination across instances.
- Salt for actor / sourceIp pseudonymization read from env vars per-instance — deterministic across instances by sharing the env value.
- Retention pruning runs per-target; per-revision file granularity means concurrent pruners on the same target converge (delete idempotent on ENOENT).
- Index sidecars (when shipped) follow the per-edge pattern from asset-refs — concurrent writes don't race.

### Scale (#1)
- At envelope (~25K events/year per `design-scale.md`): full-scan grep ~50ms filesystem, ~500ms cloud storage — well under 5-second admin SLA.
- At 100K events: query latency p95 approaches 2 seconds — index sidecar trigger fires.
- At hard limit (250K+): index sidecars required for SLA.
- Refused write requests from senders without a verified identity come as often as outsiders send them; the shared allowance keeps them to the first 20 a day in full, then one count row an hour: about 16,000 rows a year per instance under constant probing, per replica, since each instance has its own allowance. A restart starts a new allowance, so the 16,000 assumes a long-running instance: an admin that scales to zero can record a slow scan in full after every cold start. They accumulate while retention is off. Decided: maintainer, 2026-10-24 (#1263).
- Audit recording cost: 50-200ms per event (sync fail-open, parallel fan-out). Acceptable on save (invisible to authors); ~1-2% overhead on publish (already 1-30s).
- External-sink providers add their own latency to the slowest-provider envelope.

### Locale (#2)
- Events scope locale via `metadata.locale` when relevant (e.g., a save of `page.fr.json` records `metadata.locale: 'fr'`). Consumers query by `metadata.locale` when locale-aware forensics needed.
- No per-locale audit retention or per-locale audit storage. Locale is informational only.
- RTBF scrub is locale-agnostic — scrubbing actor doesn't care which locale variants the actor edited.

### Themes (#3)
- Events record theme on writes via `metadata.theme` when the write was theme-scoped (e.g., theme-variant asset upload). Informational.
- No per-theme audit retention or per-theme audit storage.

### Auth + RBAC (#4)
- `actor` field is the load-bearing input from auth/RBAC. Snapshot of the principal at decision time (per Q2 lock).
- `read:audit-log` capability gates the audit drawer entirely. Without it, the drawer is absent — no link, no events, no configuration disclosure.
- Denied write requests are recorded: `forbidden` by the capability middleware or the production publish gate, `unauthenticated` by the capability middleware for a request with no principal. Login and role-resolution failures, which the identity layer rejects before a route is matched, are recorded as `sign-in` events for write requests to `/api/*` (not implemented yet: [#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262)).
- Audit-log read access is its own capability (`read:audit-log`) — viewers don't see audit by default.

### Review (#6)
- Every review-state transition is recorded as an audit event. State machine attributes each transition to a `Principal` so the history trail is reconstructable from audit log alone.
- Review configuration changes (`requiresPublishApproval` toggle) record as `action: 'configure-roles'`-class events (extending `action` enum if needed; reserved for the review design pass).
- Self-approval policy enforced at the review layer; audit records the attempt with appropriate outcome regardless of self-approval allow/deny.

### Hooks (#7)
- Hook firings record as audit events when `action: 'hook-fired'` lands in v2. v1 doesn't record hook firings (deferred per recording-scope-v1 lock).
- Plugin-supplied hooks that act on behalf of a system identity audit as the configured `serviceAccount` actor.
- Hook failures audit as the same actor that triggered the hook (the failure outcome reflects the hook handler's failure, not the trigger's).

### Render (#8)
- Render-for-analysis cache misses don't audit (reads are not in v1 recording scope).
- Static target render at publish time records the publishing actor; render-time anonymous reads don't.
- Dynamic SSR with `Principal` in render context: when permission-filtered output is computed, no per-render audit event (would explode event volume); the underlying capability check at the page-resolve level audits if it denied.

### Validation (#9)
- Validator failures don't audit (validators are pure functions over a manifest); save 409 responses DO audit with `outcome: 'validation-failed'` per Q1 lock — recorded by the receiving handler, not the validator.
- Background scanner failures (long-running) don't audit per-page; if scanner crashes, that's an operator log concern, not an audit event.
- Pre-publish gate strict-mode rejection records as `outcome: 'validation-failed'` on the publish attempt.

### Plugin (#10)
- `AuditProvider` is Extension Surface #11. Plugin-supplied providers inherit Universal Provider requirements (per ADR-0004): multi-instance correctness, stateless interface, env-var credentials, sensible defaults, fail-mode declared (audit fails open), never-throws-on-transport-errors, stable typed contract, independent error taxonomy (`AuditError`), operator config consistency, forward-compatible plugin promotion.
- Plugin promotion trigger: 3+ operator requests for an unlisted sink within 6 months.
- Plugin-supplied providers add to the catalog at the same `admin.audit.providers:` config level as in-tree providers.

### Cache (#11)
- `AdminCache` misses don't audit (reads not in v1 recording scope).
- Cache invalidation events (when a save invalidates `pages:` prefix) don't audit — invalidation is mechanical, not actor-attributable beyond the save itself.
- The save event already records the actor + scope; cache invalidation derives.

### Offline (#12)
- Replayed write events on reconnect record `metadata.replayed: true` + original-attempt timestamp + reconnect timestamp.
- Replay actor is captured at queue time, not replay time. If the actor lost the capability while offline, replay fails with `outcome: 'forbidden'` recorded at replay time, with `metadata.replayed: true` + original `metadata.queuedAt` timestamp.
- Offline write queue itself doesn't audit pre-queue (no server roundtrip to record); audit happens on replay attempt.

## Migration

Sites without `admin.audit` config use `HistoryAuditProvider` automatically. Existing history records get synthetic `actor: "unknown"` on read. No data migration.

## Future directions

- **Per-API-call recording** (reads, including read requests the identity layer or a capability check refuses). Compliance-tier; deferred until SOC 2 / HIPAA demand.
- **External sink providers** (CloudWatch, Azure Monitor, etc.). Demand-driven; in-tree on first 3 operator requests for the same provider.
- **Index sidecar** at hard-limit scale.
- **Audit log query CLI** (`gazetta audit query --actor=X --since=Y`). Lands with validation Cut 5 CLI rewrite.
- **Right-to-be-forgotten scrub CLI** (`gazetta audit scrub`). Same trigger.
- **CSV export.** `GET /api/audit` returns JSON; there's no export in the drawer. Left from [#200](https://github.com/gazetta-studio/gazetta-studio/issues/200).
- **Events for role and config changes.** `configure-roles` is reserved but never recorded, and `site.config.ts` edits aren't recorded. Left from #200.
- **A filter by target** in the drawer and `GET /api/audit`; publish events carry the target name in their metadata. Left from #200.
- **Date-range and item filters in the drawer.** `GET /api/audit` takes dates and an item name; the drawer filters by action, outcome, kind and person only. Left from #200.

Decided: maintainer, 2026-10-23 (#1179)

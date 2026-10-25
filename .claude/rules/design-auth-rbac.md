---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "packages/gazetta/src/history-recorder.ts"
  - "packages/gazetta/src/history.ts"
  - "**/auth*"
  - "**/role*"
---

# Auth + RBAC

Foundational dimension #4 of 13. Authentication identity model (Gazetta consumes upstream identity, never does auth itself) + role-based access control + capability-based authorization gates.

**Status**: design pass complete (2026-05); implementation shipped 2026-05 ([#194](https://github.com/gazetta-studio/gazetta-studio/issues/194); operator guide [`docs/auth.md`](../../docs/auth.md)); the per-target `publish:production` check on publish and fetch since [#1253](https://github.com/gazetta-studio/gazetta-studio/pull/1253) ([#1191](https://github.com/gazetta-studio/gazetta-studio/issues/1191)).

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Auth/RBAC check** every new feature design must answer
- [`design-audit.md`](design-audit.md) — sibling foundational dimension #5; audit log records every action with `Principal.actor`
- [`design-review-workflow.md`](design-review-workflow.md) — sibling foundational dimension #6; review workflow consumes the capability vocabulary
- [`design-publishing.md`](design-publishing.md) — history-recorder is the existing primitive; audit log extends it with actor identity
- [`design-editor-ux.md`](design-editor-ux.md) — Active target + Save semantics that review workflow gates on
- [`docs/adr/0004-pluggable-provider-pattern.md`](../../docs/adr/0004-pluggable-provider-pattern.md) — pluggable provider pattern; AuthIdentity is configurable v1 with plugin-promotion reserved

## Why this is foundational

Strategic commitment locked: **Gazetta is a team CMS**, not a solo developer tool. Every API endpoint, every admin action, every save/publish operation gates on roles. The Principal carries actor identity that audit log records and review workflow attributes. Auth is gates and identity; this design pass owns those primitives.

Adding auth/RBAC later means auditing every endpoint consumer and adding a Principal-aware request context. Doing it now in front of audit + review keeps the dependency order clean: auth/RBAC supplies the Principal that audit consumes and that review attributes.

## Locked invariants (already decided)

- **history-recorder is the foundation for audit log.** `recordWrite()` already runs on every save and publish ([packages/gazetta/src/history-recorder.ts](../../packages/gazetta/src/history-recorder.ts)). The audit log adds an `actor` field; doesn't replace the existing primitive.
- **Audit log is the source of real-time events.** Per the real-time event-source discipline in `feature-design-process.md`, save/publish handlers record to audit log; real-time push (presence, live publish status) observes audit log. Not bolted into save/publish handlers directly.
- **Permission-filtered output composes here, not in a separate search design.** Filtered listings, search results, dependents queries — all filter by role via the same gate.
- **Per-content review, per-target publish approval.** Content is reviewed once, on the source; publish approval is opt-in per destination target (`requiresPublishApproval`). See `design-review-workflow.md`.

- **No built-in authentication. Gazetta consumes upstream identity, never does auth itself.** No password storage, no magic links, no OIDC/SAML/OAuth flows, no login UI in Gazetta. Operators put Gazetta admin behind whatever auth their platform provides (Cloudflare Access, Azure App Service Easy Auth, AWS Cognito + ALB, oauth2-proxy / Authelia, Tailscale, Caddy basic auth, etc.). Gazetta reads the authenticated principal from configured request headers populated by the upstream layer.

  Why: cloud platforms ship better auth than Gazetta would; auth code is where security bugs live; Gazetta stays narrow and inherits the platform's auth posture. Documented per-platform.

- **Auth identity model: configurable at v1, pluggable reserved.** `site.config.ts`'s `admin.auth` block selects from a fixed set of built-in trust modes:

  | Mode | Reads identity from | Use case |
  |---|---|---|
  | `none` (default) | — | Dev / solo / no auth, no RBAC, single-author behavior |
  | `forwarded-user` | `X-Forwarded-User`, optional `X-Forwarded-Email`, `X-Forwarded-Groups` | Generic reverse-proxy mode (Caddy, oauth2-proxy, Authelia) |
  | `cloudflare-access` | `Cf-Access-Authenticated-User-Email`, signed JWT | Cloudflare Access |
  | `azure-easy-auth` | `X-MS-CLIENT-PRINCIPAL` (base64 JSON) | Azure App Service Easy Auth |
  | `aws-cognito` | `x-amzn-oidc-data` (JWT) | AWS ALB + Cognito |
  | `tailscale` | `Tailscale-User-Login`, `Tailscale-User-Profile-Pic` | Tailscale Funnel / serve |

  Header-spoofing protection per mode (signed JWT validation where the platform provides one; source IP whitelist where it doesn't). Trust mode REQUIRES explicit opt-in — operators who don't set it run in `none` mode.

  Plugin promotion trigger: 3+ operator requests for an unlisted platform within 6 months → either add in-tree (if mainstream) OR promote to plugin (if long-tail). Until then, configurable-with-named-modes is the v1 shape.

  Internal interface (`AuthIdentityProvider`) shape is plugin-compatible — promotion to plugin extension surface is a documentation + discovery-wiring change, no breaking config shape change.

## Open questions for the design pass

### Multi-instance check
- Audit log writes go to storage (extending the existing history-recorder). Multiple instances appending concurrently — granularity required (per-revision file, like history's `rev-{ts}.json`, NOT a shared append-only log file).
- Session/auth state — where does it live? Per-instance (sticky sessions required) or storage-backed (any instance can validate any session). Latter is preferred for zero-downtime deploys.
- Review workflow state — per-target storage, not in-memory. Multiple admin instances reading/writing the same review state must not race; per-edge-style granularity OR atomic write-through-storage.
- Permission cache — if roles are fetched per-request, no cache; if cached, scope to per-request only (multi-instance-correct by default). Long-lived caches forbidden by the multi-instance discipline.

### Roles — locked

**Hybrid built-in + custom; single role per principal; mapped from upstream group claims.**

**Built-in roles** (predefined; permissions in Q3):

| Role | Capabilities (baseline) |
|---|---|
| `admin` | Everything: read / edit / delete / publish / configure |
| `editor` | Read everything; edit + save; publish to non-production targets; request publishes to targets that require approval (`publish:request`, `design-review-workflow.md` 2026-10-25); cannot delete or configure |
| `viewer` | Read-only; cannot edit, save, or publish |

**Custom roles** allowed via `site.config.ts` `roles:` block. Operator names + capabilities. Common cases: `translator` (editor-scope on locale variants only), `approver` (viewer + publish), `auditor` (read + audit-log access).

**Single role per principal.** Each authenticated user resolves to exactly one Gazetta role. Multi-role complexity (precedence conflicts, role intersection) is rare in practice and adds significant surface area; deferred until concrete operator demand.

**Group-claim mapping.** The upstream auth provider populates a group / role claim; Gazetta maps it. Operator configures `admin.auth.roleMapping` in `site.config.ts`:

```ts
export default defineSite({
  admin: {
    auth: {
      trust: 'cloudflare-access',
      roleMapping: {
        claim: 'groups',         // JSON claim / header field carrying the group list
        map: {
          'gazetta-admins': 'admin',
          'gazetta-editors': 'editor',
          'gazetta-readers': 'viewer',
          'gazetta-translators': 'translator',
        },
      },
      defaultRole: 'viewer',     // fallback when no group matches; null = deny access
    },
    roles: {
      translator: {
        capabilities: [
          // ... see Q3 ...
        ],
      },
    },
  },
})
```

**Why upstream claims, not `site.config.ts` user→role hardcoding**: upstream auth provider (Cloudflare Access, Azure AD, etc.) already manages user→group membership; Gazetta just maps group names to role names. Brittle "user-list-in-config" approaches force config edits on every team change.

**Per-target / per-page roles deferred.** v1 ships site-wide roles. Per-target roles ("editor on staging, viewer on prod") and per-page roles ("can edit /docs/* but not /blog/*") wait for concrete operator demand. The capability shape (Q3) is forward-compatible with both.

**Multi-instance**: role mapping is per-request stateless. Gazetta reads the claim, looks up the in-memory map, no shared state. Multi-instance-correct by construction.

### Authorization gates — locked

**Capability-based gates with role aliases. Hono middleware per-route. 403 with structured reason for authenticated users; coarse-grained discovery filter for v1.**

**Capability vocabulary** (the stable extension point):

| Domain | Capabilities |
|---|---|
| Read | `read:pages`, `read:fragments`, `read:assets`, `read:audit-log` |
| Edit | `edit:pages`, `edit:fragments`, `edit:assets`, `edit:locale-variants` |
| Delete | `delete:pages`, `delete:fragments`, `delete:assets` |
| Publish | `publish:*`, `publish:non-production`, `publish:production` |
| Configure | `configure:site`, `configure:targets` |
| History | `restore:history` |
| Wildcards | `read:*`, `edit:*`, `*` |

**Built-in role aliases** (predefined as capability sets):

```ts
const BUILT_IN_ROLES = {
  admin: ['*'],
  editor: ['read:*', 'edit:*', 'publish:non-production'],
  viewer: ['read:*'],
}
```

**Custom roles** declare capabilities directly:

```ts
export default defineSite({
  admin: {
    roles: {
      translator: {
        capabilities: [
          'read:pages',
          'read:fragments',
          'read:assets',
          'edit:locale-variants',  // narrower than edit:pages
        ],
      },
    },
  },
})
```

**Hono middleware** per-route checks the required capability against the principal's effective capability set. Plugin-supplied routes declare their required capability via the same middleware contract.

**Failure mode**: 403 with structured body for authenticated users:
```json
{ "code": "FORBIDDEN", "missing": ["edit:pages"], "role": "viewer" }
```
- Authenticated users have already passed auth; the existence-leak risk doesn't justify the operational pain of 404-hide-existence semantics. Authenticated user sees what they can't do.
- Unauthenticated requests (when `trust !== 'none'`): 401 with `WWW-Authenticate` hint pointing at the upstream auth layer. Gazetta doesn't issue a login challenge itself — the upstream platform owns that flow.
- Public-facing `gazetta serve` runtime: 404 for non-existent pages unchanged (no auth concept involved).

**Discovery filtering** (v1 = coarse-grained):
- `/api/pages` returns the full page list to admin/editor (they can see everything per built-in role baselines); viewer sees the same set in v1 (per-page-pattern hidden state deferred per Q2).
- Per-target visibility (publish-to-staging vs. publish-to-production) is a capability check at the publish endpoint, NOT a discovery filter — viewers see all targets, the publish action is gated.
- Per-page-pattern hidden state (e.g., "viewer can't see /admin-only/*") is a future capability when concrete operator demand surfaces. Forward-compatible: `read:pages` becomes `read:pages:{pattern}` in that future.

**Custom-role capability validation** at site-load: unknown capabilities in custom role definitions are flagged (warning by default, error in strict mode via `admin.auth.strict: true`).

**Multi-instance**: capability checks are per-request stateless. Middleware reads the principal's role from request context (set by upstream identity consumption per Q1), looks up capabilities in the in-memory role table (loaded from `site.config.ts` at boot), no shared state. Multi-instance-correct by construction.

### Audit log — see [`design-audit.md`](design-audit.md)

Audit log + `AuditProvider` extension surface is its own foundational dimension #5. Composes with auth/RBAC's `Principal` type for actor identity.

For this design pass, the auth/RBAC primitives expose the `Principal` to handlers; how auth/RBAC events get recorded is `design-audit.md`'s concern.

### Review workflow — see `design-review-workflow.md`

Review workflow (state machine for content approval + per-target publish approval) is its own foundational dimension #6, designed in a future pass. Composes with auth/RBAC's capability vocabulary (adds `review:submit`, `review:approve`, `publish:request`, `publish:approve` capabilities) and with audit log (every state transition recorded as an audit event).

For this design pass, the auth/RBAC primitives expose the `Principal` + capability model that review workflow consumes. State-machine, archetype recipes, sidecar shapes, edit-during-pending semantics, and UX archetypes are all `design-review-workflow.md`'s concern.

### Real-time events — see future presence design

Real-time presence + live publish status are downstream consumers of the audit log per the real-time event-source discipline. Designed as a separate Tier 3 implementation pass when team-CMS scale demand surfaces.

### Composition with hooks — see `design-hooks.md`

Hooks fire with actor context (`Principal` in payload) per `design-hooks.md`'s upcoming design pass. The auth/RBAC primitives expose the `Principal`; hook design specifies the firing surface.

## Foundational checks

How auth/RBAC composes with each of the other 12 foundational dimensions plus the multi-instance discipline. These compositions are how this dimension lands without retrofitting every other surface later.

### Multi-instance discipline
- `Principal` is per-request, derived from request headers by the auth-identity provider. No cross-request state in process; middleware is stateless.
- Role-mapping table loads from `site.config.ts` at boot; reread on `site.config.ts` change via the existing config-watch loop. Each instance loads independently — no shared mutable state.
- Permission cache (if any) is per-request only. Long-lived caches forbidden.
- Header-spoofing protection (signed JWT validation, source-IP whitelist) runs per-request; no shared state.

### Scale (#1)
- Capability checks are O(1) lookups into the principal's effective capability set; no scaling concern at the role layer.
- Discovery filtering (v1 coarse-grained, future per-pattern) costs at most one capability evaluation per item in a listing — same envelope as the listing itself, not a multiplier.
- Per-page-pattern visibility (deferred) lands as `read:pages:{pattern}` capability; matching cost is per-page glob check, bounded by listing size.

### Locale (#2)
- `edit:locale-variants` is narrower than `edit:pages` — translator role can edit locale variants without touching the default-locale manifest.
- Capability vocabulary stays at the manifest level, not per-locale-cell. Per-locale-cell capabilities (`edit:locale-variants:fr`) are a future extension if concrete operator demand surfaces.
- Locale-aware fallback: a translator's edits to `page.fr.json` are gated on `edit:locale-variants`, not `edit:pages` — their role doesn't grant the broader edit.

### Themes (#3)
- Theme-variant assets and theme-conditional renders inherit the auth gate of their containing manifest. No theme-specific capability layer in v1.
- Future: `edit:theme-variants` if a "theme designer" role becomes a concrete operator request, paralleling `edit:locale-variants`.

### Audit (#5)
- `Principal` is the load-bearing input to audit log. Every recorded event carries `actor: Principal`.
- Audit-log read access is its own capability (`read:audit-log`) — viewers don't see audit by default.
- Denied write requests are recorded in the audit log per `design-audit.md`. Login and role-resolution failures, which the identity layer rejects before a route is matched, are recorded as `sign-in` events for write requests to `/api/*` per `design-audit.md` (not implemented yet: [#1262](https://github.com/gazetta-studio/gazetta-studio/issues/1262)).

### Review (#6)
- Review-state transitions consume capabilities (`review:submit`, `review:approve`, `publish:request`, `publish:approve`).
- Self-approval is configurable with `reviewWorkflow.allowSelfApproval`, default `true`; with `false`, the submitter can't approve their own submission (`design-review-workflow.md`).
- The review state machine attributes each transition to a `Principal` so the history trail is reconstructable from audit log alone.

### Hooks (#7)
- Hook firings carry the triggering `Principal` in payload. Hook handlers run with the same effective capabilities as the triggering principal — they don't gain elevated access.
- Plugin-supplied hooks that need to act on behalf of a system identity declare a `serviceAccount` capability set; operator-approved per-plugin in `site.config.ts`.
- Hook failures audit as the same actor that triggered the hook.

### Render (#8)
- Render-time RBAC: dynamic / SSR templates receive `Principal` in render context for permission-filtered output (e.g., a member-only section that hides for non-members).
- Static targets render at publish time with no `Principal` (anonymous render); permission-filtered content can't ship to static targets without a per-render-mode capability check at publish time.
- Render-for-analysis (validation) runs as a system principal with `read:*` — the renderer needs to read all referenced fragments to validate the page.

### Validation (#9)
- Save-delta validators run as the saving principal; their reads are gated the same as the save itself. A viewer attempting save fails authorization before validators run.
- Background scanner runs as a system principal (`read:*`) — it scans every page, including those a particular user couldn't see.
- Pre-publish gate's audit step shows the publishing principal which issues block their publish; the issue list itself is filtered to what they can see.

### Plugin (#10)
- `AuthIdentityProvider` is configurable v1 with plugin-promotion reserved (per Q1). Plugin-supplied auth providers inherit the universal Provider requirements (header-spoofing protection, fail-closed on configuration error, etc.).
- Plugin-contributed admin routes declare required capabilities via the same Hono middleware contract — no plugin-specific capability namespace in v1.
- Plugin-contributed capabilities (e.g., a search plugin adding `search:rebuild-index`) follow the same vocabulary shape; reserved-prefix conventions documented in the plugin design pass.

### Cache (#11)
- Cache scope respects role visibility: cached entries scoped to role principal at cache time.
- Role change (re-auth, principal switch) invalidates the role-scoped cache to prevent leaking entries cached under a higher-privilege principal.
- `read:audit-log` results are NOT cached cross-request — audit reads are real-time.

### Offline (#12)
- Browser-side cache scoped to role principal; role switch invalidates per `design-offline.md`.
- Offline reconnect-replay: queued writes replay as the principal who queued them (captured at queue time). Replay capability check runs at replay time — if the principal lost the capability while offline, replay fails with a structured error in the audit log.
- Offline write queue itself is gated on the capability the action requires (an offline viewer can't queue saves; their save button is disabled).

## Migration

Sites without RBAC config continue to work in single-author mode (current). Adding `auth:` config enables the team-CMS layer. Existing history records get a synthetic `actor: "unknown"` for pre-RBAC entries.

## Future directions

- Concurrent editing (OT/CRDT) — Tier 3 strategic bet, lands after presence-only ships
- Compliance certifications (SOC 2, HIPAA) — depends on audit log shape; possibly Tier 3
- Custom workflows — beyond `draft → review → approved → published` — operator-defined state machines
- Per-component permissions (within a page) — out of scope for v1

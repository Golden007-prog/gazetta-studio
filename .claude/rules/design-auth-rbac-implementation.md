---
paths:
  - "packages/gazetta/src/auth/**"
  - "packages/gazetta/src/admin-api/middleware/auth*"
  - "packages/gazetta/src/admin-api/routes/**"
  - "packages/gazetta/src/types.ts"
---

# Auth + RBAC — Implementation

Companion to [design-auth-rbac.md](design-auth-rbac.md). Cut sequence with risk ordering, per-cut scope, deferred items.

See [design-auth-rbac.md](design-auth-rbac.md) for the design itself.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `auth-rbac-v1` off `main` (after TS config migration is shipped per Phase 1 sequencing). Commits ordered low-risk-first per [team-preferences.md rule 17](team-preferences.md). Pre-1.0 product; **no backwards compatibility** — cutovers replace existing code wholesale.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `auth/` infrastructure: types, config schema, trust-mode dispatcher | ✓ | Low | Type-only foundation; no runtime |
| 2 | `AuthIdentityProvider` interface + `none` trust mode | ✓ | Low | The seam; `none` is the trivial case |
| 3 | `forwarded-user` trust mode + header validation | ✓ | Medium | Most flexible; basic header parsing |
| 4 | `cloudflare-access` trust mode + JWT verification | ✓ | Medium-high | First provider needing crypto |
| 5 | `azure-easy-auth`, `aws-cognito`, `tailscale` trust modes | ✓ | Medium | Provider proliferation |
| 6 | Capability vocabulary + role aliases + Zod schema | ✓ | Low | Static data structures |
| 7 | `Principal` request context + auth middleware | ✓ | Medium | Hono integration |
| 8 | Capability-check middleware + 401 / 403 responses | ✓ | Medium | Per-route capability enforcement |
| 9 | Wire all 10 admin-API routes with capability gates | ✓ | Low-medium | Mechanical integration |
| 10 | Trust-mode integration tests with real header fixtures | ✓ | Medium | Validates each trust mode end-to-end |
| 11 | Docs: per-trust-mode operator guide + capability reference | ✓ | Low | User-facing |

## Per-cut scope

### Cut 1: `auth/` infrastructure

**Files added:**
- `packages/gazetta/src/auth/types.ts` — `Principal`, `TrustMode`, `Capability`, `Role`, `RoleMapping`
- `packages/gazetta/src/auth/config.ts` — Zod schema for `admin.auth` block
- `packages/gazetta/src/auth/index.ts` — barrel export

**Tests:** schema parsing happy path + invalid config rejection

**Why first:** lowest blast radius. Types + schema; no runtime behavior. Reverting one file rolls back.

### Cut 2: `AuthIdentityProvider` interface + `none` trust mode

**Files added:**
- `packages/gazetta/src/auth/provider.ts` — `AuthIdentityProvider` interface + factory contract
- `packages/gazetta/src/auth/providers/none.ts` — `nonePrincipalProvider` (always returns `{ id: 'unknown', role: 'unknown', trustMode: 'none' }`)

**Tests:** `nonePrincipalProvider` returns canonical `unknown` Principal; doesn't error on any request shape

**Why second:** establishes the seam. `none` is the LSP test bed — proves the contract works before adding real providers.

### Cut 3: `forwarded-user` trust mode

**Files added:**
- `packages/gazetta/src/auth/providers/forwarded-user.ts` — reads `X-Forwarded-User`, `X-Forwarded-Email`, `X-Forwarded-Groups`
- Header-spoofing protection: requires source IP whitelist OR explicit operator opt-in (`admin.auth.allowAnyOrigin: true`)

**Tests:** header parsing + missing-header fallback + IP whitelist enforcement

**Why now:** simplest real provider. Establishes header-extraction pattern + spoofing-protection pattern that other providers reuse.

### Cut 4: `cloudflare-access` trust mode

**Files added:**
- `packages/gazetta/src/auth/providers/cloudflare-access.ts` — JWT verification via Cloudflare's JWKS endpoint
- `package.json` — add `jose` dependency for JWT validation

**Tests:** msw-mocked JWKS endpoint + valid signed JWT + expired JWT + missing kid + algorithm enforcement

**Why now:** first provider needing JWT verification. Riskiest crypto integration; landing it early surfaces issues.

### Cut 5: `azure-easy-auth`, `aws-cognito`, `tailscale` trust modes

**Files added:**
- `packages/gazetta/src/auth/providers/azure-easy-auth.ts` — base64-decodes `X-MS-CLIENT-PRINCIPAL`
- `packages/gazetta/src/auth/providers/aws-cognito.ts` — JWT validation for `x-amzn-oidc-data` (Cognito + ALB)
- `packages/gazetta/src/auth/providers/tailscale.ts` — reads `Tailscale-User-Login`

**Tests:** per-provider header parsing + provider-specific edge cases

**Why now:** provider proliferation after the JWT pattern is established. Each is small.

### Cut 6: Capability vocabulary + role aliases

**Files added:**
- `packages/gazetta/src/auth/capabilities.ts` — built-in capability constants (`READ_PAGES`, `EDIT_PAGES`, etc.)
- `packages/gazetta/src/auth/roles.ts` — built-in role aliases (`admin`, `editor`, `viewer`)
- `packages/gazetta/src/auth/role-resolver.ts` — `resolveRole(principal, siteConfig)` function

**Tests:** role resolution from group claims + custom role registration + role aliases expansion + reserved-prefix validation

**Why now:** static data structures; doesn't need a Principal yet. Can be tested in isolation.

### Cut 7: `Principal` request context + auth middleware

**Files added/modified:**
- `packages/gazetta/src/admin-api/middleware/auth.ts` — Hono middleware that calls `AuthIdentityProvider.extractPrincipal(req)`, attaches `Principal` to request context
- Hono app integration: middleware runs before all routes
- Request context type extension: `c.var.principal: Principal`

**Tests:** middleware integration + Principal injection + provider failure surfaces as 401

**Why now:** wires the auth layer into Hono. Required before capability checks can run.

### Cut 8: Capability-check middleware + 401 / 403 responses

**Files added:**
- `packages/gazetta/src/admin-api/middleware/capability.ts` — `requireCapability(cap)` middleware factory
- `packages/gazetta/src/admin-api/error-response.ts` — extend with `403 FORBIDDEN` + `401 UNAUTHENTICATED` shapes

**Tests:** capability check pass + 403 with `missing` field + 401 with `WWW-Authenticate` hint + admin role wildcard expansion

**Why now:** the enforcement layer. Routes can opt in incrementally in Cut 9.

### Cut 9: Wire all 10 admin-API routes with capability gates

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` — `requireCapability('read:pages')` on GET; `requireCapability('edit:pages')` on PUT/POST/DELETE
- Same pattern across `fragments.ts`, `assets.ts`, `compare.ts`, `fields.ts`, `history.ts`, `preview.ts`, `publish.ts`, `site.ts`, `templates.ts`

**Tests:** integration tests per route × per role (admin/editor/viewer) confirming 200 / 403 matrix

**Why now:** mechanical integration. Each route adds one middleware line.

### Cut 10: Trust-mode integration tests with real header fixtures

**Tests added:**
- `packages/gazetta/tests/auth-integration.test.ts` — fixture-driven; one test per trust mode × happy path + error cases
- Real-shape headers from each provider's docs (e.g., real Cloudflare Access JWT structure; real Azure `X-MS-CLIENT-PRINCIPAL` payload)

**Why now:** validates the design corpus matches real provider behavior. Catches "we read the header wrong" class of bugs.

### Cut 11: Docs

**Files added/modified:**
- `docs/auth.md` (NEW) — per-trust-mode operator setup guide
- `docs/cloudflare.md` — add Cloudflare Access section
- `docs/self-hosted.md` — add `forwarded-user` configuration
- `docs/operations.md` — extend with auth/RBAC operational concerns
- `examples/starter/site.config.ts` — example `admin.auth` block

**Why last:** code is stable; docs reflect reality.

## Validation gate (definition of done)

Cut 1-9 ship the implementation. Cut 10-11 are validation + docs. The foundation is "shipped" when:

- [ ] All 11 cuts merged
- [ ] Integration tests pass for all 6 trust modes
- [ ] `audit/` foundation (next in Phase 1) has at least one consumer of the `Principal` type — proves the contract works for downstream foundations
- [ ] Operator can configure auth for at least one trust mode following only the public docs

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Per-target roles (`editor` on staging, `viewer` on prod) | Concrete operator demand; capability vocabulary is forward-compatible |
| Per-page roles (path-pattern visibility filtering) | Concrete operator demand; `read:pages:{pattern}` extension is forward-compatible |
| Multi-role per principal | Rare in practice; complexity not justified yet |
| `admin.auth.strict: true` validation mode | After at least one operator hits ambiguity in custom-role definitions |
| Plugin-supplied trust modes (e.g., SAML, custom OAuth) | 3+ operator requests for unlisted platform within 6 months |

## Open implementation questions

1. **JWT validation library**: `jose` is a strong default (well-maintained; widely used; supports JWKS rotation). Confirm before Cut 4.
2. **Source-IP whitelist semantics**: `forwarded-user` mode needs operator config for trusted proxy IPs. Default behavior when whitelist empty: refuse all (fail-closed) vs. accept (fail-open with warning)? Recommend fail-closed.
3. **Role-mapping edge cases**: what if upstream returns multiple groups, multiple of which map to roles? Per Q2 lock (single role per principal), pick highest-priority match. Define priority order: array order in `map` config (first match wins).
4. **Boot-time config validation**: invalid role-mapping (e.g., custom role references unknown capability) — fail boot loudly per locked Q3 strict-mode-error vs. log-warning. Recommend fail boot in production; warn in dev.

## Test infrastructure

- **`@anthropic-ai/sdk`-style adapter pattern**: each trust mode's tests use msw to mock upstream auth provider responses. No real cloud calls in CI.
- **Real-shape fixtures**: capture one real-payload sample per provider in `tests/fixtures/auth/`. Update on provider format changes.
- **Per-cut tests independent**: each cut's tests don't depend on subsequent cuts.

## Estimates

Wall-clock for solo dev:

| Cut | Estimate |
|---|---|
| 1 (Infra) | 0.5 day |
| 2 (Provider interface + none) | 0.5 day |
| 3 (`forwarded-user`) | 1 day |
| 4 (`cloudflare-access` JWT) | 1.5 days |
| 5 (Azure + Cognito + Tailscale) | 1 day |
| 6 (Capabilities + roles) | 1 day |
| 7 (Request context + middleware) | 1 day |
| 8 (Capability middleware) | 0.5 day |
| 9 (Wire routes) | 1.5 days |
| 10 (Integration tests) | 1.5 days |
| 11 (Docs) | 1.5 days |

**Total: ~10-12 days.** With CI iteration + integration discoveries, budget ~2-2.5 weeks.

## SOLID checks per cut

- **Cut 1-2**: SRP per file (types / config / interface separated). DIP — consumers depend on `AuthIdentityProvider` interface, not concrete classes.
- **Cut 3-5**: LSP across trust-mode providers. Each provider has its own error type translating to `AuthError`. SRP — each provider owns one trust mode's mechanics.
- **Cut 6**: SRP — capability vocabulary in one file; role resolver is a separate function. OCP — adding a new capability is a constant + an enum entry.
- **Cut 7-8**: ISP — middleware factories produce narrow Hono middleware; one concern per factory.
- **Cut 9**: mechanical; no SOLID concerns beyond preserving route-handler purity.

Any cut failing SOLID review at PR time is a structural correction (per [team-preferences rule 18](team-preferences.md)), not a patch.

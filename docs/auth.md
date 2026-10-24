# Authentication and authorization

Gazetta's admin uses **upstream identity** + **role-based capability gates**. The platform fronting your admin (Cloudflare Access, Azure App Service Easy Auth, AWS ALB + Cognito, Tailscale, oauth2-proxy / Authelia / Caddy `forward_auth`, …) authenticates users; Gazetta reads the verified identity from request headers and matches each route to a capability the user's role grants.

Gazetta does not store passwords, issue JWTs, run OAuth flows, or display login screens. Auth is done before requests reach Gazetta.

## Quick start

The default is `none` — single-author / dev mode. Every request is granted the admin role; no auth is checked.

To opt in to upstream auth, add an `admin.auth` block to your `site.config.ts`:

```ts
import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: 'main',
  targets: {
    local: { storage: filesystemStorage(), environment: 'local', editable: true },
  },
  admin: {
    auth: {
      trust: 'cloudflare-access',
      teamDomain: 'acme', // your team domain at https://acme.cloudflareaccess.com
      audience: 'https://admin.example.com', // optional but strongly recommended
    },
  },
})
```

## Trust modes

Each trust mode tells Gazetta how to extract identity from the upstream layer's request shape.

### `none` (default)

Single-author / dev mode. Every request resolves to the canonical `unknown` principal with the admin role. Ignores all upstream headers — a misconfigured proxy can't leak identity into a `none`-mode deployment.

```ts
admin: { auth: { trust: 'none' } }
```

Or simply omit `admin.auth` entirely.

### `forwarded-user`

Generic reverse-proxy mode for deployments behind oauth2-proxy, Authelia, Caddy `forward_auth`, traefik ForwardAuth, etc. The upstream layer authenticates and sets:

- `X-Forwarded-User` (required) — opaque user id
- `X-Forwarded-Email` (optional)
- `X-Forwarded-Groups` (optional, comma-separated; reserved for future role-mapping)

**Source-IP whitelist is required.** The forwarded headers carry no signature; anything between the client and the proxy can set them. Gazetta rejects requests whose source IP is not in `trustedProxies`.

```ts
admin: {
  auth: {
    trust: 'forwarded-user',
    trustedProxies: ['10.0.0.0/8', 'fd00::/8'], // IPv4 + IPv6 CIDRs supported
  },
}
```

For dev environments or trusted private networks (Tailscale, internal VPNs):

```ts
admin: {
  auth: {
    trust: 'forwarded-user',
    allowAnyOrigin: true, // explicit opt-out of source-IP protection
  },
}
```

Without `trustedProxies` AND without `allowAnyOrigin`, admin boot fails — there's no safe default.

### `cloudflare-access`

Cloudflare Zero Trust / Access fronting the admin. Gazetta verifies the JWT in `Cf-Access-Jwt-Assertion` (or the `CF_Authorization` cookie) against Cloudflare's published JWKS.

```ts
admin: {
  auth: {
    trust: 'cloudflare-access',
    teamDomain: 'acme', // your team's subdomain at *.cloudflareaccess.com
    audience: 'https://admin.example.com', // optional but strongly recommended
  },
}
```

Setting `audience` prevents token replay across other Access-protected apps in the same team domain. Cloudflare Access automatic key rotation is handled by `jose`'s `createRemoteJWKSet`.

### `azure-easy-auth`

Azure App Service's built-in authentication ("Easy Auth"). The platform sandboxes the admin and populates `X-MS-CLIENT-PRINCIPAL` with a base64-encoded JSON description of the principal.

```ts
admin: { auth: { trust: 'azure-easy-auth' } }
```

The App Service sandbox is the trust boundary. **Do not run `gazetta serve` directly with this trust mode** — without the sandbox, anyone can set the header.

### `aws-cognito`

AWS Application Load Balancer fronting the admin with Cognito user pool authentication. The ALB injects a signed JWT in `x-amzn-oidc-data` against AWS's per-region public keys.

```ts
admin: {
  auth: {
    trust: 'aws-cognito',
    region: 'us-east-1',
    audience: 'cognito-app-client-id', // optional but recommended
  },
}
```

### `tailscale`

Tailscale Funnel / serve fronting the admin. Trust comes from the tailnet itself — only authenticated members can reach the listener.

```ts
admin: { auth: { trust: 'tailscale' } }
```

The header `Tailscale-User-Login` (e.g., `alice@example.ts.net`) carries the identity.

## Roles and capabilities

Roles are predefined capability sets. Each authenticated user gets exactly one role.

### Built-in roles

| Role | Capabilities |
|---|---|
| `admin` | `*` (everything) |
| `editor` | `read:*` + `edit:*` + `publish:non-production` |
| `viewer` | `read:*` |

Editor explicitly does NOT have `publish:production` or `delete:*` or `configure:site`.

### Capability vocabulary

| Domain | Capabilities |
|---|---|
| Read | `read:pages`, `read:fragments`, `read:assets`, `read:audit-log` |
| Edit | `edit:pages`, `edit:fragments`, `edit:assets`, `edit:locale-variants` |
| Delete | `delete:pages`, `delete:fragments`, `delete:assets` |
| Publish | `publish:non-production`, `publish:production` |
| Configure | `configure:site`, `configure:targets` |
| History | `restore:history` |
| Wildcards | `read:*`, `edit:*`, `delete:*`, `publish:*`, `*` |

### Custom roles

Operator-defined in `site.config.ts`:

```ts
admin: {
  auth: {
    trust: 'cloudflare-access',
    teamDomain: 'acme',
    roles: {
      translator: {
        capabilities: ['read:pages', 'read:fragments', 'read:assets', 'edit:locale-variants'],
      },
      auditor: {
        capabilities: ['read:*', 'read:audit-log'],
      },
    },
  },
}
```

Custom roles can't redefine built-in role names (`admin`, `editor`, `viewer`) — that's flagged at boot.

### Group-claim → role mapping

(Reserved for follow-up.) v1 ships with every authenticated user getting the configured `defaultRole` (currently `editor`). Future work threads upstream group claims through the role-resolver to map to roles.

## Failure modes

Gazetta returns structured responses on auth failures:

| Status | Body shape | When |
|---|---|---|
| `401 UNAUTHENTICATED` | `{ code, error }` + `WWW-Authenticate: Bearer realm="gazetta-admin"` | No identity (forwarded-user with missing header, JWT missing/expired/invalid signature, source IP not in whitelist) |
| `403 FORBIDDEN` | `{ code, missing: [cap], role, error }` | Authenticated principal lacks the capability the route requires |

Authenticated users see what they can't do (the `missing` capability + their `role`). Unauthenticated requests get the generic `WWW-Authenticate` hint pointing back at the upstream layer — Gazetta doesn't issue login challenges itself.

## Per-route capability matrix

Every `/api/*` route gates on a specific capability. The route → capability mapping:

| Routes | Capability |
|---|---|
| `GET /api/site`, `/api/pages*`, `/api/fragments*`, `/api/templates*`, `/api/fields`, `/api/compare`, `/api/history`, `/api/targets`, `/api/dependents` | `read:pages` (or scoped `read:fragments` / `read:assets`) |
| `POST/PUT /api/pages*`, `/api/fragments*` | `edit:pages` / `edit:fragments` |
| `DELETE /api/pages/*`, `/api/fragments/*` | `delete:pages` / `delete:fragments` |
| `GET /api/assets*` | `read:assets` |
| `POST/PATCH /api/assets*` | `edit:assets` |
| `DELETE /api/assets/:name` | `delete:assets` |
| `POST /api/history/{undo,restore}` | `restore:history` |
| `POST /api/publish*`, `/api/fetch` | `publish:non-production` (production-target enforcement is a follow-up) |
| `GET /api/system/cache/*` | `configure:site` |
| `GET /api/health` | (no gate; intentionally public) |

## Composing with the bearer-token guard

The legacy `GAZETTA_TOKEN` environment variable adds an `Authorization: Bearer <token>` check that runs before the principal middleware. It's orthogonal to upstream auth — useful for solo deployments or CI access tokens. Both can coexist (CI uses the bearer-token; humans go through Cloudflare Access).

```bash
GAZETTA_TOKEN=$(openssl rand -base64 32) gazetta serve
```

## Multi-instance correctness

- `Principal` is per-request; nothing is cached cross-request
- Role-mapping table loads from `site.config.ts` at boot; reread on `site.config.ts` change via the dev file watcher
- JWT verification uses `createRemoteJWKSet` which fetches + caches keys per-instance; rotations are picked up by each instance independently
- Source-IP whitelist parses once at boot; per-request matches are O(N) over already-parsed rules

## Operational notes

- **Boot fails fast** on misconfigured `admin.auth`. An invalid trust mode, missing required field (e.g., `cloudflare-access` without `teamDomain`), or missing `trustedProxies`-without-`allowAnyOrigin` for `forwarded-user` throws `AuthConfigurationError` before the admin starts serving.
- **JWT verification fails closed.** If Cloudflare's JWKS endpoint is unreachable, Gazetta returns 401 — does not let unsigned tokens through.
- **Logs do not include credentials.** Auth failure messages surface to the operator (admin-API audience) but never leak token contents.

/**
 * `forwarded-user` trust mode — generic reverse-proxy mode for
 * deployments fronted by oauth2-proxy, Authelia, Caddy
 * `forward_auth`, traefik's ForwardAuth middleware, etc.
 *
 * # Header contract
 *
 * The upstream layer authenticates the user, then sets:
 *
 *   - `X-Forwarded-User` (required) — the upstream subject; opaque
 *     to Gazetta, used as `Principal.id`
 *   - `X-Forwarded-Email` (optional) — surfaces in audit drawer +
 *     activity feed when present
 *   - `X-Forwarded-Groups` (optional) — comma-separated group list;
 *     consumed by the role-resolver via `roleMapping.claim: 'groups'`
 *
 * # Header-spoofing protection
 *
 * Per `design-auth-rbac.md` Q1: the headers above carry NO
 * authentication on their own — anything between the client and the
 * proxy can set them. The provider accepts them only on a connection
 * from an address in `trustedProxies` (the address the server's socket
 * reports, never one a header names), OR accepts everything when the
 * operator explicitly sets `allowAnyOrigin: true`.
 *
 * Default posture is fail-closed (no `trustedProxies` AND no
 * `allowAnyOrigin` → schema refines to invalid; operator can't
 * even start the admin without choosing). Per the locked open-Q
 * resolution: "Recommend fail-closed" for empty whitelist.
 *
 * # SOLID lenses
 *
 *   - SRP: header extraction only. Capability resolution,
 *     role-mapping, and request middleware are separate concerns.
 *   - LSP: same `AuthIdentityProvider` shape as `none` and future
 *     providers.
 *   - DIP: takes parsed config (a `ForwardedUserConfig`) — doesn't
 *     read from `site.config.ts` directly.
 */
import type { Principal, RoleMapping } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { AuthenticationError, AuthConfigurationError } from '../errors.js'
import { ipMatchesAny, type ParsedRule, parseRules } from '../ip-match.js'
import { expandRole } from '../capabilities.js'
import { resolveRole } from '../role-resolver.js'

export interface ForwardedUserConfig {
  /**
   * Addresses / CIDRs of the proxies in front of the admin; only
   * connections from them may set the forwarded headers. Empty (or
   * undefined) when `allowAnyOrigin: true`.
   * Validated at config-load.
   */
  trustedProxies?: readonly string[]
  /**
   * Explicit opt-out of source-IP protection. Required when
   * `trustedProxies` is empty. Use only in dev or trusted private
   * networks.
   */
  allowAnyOrigin?: boolean
  /**
   * Role assigned when no `roleMapping` is configured. When
   * `roleMapping` IS set, the resolved group → role mapping (and its
   * own `defaultRole`) takes over and this field is unused.
   */
  defaultRole?: string
  /**
   * Group → role mapping from `site.config.ts admin.auth`. The
   * upstream proxy populates the standard `X-Forwarded-Groups`
   * header (comma-separated); when set, that group list is resolved
   * to a Gazetta role instead of falling back to `defaultRole`. The
   * `roleMapping.claim` field is informational here — the header
   * name is fixed by the reverse-proxy convention.
   */
  roleMapping?: RoleMapping
  /**
   * Custom role declarations from `site.config.ts admin.auth.roles`,
   * flattened to `name → capabilities`. Consulted by the role
   * resolver when `roleMapping` points at a non-built-in role.
   */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
}

/**
 * Construct a `forwarded-user` provider. Validates `trustedProxies`
 * at construction (per Universal Provider Requirement #6 — config
 * errors throw; transport errors fail-open). Returned provider is
 * stateless after construction; safe to share across requests.
 */
export function createForwardedUserAuthProvider(config: ForwardedUserConfig): AuthIdentityProvider {
  // Pre-parse the trustedProxies list at construction so per-request
  // checks are O(N) over already-parsed rules. Throws AuthConfigurationError
  // at boot if any rule is malformed — operator sees the failure
  // before requests start arriving.
  let parsedRules: ParsedRule[] = []
  if (config.trustedProxies && config.trustedProxies.length > 0) {
    try {
      parsedRules = parseRules(config.trustedProxies)
    } catch (err) {
      throw new AuthConfigurationError(
        `Invalid trustedProxies entry: ${(err as Error).message}. Each entry must be an IP literal (e.g. "10.0.0.1") or CIDR (e.g. "10.0.0.0/8").`,
      )
    }
  }
  if (!config.allowAnyOrigin && parsedRules.length === 0) {
    // Schema-level refine should catch this, but defense-in-depth:
    // if a caller bypasses the schema (e.g., constructed by a plugin
    // with a wrong shape), surface the error at construction.
    throw new AuthConfigurationError(
      'forwarded-user trust mode requires trustedProxies (IP whitelist) OR allowAnyOrigin: true',
    )
  }

  const defaultRole = config.defaultRole ?? 'editor'

  return {
    trustMode: 'forwarded-user',
    async extractPrincipal(req: AuthRequest): Promise<Principal | null> {
      // Source-IP protection FIRST — before any header read. A
      // request from an untrusted source has its forwarded headers
      // ignored entirely; we treat it as if the headers weren't
      // set. Returning null lets the middleware decide between 401
      // (require auth) and synthetic anonymous (none-mode-style).
      // For forwarded-user we always require auth — middleware
      // surfaces this as 401.
      if (!config.allowAnyOrigin) {
        if (!req.peerAddress || !ipMatchesAny(req.peerAddress, parsedRules)) {
          throw new AuthenticationError(
            req.peerAddress
              ? `Request came from ${req.peerAddress}, which isn't in the configured trustedProxies`
              : "The connection's address is unknown, so the trusted-proxy check can't run",
          )
        }
      }

      const user = req.headers.get('x-forwarded-user')
      if (!user || user.length === 0) {
        // No identity header — anonymous. Middleware turns this
        // into 401.
        return null
      }

      const email = req.headers.get('x-forwarded-email') ?? undefined

      let role: string
      let capabilities: ReadonlyArray<string>
      if (config.roleMapping) {
        const groups = (req.headers.get('x-forwarded-groups') ?? '')
          .split(',')
          .map(g => g.trim())
          .filter(Boolean)
        const resolved = resolveRole({
          groups,
          mapping: config.roleMapping,
          customRoles: config.customRoles,
        })
        if (!resolved) {
          // Valid identity, but no group matched and no defaultRole
          // is configured — deny per design-auth-rbac.md's
          // "defaultRole: null means deny".
          throw new AuthenticationError(
            `forwarded-user principal "${user}" matched no role in roleMapping and no defaultRole is configured`,
          )
        }
        role = resolved.name
        capabilities = resolved.capabilities
      } else {
        role = defaultRole
        capabilities = expandRole(defaultRole) ?? []
      }

      return {
        id: user,
        email,
        role,
        trustMode: 'forwarded-user',
        capabilities,
      }
    },
  }
}

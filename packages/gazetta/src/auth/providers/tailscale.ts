/**
 * `tailscale` trust mode — Tailscale Serve fronting the admin on the
 * same machine. Serve terminates the connection, proxies it to the
 * admin on loopback, and adds identity headers from the authenticated
 * tailnet user (Funnel traffic carries none).
 *
 * # Only from the local Serve proxy
 *
 * Serve strips client-sent copies of these headers, but anyone who
 * reaches the admin some other way could set them (Tailscale's Serve
 * docs, "Identity headers"). So the provider accepts them only on a
 * loopback connection, the one Serve makes.
 *
 * # Headers
 *
 *   - `Tailscale-User-Login` (required) — username@tailnet.ts.net
 *   - `Tailscale-User-Profile-Pic` (optional) — profile picture URL
 *   - `Tailscale-User-Name` (optional) — display name
 *
 * The username is in the form `alice@example.ts.net`. We use the
 * full string as `id`; the email part (`alice`) is a per-tailnet
 * identifier — operators with multiple tailnets need the full form
 * to disambiguate.
 *
 * # Roles
 *
 * Serve sends no group information, so there is nothing for
 * `roleMapping` to map: it's refused, and every tailnet user gets
 * `defaultRole`. Who can reach the admin at all is the tailnet's
 * ACLs' job.
 *
 * # SOLID lenses
 *
 *   - SRP: header read plus the loopback check; no token to verify.
 *   - LSP: same `AuthIdentityProvider` shape.
 */
import type { Principal } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { expandRole } from '../capabilities.js'
import { TAILSCALE_ROLE_MAPPING_UNSUPPORTED } from '../config.js'
import { AuthConfigurationError, AuthenticationError } from '../errors.js'
import { isLoopbackAddress } from '../ip-match.js'

export interface TailscaleConfig {
  /** Role every tailnet user gets: a built-in role or one of `customRoles`. Default `editor`. */
  defaultRole?: string
  /**
   * Custom role declarations from `site.config.ts admin.auth.roles`,
   * flattened to `name → capabilities`, so `defaultRole` can name one.
   */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
}

export function createTailscaleAuthProvider(config: TailscaleConfig = {}): AuthIdentityProvider {
  // Callers that bypass the schema (programmatic config) get the same refusal.
  if ('roleMapping' in config && (config as { roleMapping?: unknown }).roleMapping !== undefined) {
    throw new AuthConfigurationError(TAILSCALE_ROLE_MAPPING_UNSUPPORTED)
  }
  const role = config.defaultRole ?? 'editor'
  const capabilities = expandRole(role, config.customRoles)
  if (!capabilities) {
    throw new AuthConfigurationError(
      `admin.auth.defaultRole "${role}" isn't a built-in role (admin, editor, viewer) or one declared in admin.auth.roles`,
    )
  }
  return {
    trustMode: 'tailscale',
    async extractPrincipal(req: AuthRequest): Promise<Principal | null> {
      const login = req.headers.get('tailscale-user-login')
      if (!login || login.length === 0) {
        // No tailscale identity — request bypassed Tailscale's
        // serve. Either the operator misconfigured, or a request
        // arrived through a different listener. Anonymous → 401.
        return null
      }
      if (!isLoopbackAddress(req.peerAddress)) {
        throw new AuthenticationError(
          req.peerAddress
            ? `Tailscale identity headers came on a connection from ${req.peerAddress}; they're accepted only from the local Tailscale Serve proxy`
            : "The connection's address is unknown, so the Tailscale identity headers can't be checked",
        )
      }

      // Tailscale-User-Login is shaped `user@tailnet.ts.net`.
      // We treat the whole string as id; operators wanting a
      // shorter display name can use the tailscale-user-name header
      // if present.
      return {
        id: login,
        // Tailscale's email-shaped login is functionally the user's
        // email for display purposes.
        email: login,
        role,
        trustMode: 'tailscale',
        capabilities,
      }
    },
  }
}

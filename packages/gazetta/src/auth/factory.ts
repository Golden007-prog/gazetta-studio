/**
 * `AuthIdentityProvider` factory — constructs the right provider
 * from the typed `admin.auth` block in `site.config.ts`.
 *
 * # Why a factory and not direct provider exports
 *
 * Operators write `admin.auth: { trust: 'cloudflare-access', teamDomain: 'acme' }`
 * in `site.config.ts`. The admin-api boot code receives this config
 * (typed as `AuthConfig`) and needs to dispatch to the right provider
 * factory. Centralizing the dispatch here keeps the built-in
 * trust-mode set closed (per `design-auth-rbac.md` Q1) while
 * leaving the operator-config field type open to any
 * `AuthIdentityProvider` instance — including those returned by
 * plugin-supplied factories.
 *
 * # Plugin promotion path
 *
 * Per ADR-0009 + `design-plugins.md`: external trust modes ship as
 * npm packages exporting a factory function returning
 * `AuthIdentityProvider`. The operator imports the factory and
 * assigns its result to `admin.auth` directly (Pattern A factory-
 * call-at-field). No runtime register method; no central registry
 * for plugin-contributed providers — the type system accepts any
 * conforming instance.
 *
 * # SOLID lenses
 *
 *   - SRP: dispatch only. Doesn't read from disk, doesn't construct
 *     middleware. Pure function over (config) → AuthIdentityProvider.
 *   - OCP: adding a trust mode is one new case in the switch + one
 *     import. Existing cases unchanged.
 *   - DIP: callers depend on AuthIdentityProvider, not on which
 *     trust mode the operator picked.
 */
import type { AuthIdentityProvider } from './provider.js'
import { AuthConfigSchema, type AuthConfig } from './config.js'
import { AuthConfigurationError } from './errors.js'
import { noneAuthProvider } from './providers/none.js'
import { createForwardedUserAuthProvider } from './providers/forwarded-user.js'
import { createCloudflareAccessAuthProvider } from './providers/cloudflare-access.js'
import { createAzureEasyAuthProvider } from './providers/azure-easy-auth.js'
import { createAwsCognitoAuthProvider } from './providers/aws-cognito.js'
import { createTailscaleAuthProvider } from './providers/tailscale.js'

/**
 * Flatten the `roles` block ({ name: { capabilities } }) onto the
 * `name → capabilities` map the role resolver consumes. Returns
 * undefined when no custom roles are declared.
 */
function flattenRoles(
  roles: Record<string, { capabilities: ReadonlyArray<string> }> | undefined,
): Readonly<Record<string, ReadonlyArray<string>>> | undefined {
  if (!roles) return undefined
  return Object.fromEntries(Object.entries(roles).map(([name, def]) => [name, def.capabilities]))
}

/**
 * Build the configured `AuthIdentityProvider`. Returns the
 * `none`-mode provider when `config` is undefined (the default
 * when `site.config.ts` has no `admin.auth` block).
 */
export function buildAuthProvider(config: AuthConfig | undefined): AuthIdentityProvider {
  if (!config) return noneAuthProvider

  switch (config.trust) {
    case 'none':
      return noneAuthProvider
    case 'forwarded-user':
      return createForwardedUserAuthProvider({
        trustedProxies: config.trustedProxies,
        allowAnyOrigin: config.allowAnyOrigin,
        roleMapping: config.roleMapping,
        customRoles: flattenRoles(config.roles),
      })
    case 'cloudflare-access':
      return createCloudflareAccessAuthProvider({
        teamDomain: config.teamDomain,
        audience: config.audience,
        roleMapping: config.roleMapping,
        customRoles: flattenRoles(config.roles),
      })
    case 'azure-easy-auth':
      return createAzureEasyAuthProvider({
        roleMapping: config.roleMapping,
        customRoles: flattenRoles(config.roles),
      })
    case 'aws-cognito':
      return createAwsCognitoAuthProvider({
        region: config.region,
        albArn: config.albArn,
        audience: config.audience,
        roleMapping: config.roleMapping,
        customRoles: flattenRoles(config.roles),
      })
    case 'tailscale':
      return createTailscaleAuthProvider({
        roleMapping: config.roleMapping,
        customRoles: flattenRoles(config.roles),
      })
    default: {
      // Exhaustive check — the discriminated union should make
      // this unreachable, but defense-in-depth against an operator
      // bypassing the schema (e.g., constructing the manifest
      // programmatically).
      const exhaustiveCheck: never = config
      throw new AuthConfigurationError(`Unknown trust mode in admin.auth: ${JSON.stringify(exhaustiveCheck)}`)
    }
  }
}

/**
 * Strict-parse the operator's `admin.auth` block (loose-record in the
 * SiteManifest schema) and dispatch to `buildAuthProvider`. Centralizes
 * the parse-and-dispatch logic so admin-api boot and CLI-side mounts
 * (e.g., `mountValidationSse`'s gate) share one resolution path —
 * preventing the same SSE route from being gated against a different
 * `AuthIdentityProvider` than the rest of `/api/*`.
 *
 * Returns the `none`-mode provider when the raw block is absent.
 * Throws `AuthConfigurationError` on malformed config (matches the
 * fail-loud-at-boot posture from `design-auth-rbac.md`).
 */
export function resolveAuthProviderFromManifest(rawAuthBlock: unknown): AuthIdentityProvider {
  if (rawAuthBlock === undefined) return buildAuthProvider(undefined)
  const parsed = AuthConfigSchema.safeParse(rawAuthBlock)
  if (!parsed.success) {
    throw new AuthConfigurationError(
      `Invalid admin.auth block in site.config.ts: ${parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    )
  }
  return buildAuthProvider(parsed.data)
}

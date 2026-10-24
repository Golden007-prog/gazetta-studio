/**
 * `AuthIdentityProvider` — the seam between Gazetta and upstream
 * authentication.
 *
 * # The contract
 *
 * Each provider knows how to extract a `Principal` from one trust
 * mode's request shape. The `extractPrincipal(req)` method is
 * synchronous-or-async; the auth middleware awaits it and attaches
 * the result to the Hono request context.
 *
 * # Error semantics
 *
 *   - Returns `null` when the request has no identity (anonymous,
 *     no upstream auth applied) — the middleware decides whether to
 *     reject (401) or grant the `unknown` principal based on the
 *     trust mode
 *   - Throws `AuthenticationError` when the identity is corrupt
 *     (signature verification failed, header malformed)
 *   - Never throws on transport errors (per Universal Provider
 *     Requirement #5 — fail-open) — JWKS fetch failures fall back
 *     to fail-closed reject with a structured log
 *
 * # Why a registered factory pattern
 *
 * Trust modes are operator-configurable in `site.config.ts`. The
 * dispatcher reads `admin.auth.trust` and constructs the matching
 * provider. Plugin promotion (per ADR-0009 + `design-plugins.md`):
 * external trust modes ship as npm packages exporting a factory
 * function returning `AuthIdentityProvider`; operators import the
 * factory and assign the result to `admin.auth` directly. No
 * runtime register method.
 *
 * # SOLID lenses
 *
 *   - SRP: each provider owns one trust mode's mechanics; doesn't
 *     read config, doesn't dispatch, doesn't wire middleware.
 *   - LSP: every provider satisfies the same interface; consumers
 *     branch only on `provider.trustMode` for diagnostics, never
 *     for behavior.
 *   - DIP: middleware depends on this interface, not on concrete
 *     classes.
 *   - ISP: interface stays narrow — name + extract function. No
 *     capability-detection methods every provider must stub out.
 */
import type { Principal, TrustMode } from './types.js'

/**
 * Minimal request shape the provider needs. We don't depend on Hono
 * directly here so providers can be unit-tested with synthetic
 * requests; the middleware adapts the Hono request before calling.
 */
export interface AuthRequest {
  /** Map of header name → value. Header names are lowercased per HTTP convention. */
  headers: ReadonlyMap<string, string>
  /**
   * Client IP as request headers name it (`CF-Connecting-IP`,
   * `X-Real-IP`, `X-Forwarded-For`). The client controls these, so
   * it's for recording only; access decisions use `peerAddress`.
   */
  sourceIp?: string
  /**
   * Address of the connection the request arrived on (the client, or
   * the proxy in front of the admin), as the server's socket reports
   * it. Never taken from headers. Undefined when the runtime doesn't
   * expose it.
   */
  peerAddress?: string
  /** Method + URL — providers rarely need these, but available. */
  method?: string
  url?: string
}

/**
 * The provider contract. Trust-mode-specific implementations live
 * under `auth/providers/`.
 */
export interface AuthIdentityProvider {
  /** Identifies the trust mode this provider implements. */
  readonly trustMode: TrustMode
  /**
   * Pull identity from the request. Returns `null` when no identity
   * is present (anonymous request); throws `AuthenticationError` for
   * corrupted credentials. Configuration errors surface at provider
   * construction, not here.
   */
  extractPrincipal(req: AuthRequest): Promise<Principal | null>
}

/**
 * `aws-cognito` trust mode — AWS Application Load Balancer fronting
 * the admin with Cognito user pool authentication. ALB injects a
 * signed JWT in the `x-amzn-oidc-data` header containing the
 * authenticated user's claims.
 *
 * # Why JWT verification (just like cloudflare-access)
 *
 * The ALB-issued token is signed with AWS's per-region key. Verifying
 * the signature is the security contract — without it, anyone behind
 * the LB or with header-injection access can forge identity.
 *
 * # JWKS endpoint shape
 *
 * AWS publishes the verification keys at:
 *
 *     https://public-keys.auth.elb.{region}.amazonaws.com/{kid}
 *
 * Unlike Cloudflare's single-JWKS endpoint, AWS's endpoint is keyed
 * by the JWT header's `kid`. jose's `createRemoteJWKSet` doesn't fit
 * this shape; we wire a custom `JWTVerifyGetKey` that fetches the
 * specific kid. The `jwksFactory` injection point makes this pluggable
 * for tests.
 *
 * # SOLID lenses
 *
 *   - SRP: same as cloudflare-access — JWT verification only.
 *   - LSP: same `AuthIdentityProvider` shape.
 *   - DIP: jwksFactory injection point lets tests run without HTTP.
 */
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { Principal, RoleMapping } from '../types.js'
import type { AuthIdentityProvider, AuthRequest } from '../provider.js'
import { AuthenticationError, AuthConfigurationError } from '../errors.js'
import { expandRole } from '../capabilities.js'
import { resolveRole } from '../role-resolver.js'

export interface AwsCognitoConfig {
  /**
   * AWS region the ALB runs in. Required to construct the JWKS URL
   * (`public-keys.auth.elb.{region}.amazonaws.com`).
   */
  region: string
  /**
   * ARN of the load balancer (or load balancers) in front of the admin.
   * Every ALB in a region signs with keys from the same endpoint, so the
   * token header's `signer` must name one of these (AWS's documented check).
   */
  albArn: string | ReadonlyArray<string>
  /**
   * Optional `aud` claim — Cognito user-pool app client id. Setting
   * this prevents token replay across other Cognito-protected apps
   * sharing the same user pool.
   */
  audience?: string
  /**
   * Role assigned when no `roleMapping` is configured. When
   * `roleMapping` IS set, the resolved group → role mapping (and its
   * own `defaultRole`) takes over and this field is unused.
   */
  defaultRole?: string
  /**
   * Group → role mapping from `site.config.ts admin.auth`. The
   * verified JWT's group list (read from the claim named by
   * `roleMapping.claim`, typically `cognito:groups`) is resolved to a
   * Gazetta role instead of falling back to `defaultRole`.
   */
  roleMapping?: RoleMapping
  /**
   * Custom role declarations from `site.config.ts admin.auth.roles`,
   * flattened to `name → capabilities`. Consulted by the role
   * resolver when `roleMapping` points at a non-built-in role.
   */
  customRoles?: Readonly<Record<string, ReadonlyArray<string>>>
  /**
   * Internal: factory for the JWKS verifier. Tests inject a stub.
   * Production builds a fetch-based key resolver per AWS's
   * keyed-by-kid endpoint shape.
   */
  jwksFactory?: (region: string) => JWTVerifyGetKey
}

interface CognitoClaims extends JWTPayload {
  email?: string
  username?: string
  /** Cognito user-pool group claim. */
  'cognito:groups'?: string[]
}

/**
 * Upper bound on cached ALB public keys (#1402). An ALB key never
 * changes for a given kid, so entries need no expiry; the bound only
 * stops the map from growing by one entry per kid seen for the
 * process's lifetime. 16 covers a multi-ALB fleet with headroom;
 * eviction is LRU, so a burst of unknown kids can't flush the keys
 * steady traffic actually verifies against.
 */
export const AWS_COGNITO_KEY_CACHE_MAX = 16

/**
 * Default JWKS factory — fetches AWS's per-kid public key. Each
 * verification call may hit a different kid; the resolver caches
 * downloaded keys (bounded, LRU) to keep verification fast under
 * steady load.
 *
 * Operators may want to override this with a `createRemoteJWKSet`
 * variant if they front Cognito directly (without ALB) — that's
 * outside Cut 5's scope; the injection point keeps it open.
 */
export function defaultJwksFactory(region: string): JWTVerifyGetKey {
  const cache = new Map<string, CryptoKey>()
  return async (header: { kid?: string; alg?: string }) => {
    if (!header.kid) {
      throw new AuthenticationError('AWS Cognito JWT has no kid in header')
    }
    const cached = cache.get(header.kid)
    if (cached) {
      // Refresh recency: Map iteration order is insertion order.
      cache.delete(header.kid)
      cache.set(header.kid, cached)
      return cached
    }
    const url = `https://public-keys.auth.elb.${region}.amazonaws.com/${encodeURIComponent(header.kid)}`
    const res = await fetch(url)
    if (!res.ok) {
      throw new AuthenticationError(`AWS public-keys endpoint returned ${res.status} for kid ${header.kid}`)
    }
    const pem = await res.text()
    // Defer to Web Crypto's importKey via jose — actually jose
    // accepts CryptoKey directly. We use Node's crypto subtle to
    // import the PEM. This works in Node 22+ which has full WebCrypto.
    const subtle = (globalThis.crypto ?? require('node:crypto').webcrypto).subtle
    const key = await subtle.importKey(
      'spki',
      pemToDer(pem),
      { name: 'ECDSA', namedCurve: header.alg === 'ES512' ? 'P-521' : 'P-256' },
      false,
      ['verify'],
    )
    cache.set(header.kid, key)
    if (cache.size > AWS_COGNITO_KEY_CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return key
  }
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '')
  const bin = Buffer.from(body, 'base64')
  return bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
}

export function createAwsCognitoAuthProvider(config: AwsCognitoConfig): AuthIdentityProvider {
  if (!config.region || config.region.length === 0) {
    throw new AuthConfigurationError('aws-cognito trust mode requires region (e.g. "us-east-1")')
  }
  if (!/^[a-z]{2}-[a-z]+-\d+$/.test(config.region)) {
    throw new AuthConfigurationError(
      `Invalid region "${config.region}": expected AWS region format like "us-east-1" or "eu-west-2"`,
    )
  }

  const albArns = new Set(typeof config.albArn === 'string' ? [config.albArn] : (config.albArn ?? []))
  if (albArns.size === 0 || [...albArns].some(arn => !arn)) {
    throw new AuthConfigurationError(
      'aws-cognito trust mode requires albArn: the ARN of the load balancer in front of the admin',
    )
  }
  const jwks = (config.jwksFactory ?? defaultJwksFactory)(config.region)
  const defaultRole = config.defaultRole ?? 'editor'

  return {
    trustMode: 'aws-cognito',
    async extractPrincipal(req: AuthRequest): Promise<Principal | null> {
      const token = req.headers.get('x-amzn-oidc-data')
      if (!token) return null

      let payload: CognitoClaims
      let header: { signer?: unknown; exp?: unknown }
      try {
        const result = await jwtVerify<CognitoClaims>(token, jwks, {
          audience: config.audience,
        })
        payload = result.payload
        header = result.protectedHeader as { signer?: unknown; exp?: unknown }
      } catch (err) {
        throw new AuthenticationError(`AWS Cognito JWT verification failed: ${(err as Error).message}`)
      }
      // The ALB puts its own ARN and the token's expiry in the header.
      if (typeof header.signer !== 'string' || !albArns.has(header.signer)) {
        throw new AuthenticationError('AWS Cognito JWT was not signed by the configured load balancer (albArn)')
      }
      if (typeof header.exp !== 'number' || header.exp <= Math.floor(Date.now() / 1000)) {
        throw new AuthenticationError('AWS Cognito JWT has expired')
      }

      const id = payload.sub ?? payload.username
      if (!id) {
        throw new AuthenticationError('AWS Cognito JWT has no sub or username claim')
      }

      let role: string
      let capabilities: ReadonlyArray<string>
      if (config.roleMapping) {
        const groups = extractStringArray(payload[config.roleMapping.claim])
        const resolved = resolveRole({
          groups,
          mapping: config.roleMapping,
          customRoles: config.customRoles,
        })
        if (!resolved) {
          throw new AuthenticationError(
            `AWS Cognito principal "${id}" matched no role in roleMapping and no defaultRole is configured`,
          )
        }
        role = resolved.name
        capabilities = resolved.capabilities
      } else {
        role = defaultRole
        capabilities = expandRole(defaultRole) ?? []
      }

      return {
        id,
        email: payload.email,
        role,
        trustMode: 'aws-cognito',
        capabilities,
      }
    },
  }
}

/**
 * Coerce an arbitrary JWT claim value into a clean `string[]`. The
 * group claim is operator-named and operator-populated, so its shape
 * isn't guaranteed — a missing claim, a scalar, or a mixed array all
 * degrade to "no groups" rather than throwing.
 */
function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

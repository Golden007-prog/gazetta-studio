/**
 * Role resolution wiring for the four auth providers that previously
 * hardcoded `defaultRole` and never consulted the operator's
 * `roleMapping`: forwarded-user, azure-easy-auth, aws-cognito,
 * tailscale (#414). Mirrors the role-resolution block added to
 * cloudflare-access in #412.
 *
 * Per-provider matrix:
 *   - roleMapping match → resolved role + capabilities
 *   - roleMapping no-match + mapping.defaultRole → fallback role
 *   - roleMapping no-match + no defaultRole → AuthenticationError (deny)
 *   - customRoles → custom role resolution
 *   - no roleMapping → constructor defaultRole (back-compat; passes
 *     before AND after the fix)
 *
 * Group sources differ per provider — see each block's comment.
 */
import { describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import {
  AuthenticationError,
  buildAuthProvider,
  createAwsCognitoAuthProvider,
  createAzureEasyAuthProvider,
  createForwardedUserAuthProvider,
} from '../src/auth/index.js'
import type { AuthRequest } from '../src/auth/provider.js'

function reqOf(headers: Record<string, string>, peerAddress?: string): AuthRequest {
  const map = new Map<string, string>()
  for (const [k, v] of Object.entries(headers)) map.set(k.toLowerCase(), v)
  return { headers: map, peerAddress }
}

/** Tailscale Serve's connection to the admin on the same machine. */
const LOCAL_SERVE = '127.0.0.1'

// --- forwarded-user: groups from X-Forwarded-Groups -----------------

describe('forwarded-user role resolution (#414)', () => {
  it('resolves role from X-Forwarded-Groups when roleMapping matches', async () => {
    const provider = createForwardedUserAuthProvider({
      allowAnyOrigin: true,
      roleMapping: { claim: 'groups', map: { 'fwd-admins': 'admin' }, defaultRole: 'viewer' },
    })
    const principal = await provider.extractPrincipal(
      reqOf({ 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'fwd-admins,fwd-other' }),
    )
    expect(principal!.role).toBe('admin')
    expect(principal!.capabilities).toContain('*')
  })

  it('falls back to mapping.defaultRole when no group matches', async () => {
    const provider = createForwardedUserAuthProvider({
      allowAnyOrigin: true,
      roleMapping: { claim: 'groups', map: { 'fwd-admins': 'admin' }, defaultRole: 'viewer' },
    })
    const principal = await provider.extractPrincipal(
      reqOf({ 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'unmapped' }),
    )
    expect(principal!.role).toBe('viewer')
  })

  it('denies (throws) when no group matches and mapping has no defaultRole', async () => {
    const provider = createForwardedUserAuthProvider({
      allowAnyOrigin: true,
      roleMapping: { claim: 'groups', map: { 'fwd-admins': 'admin' } },
    })
    await expect(
      provider.extractPrincipal(reqOf({ 'x-forwarded-user': 'bob', 'x-forwarded-groups': 'unmapped' })),
    ).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('resolves a custom role supplied via customRoles', async () => {
    const provider = createForwardedUserAuthProvider({
      allowAnyOrigin: true,
      roleMapping: { claim: 'groups', map: { 'fwd-translators': 'translator' }, defaultRole: 'viewer' },
      customRoles: { translator: ['read:pages', 'edit:locale-variants'] },
    })
    const principal = await provider.extractPrincipal(
      reqOf({ 'x-forwarded-user': 'carol', 'x-forwarded-groups': 'fwd-translators' }),
    )
    expect(principal!.role).toBe('translator')
    expect(principal!.capabilities).toEqual(['read:pages', 'edit:locale-variants'])
  })

  it('without roleMapping, falls back to constructor defaultRole (back-compat)', async () => {
    const provider = createForwardedUserAuthProvider({ allowAnyOrigin: true, defaultRole: 'viewer' })
    const principal = await provider.extractPrincipal(
      reqOf({ 'x-forwarded-user': 'dave', 'x-forwarded-groups': 'ignored' }),
    )
    expect(principal!.role).toBe('viewer')
  })
})

// --- azure-easy-auth: groups from claims where typ === claim --------

describe('azure-easy-auth role resolution (#414)', () => {
  const NAMEID = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'

  function azureReq(claims: Array<{ typ: string; val: string }>): AuthRequest {
    const encoded = Buffer.from(
      JSON.stringify({ auth_typ: 'aad', name_typ: '', role_typ: '', claims }),
      'utf-8',
    ).toString('base64')
    return reqOf({ 'x-ms-client-principal': encoded })
  }

  it('resolves role from the claim named by roleMapping.claim (typ match)', async () => {
    const provider = createAzureEasyAuthProvider({
      roleMapping: { claim: 'roles', map: { 'az-admins': 'admin' }, defaultRole: 'viewer' },
    })
    const principal = await provider.extractPrincipal(
      azureReq([
        { typ: NAMEID, val: 'azure-user' },
        { typ: 'roles', val: 'az-admins' },
      ]),
    )
    expect(principal!.role).toBe('admin')
    expect(principal!.capabilities).toContain('*')
  })

  it('matches against multiple role claims (Azure emits one claim per group)', async () => {
    // Mapped role differs from the constructor default ('editor') so a
    // provider that ignores roleMapping fails this assertion.
    const provider = createAzureEasyAuthProvider({
      roleMapping: { claim: 'roles', map: { 'az-editors': 'admin' }, defaultRole: 'viewer' },
    })
    const principal = await provider.extractPrincipal(
      azureReq([
        { typ: NAMEID, val: 'azure-user' },
        { typ: 'roles', val: 'az-readers' },
        { typ: 'roles', val: 'az-editors' },
      ]),
    )
    expect(principal!.role).toBe('admin')
  })

  it('denies (throws) when no role claim matches and mapping has no defaultRole', async () => {
    const provider = createAzureEasyAuthProvider({
      roleMapping: { claim: 'roles', map: { 'az-admins': 'admin' } },
    })
    await expect(
      provider.extractPrincipal(
        azureReq([
          { typ: NAMEID, val: 'azure-user' },
          { typ: 'roles', val: 'unmapped' },
        ]),
      ),
    ).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('without roleMapping, falls back to constructor defaultRole (back-compat)', async () => {
    const provider = createAzureEasyAuthProvider({ defaultRole: 'viewer' })
    const principal = await provider.extractPrincipal(azureReq([{ typ: NAMEID, val: 'azure-user' }]))
    expect(principal!.role).toBe('viewer')
  })
})

// --- aws-cognito: groups from the JWT claim named by roleMapping ----

describe('aws-cognito role resolution (#414)', () => {
  const ALB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/gazetta/50dc6c495c0c9188'
  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwksFactory: () => JWTVerifyGetKey = () => async () => publicKey
    return { privateKey, jwksFactory }
  }

  function sign(privateKey: CryptoKey, claims: JWTPayload): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', signer: ALB_ARN, exp: Math.floor(Date.now() / 1000) + 300 })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
  }

  it('resolves role from cognito:groups via roleMapping', async () => {
    const { privateKey, jwksFactory } = await setup()
    const token = await sign(privateKey, { sub: 'u', 'cognito:groups': ['cog-admins'] })
    const provider = createAwsCognitoAuthProvider({
      region: 'us-east-1',
      albArn: ALB_ARN,
      jwksFactory,
      roleMapping: { claim: 'cognito:groups', map: { 'cog-admins': 'admin' }, defaultRole: 'viewer' },
    })
    const principal = await provider.extractPrincipal(reqOf({ 'x-amzn-oidc-data': token }))
    expect(principal!.role).toBe('admin')
    expect(principal!.capabilities).toContain('*')
  })

  it('falls back to mapping.defaultRole when no group matches', async () => {
    const { privateKey, jwksFactory } = await setup()
    const token = await sign(privateKey, { sub: 'u', 'cognito:groups': ['unmapped'] })
    const provider = createAwsCognitoAuthProvider({
      region: 'us-east-1',
      albArn: ALB_ARN,
      jwksFactory,
      roleMapping: { claim: 'cognito:groups', map: { 'cog-admins': 'admin' }, defaultRole: 'viewer' },
    })
    const principal = await provider.extractPrincipal(reqOf({ 'x-amzn-oidc-data': token }))
    expect(principal!.role).toBe('viewer')
  })

  it('denies (throws) when no group matches and mapping has no defaultRole', async () => {
    const { privateKey, jwksFactory } = await setup()
    const token = await sign(privateKey, { sub: 'u', 'cognito:groups': ['unmapped'] })
    const provider = createAwsCognitoAuthProvider({
      region: 'us-east-1',
      albArn: ALB_ARN,
      jwksFactory,
      roleMapping: { claim: 'cognito:groups', map: { 'cog-admins': 'admin' } },
    })
    await expect(provider.extractPrincipal(reqOf({ 'x-amzn-oidc-data': token }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('resolves a custom role supplied via customRoles', async () => {
    const { privateKey, jwksFactory } = await setup()
    const token = await sign(privateKey, { sub: 'u', 'cognito:groups': ['cog-translators'] })
    const provider = createAwsCognitoAuthProvider({
      region: 'us-east-1',
      albArn: ALB_ARN,
      jwksFactory,
      roleMapping: { claim: 'cognito:groups', map: { 'cog-translators': 'translator' }, defaultRole: 'viewer' },
      customRoles: { translator: ['read:pages', 'edit:locale-variants'] },
    })
    const principal = await provider.extractPrincipal(reqOf({ 'x-amzn-oidc-data': token }))
    expect(principal!.role).toBe('translator')
    expect(principal!.capabilities).toEqual(['read:pages', 'edit:locale-variants'])
  })

  it('without roleMapping, falls back to constructor defaultRole (back-compat)', async () => {
    const { privateKey, jwksFactory } = await setup()
    const token = await sign(privateKey, { sub: 'u', 'cognito:groups': ['ignored'] })
    const provider = createAwsCognitoAuthProvider({
      region: 'us-east-1',
      albArn: ALB_ARN,
      jwksFactory,
      defaultRole: 'viewer',
    })
    const principal = await provider.extractPrincipal(reqOf({ 'x-amzn-oidc-data': token }))
    expect(principal!.role).toBe('viewer')
  })
})

// --- factory threads roleMapping + flattened roles ------------------
//
// aws-cognito's factory arm is the same passthrough shape but needs a
// real JWKS to verify a token end-to-end, so it's covered by direct
// construction above; the non-crypto providers exercise the factory
// path here.

describe('factory threads roleMapping into the providers (#414)', () => {
  it('forwarded-user: buildAuthProvider passes roleMapping + flattened roles', async () => {
    const provider = buildAuthProvider({
      trust: 'forwarded-user',
      allowAnyOrigin: true,
      roleMapping: { claim: 'groups', map: { 'g-translators': 'translator' }, defaultRole: 'viewer' },
      roles: { translator: { capabilities: ['read:pages', 'edit:locale-variants'] } },
    })
    const principal = await provider.extractPrincipal(
      reqOf({ 'x-forwarded-user': 'alice', 'x-forwarded-groups': 'g-translators' }),
    )
    expect(principal!.role).toBe('translator')
    expect(principal!.capabilities).toEqual(['read:pages', 'edit:locale-variants'])
  })

  it('azure-easy-auth: buildAuthProvider passes roleMapping', async () => {
    const provider = buildAuthProvider({
      trust: 'azure-easy-auth',
      roleMapping: { claim: 'roles', map: { 'az-admins': 'admin' }, defaultRole: 'viewer' },
    })
    const encoded = Buffer.from(
      JSON.stringify({
        auth_typ: 'aad',
        name_typ: '',
        role_typ: '',
        claims: [
          { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier', val: 'u' },
          { typ: 'roles', val: 'az-admins' },
        ],
      }),
      'utf-8',
    ).toString('base64')
    const principal = await provider.extractPrincipal(reqOf({ 'x-ms-client-principal': encoded }))
    expect(principal!.role).toBe('admin')
  })

  it('tailscale: buildAuthProvider passes defaultRole', async () => {
    const provider = buildAuthProvider({ trust: 'tailscale', defaultRole: 'viewer' })
    const principal = await provider.extractPrincipal(
      reqOf({ 'tailscale-user-login': 'alice@example.ts.net' }, LOCAL_SERVE),
    )
    expect(principal!.role).toBe('viewer')
  })
})

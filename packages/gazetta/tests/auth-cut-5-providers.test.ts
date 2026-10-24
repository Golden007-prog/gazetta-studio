/**
 * Cut 5 tests: azure-easy-auth + aws-cognito + tailscale providers.
 *
 * Each provider's contract is small enough to keep tests in a single
 * file. The patterns from earlier cuts (header presence → null,
 * config validation, AuthenticationError on malformed input) repeat;
 * tests pin the provider-specific shape (Azure's base64+JSON+claims
 * indirection, ALB JWT verification, Tailscale's header read, accepted
 * only from the local Serve proxy).
 */
import { describe, expect, it } from 'vitest'
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose'
import {
  AuthConfigSchema,
  AuthConfigurationError,
  AuthenticationError,
  createAzureEasyAuthProvider,
  createAwsCognitoAuthProvider,
  createTailscaleAuthProvider,
} from '../src/auth/index.js'
import type { AuthRequest } from '../src/auth/provider.js'

function makeReq(headers: Record<string, string> = {}): AuthRequest {
  const map = new Map<string, string>()
  for (const [k, v] of Object.entries(headers)) map.set(k.toLowerCase(), v)
  return { headers: map }
}

// --- azure-easy-auth ----------------------------------------------

describe('AuthConfigSchema — azure-easy-auth (Cut 5)', () => {
  it('accepts trust: azure-easy-auth with no other fields', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'azure-easy-auth' })
    expect(r.success).toBe(true)
  })

  it('accepts trust: azure-easy-auth with roleMapping', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'azure-easy-auth',
      roleMapping: { claim: 'roles', map: { admin: 'admin' } },
    })
    expect(r.success).toBe(true)
  })
})

describe('createAzureEasyAuthProvider (Cut 5)', () => {
  // Build a base64-encoded X-MS-CLIENT-PRINCIPAL fixture matching
  // Azure App Service's documented shape.
  function encodeAzurePrincipal(claims: Array<{ typ: string; val: string }>): string {
    const json = JSON.stringify({ auth_typ: 'aad', name_typ: '', role_typ: '', claims })
    return Buffer.from(json, 'utf-8').toString('base64')
  }

  it('returns null when X-MS-CLIENT-PRINCIPAL is absent (anonymous)', async () => {
    const provider = createAzureEasyAuthProvider()
    const principal = await provider.extractPrincipal(makeReq())
    expect(principal).toBeNull()
  })

  it('returns Principal with id from nameidentifier claim', async () => {
    const provider = createAzureEasyAuthProvider()
    const encoded = encodeAzurePrincipal([
      { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier', val: 'azure-user-1' },
      { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress', val: 'alice@contoso.com' },
    ])
    const principal = await provider.extractPrincipal(makeReq({ 'X-MS-CLIENT-PRINCIPAL': encoded }))
    expect(principal!.id).toBe('azure-user-1')
    expect(principal!.email).toBe('alice@contoso.com')
    expect(principal!.trustMode).toBe('azure-easy-auth')
  })

  it('prefers X-MS-CLIENT-PRINCIPAL-ID over nameidentifier claim when both present', async () => {
    const provider = createAzureEasyAuthProvider()
    const encoded = encodeAzurePrincipal([
      { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier', val: 'claim-id' },
    ])
    const principal = await provider.extractPrincipal(
      makeReq({
        'X-MS-CLIENT-PRINCIPAL': encoded,
        'X-MS-CLIENT-PRINCIPAL-ID': 'header-id',
      }),
    )
    expect(principal!.id).toBe('header-id')
  })

  it('throws on malformed base64', async () => {
    const provider = createAzureEasyAuthProvider()
    await expect(
      provider.extractPrincipal(makeReq({ 'X-MS-CLIENT-PRINCIPAL': 'not%%%base64' })),
    ).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('throws on base64 of non-JSON', async () => {
    const provider = createAzureEasyAuthProvider()
    const encoded = Buffer.from('definitely not json', 'utf-8').toString('base64')
    await expect(provider.extractPrincipal(makeReq({ 'X-MS-CLIENT-PRINCIPAL': encoded }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('throws when claims array is missing', async () => {
    const provider = createAzureEasyAuthProvider()
    const encoded = Buffer.from(JSON.stringify({ auth_typ: 'aad' }), 'utf-8').toString('base64')
    await expect(provider.extractPrincipal(makeReq({ 'X-MS-CLIENT-PRINCIPAL': encoded }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('throws when neither nameidentifier claim nor X-MS-CLIENT-PRINCIPAL-ID is present', async () => {
    const provider = createAzureEasyAuthProvider()
    const encoded = encodeAzurePrincipal([{ typ: 'unrelated', val: 'x' }])
    await expect(provider.extractPrincipal(makeReq({ 'X-MS-CLIENT-PRINCIPAL': encoded }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('respects custom defaultRole', async () => {
    const provider = createAzureEasyAuthProvider({ defaultRole: 'viewer' })
    const encoded = encodeAzurePrincipal([
      { typ: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier', val: 'u1' },
    ])
    const principal = await provider.extractPrincipal(makeReq({ 'X-MS-CLIENT-PRINCIPAL': encoded }))
    expect(principal!.role).toBe('viewer')
  })
})

// --- aws-cognito --------------------------------------------------

const ALB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/gazetta/50dc6c495c0c9188'
const inFiveMinutes = () => Math.floor(Date.now() / 1000) + 300

describe('AuthConfigSchema — aws-cognito (Cut 5)', () => {
  it('accepts a valid AWS region', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'aws-cognito', region: 'us-east-1', albArn: ALB_ARN })
    expect(r.success).toBe(true)
  })

  it('accepts EU regions', () => {
    expect(AuthConfigSchema.safeParse({ trust: 'aws-cognito', region: 'eu-west-2', albArn: ALB_ARN }).success).toBe(
      true,
    )
    expect(
      AuthConfigSchema.safeParse({ trust: 'aws-cognito', region: 'ap-southeast-3', albArn: ALB_ARN }).success,
    ).toBe(true)
  })

  it('rejects malformed region', () => {
    expect(AuthConfigSchema.safeParse({ trust: 'aws-cognito', region: 'us-east', albArn: ALB_ARN }).success).toBe(false)
    expect(AuthConfigSchema.safeParse({ trust: 'aws-cognito', region: 'US-EAST-1', albArn: ALB_ARN }).success).toBe(
      false,
    )
  })

  it('rejects missing region', () => {
    expect(AuthConfigSchema.safeParse({ trust: 'aws-cognito', albArn: ALB_ARN }).success).toBe(false)
  })
  it('rejects a config without albArn, and accepts a list of ARNs', () => {
    expect(AuthConfigSchema.safeParse({ trust: 'aws-cognito', region: 'us-east-1' }).success).toBe(false)
    expect(
      AuthConfigSchema.safeParse({ trust: 'aws-cognito', region: 'us-east-1', albArn: [ALB_ARN, `${ALB_ARN}2`] })
        .success,
    ).toBe(true)
  })
})

describe('createAwsCognitoAuthProvider (Cut 5)', () => {
  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwksFactory: () => JWTVerifyGetKey = () => async () => publicKey
    return { publicKey, privateKey, jwksFactory }
  }

  it('throws AuthConfigurationError on empty region', () => {
    expect(() => createAwsCognitoAuthProvider({ region: '', albArn: ALB_ARN })).toThrow(AuthConfigurationError)
  })

  it('throws AuthConfigurationError on malformed region', () => {
    expect(() => createAwsCognitoAuthProvider({ region: 'us-east', albArn: ALB_ARN })).toThrow(AuthConfigurationError)
  })

  it('returns null when x-amzn-oidc-data is absent', async () => {
    const { jwksFactory } = await setup()
    const provider = createAwsCognitoAuthProvider({ region: 'us-east-1', albArn: ALB_ARN, jwksFactory })
    const principal = await provider.extractPrincipal(makeReq())
    expect(principal).toBeNull()
  })

  it('returns Principal for a valid signed token', async () => {
    const { privateKey, jwksFactory } = await setup()
    const token = await new SignJWT({ sub: 'cognito-user-1', email: 'bob@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'cognito-key-1', signer: ALB_ARN, exp: inFiveMinutes() })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const provider = createAwsCognitoAuthProvider({ region: 'us-east-1', albArn: ALB_ARN, jwksFactory })
    const principal = await provider.extractPrincipal(makeReq({ 'x-amzn-oidc-data': token }))
    expect(principal!.id).toBe('cognito-user-1')
    expect(principal!.email).toBe('bob@example.com')
    expect(principal!.trustMode).toBe('aws-cognito')
  })

  it('rejects forged signature (signed by attacker key)', async () => {
    const setupA = await setup()
    const setupB = await setup()
    const forgedToken = await new SignJWT({ sub: 'admin' })
      .setProtectedHeader({ alg: 'RS256', kid: 'cognito-key-1', signer: ALB_ARN, exp: inFiveMinutes() })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(setupA.privateKey)
    const provider = createAwsCognitoAuthProvider({
      region: 'us-east-1',
      albArn: ALB_ARN,
      jwksFactory: setupB.jwksFactory,
    })
    await expect(provider.extractPrincipal(makeReq({ 'x-amzn-oidc-data': forgedToken }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('falls back to username when sub is absent', async () => {
    const { privateKey, jwksFactory } = await setup()
    const token = await new SignJWT({ username: 'bob' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', signer: ALB_ARN, exp: inFiveMinutes() })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    const provider = createAwsCognitoAuthProvider({ region: 'us-east-1', albArn: ALB_ARN, jwksFactory })
    const principal = await provider.extractPrincipal(makeReq({ 'x-amzn-oidc-data': token }))
    expect(principal!.id).toBe('bob')
  })

  it('throws AuthConfigurationError without albArn', () => {
    expect(() => createAwsCognitoAuthProvider({ region: 'us-east-1' } as never)).toThrow(AuthConfigurationError)
  })

  it.each([
    [
      'another load balancer signed it',
      { signer: 'arn:aws:elasticloadbalancing:us-east-1:444455556666:loadbalancer/app/other/1' },
    ],
    ['the header has no signer', { signer: undefined }],
    ['the header expired', { exp: 1000000000 }],
    ['the header has no exp', { exp: undefined }],
  ])('rejects a token when %s', async (_why, header) => {
    const { privateKey, jwksFactory } = await setup()
    const token = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', signer: ALB_ARN, exp: inFiveMinutes(), ...header })
      .setIssuedAt()
      .sign(privateKey)
    const provider = createAwsCognitoAuthProvider({ region: 'us-east-1', albArn: ALB_ARN, jwksFactory })
    await expect(provider.extractPrincipal(makeReq({ 'x-amzn-oidc-data': token }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('rejects garbage token', async () => {
    const { jwksFactory } = await setup()
    const provider = createAwsCognitoAuthProvider({ region: 'us-east-1', albArn: ALB_ARN, jwksFactory })
    await expect(provider.extractPrincipal(makeReq({ 'x-amzn-oidc-data': 'not-a-jwt' }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })
})

// --- tailscale ----------------------------------------------------

describe('AuthConfigSchema — tailscale (Cut 5)', () => {
  it('accepts trust: tailscale with no other fields', () => {
    expect(AuthConfigSchema.safeParse({ trust: 'tailscale' }).success).toBe(true)
  })

  it('accepts trust: tailscale with roleMapping', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'tailscale',
      roleMapping: { claim: 'tailscale-user-login', map: {} },
    })
    expect(r.success).toBe(true)
  })
})

describe('createTailscaleAuthProvider (Cut 5)', () => {
  /** A request on Tailscale Serve's connection to the admin on the same machine. */
  const fromServe = (headers: Record<string, string> = {}): AuthRequest => ({
    ...makeReq(headers),
    peerAddress: '127.0.0.1',
  })

  it('returns null when Tailscale-User-Login is absent', async () => {
    const provider = createTailscaleAuthProvider()
    const principal = await provider.extractPrincipal(fromServe())
    expect(principal).toBeNull()
  })

  it('returns Principal with the full login as id', async () => {
    const provider = createTailscaleAuthProvider()
    const principal = await provider.extractPrincipal(fromServe({ 'Tailscale-User-Login': 'alice@example.ts.net' }))
    expect(principal!.id).toBe('alice@example.ts.net')
    expect(principal!.email).toBe('alice@example.ts.net')
    expect(principal!.trustMode).toBe('tailscale')
  })

  it('respects custom defaultRole', async () => {
    const provider = createTailscaleAuthProvider({ defaultRole: 'viewer' })
    const principal = await provider.extractPrincipal(fromServe({ 'Tailscale-User-Login': 'alice@example.ts.net' }))
    expect(principal!.role).toBe('viewer')
  })

  it('returns null for empty header value', async () => {
    const provider = createTailscaleAuthProvider()
    const principal = await provider.extractPrincipal(fromServe({ 'Tailscale-User-Login': '' }))
    expect(principal).toBeNull()
  })
})

// --- discriminated union sanity check ---------------------------

describe('AuthConfigSchema — full discriminated union (Cut 5)', () => {
  it('accepts every trust mode', () => {
    const modes = [
      { trust: 'none' as const },
      { trust: 'forwarded-user' as const, allowAnyOrigin: true },
      { trust: 'cloudflare-access' as const, teamDomain: 'acme' },
      { trust: 'azure-easy-auth' as const },
      { trust: 'aws-cognito' as const, region: 'us-east-1', albArn: ALB_ARN },
      { trust: 'tailscale' as const },
    ]
    for (const cfg of modes) {
      const r = AuthConfigSchema.safeParse(cfg)
      expect(r.success, `trust: ${cfg.trust} should validate`).toBe(true)
    }
  })

  it('rejects trust modes outside the closed enum', () => {
    expect(AuthConfigSchema.safeParse({ trust: 'okta' }).success).toBe(false)
    expect(AuthConfigSchema.safeParse({ trust: 'oauth2-proxy' }).success).toBe(false)
  })
})

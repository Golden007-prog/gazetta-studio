/**
 * Cut 3 tests: `forwarded-user` trust mode + IP whitelist matcher.
 *
 * The provider's contract:
 *   - The trusted-proxy check (on the connection's address) runs
 *     BEFORE header extraction
 *   - Untrusted source → throws AuthenticationError (middleware → 401)
 *   - Trusted source + missing X-Forwarded-User → returns null (anonymous)
 *   - Trusted source + valid header → returns Principal with id/email/role
 *   - allowAnyOrigin: true skips the trusted-proxy check entirely
 *   - Constructor rejects malformed trustedProxies + bad config
 *
 * The `ipMatchesAny` matcher must handle IPv4 + IPv6 + CIDR + the
 * fail-closed posture for unknown / malformed inputs.
 */
import { describe, expect, it } from 'vitest'
import {
  AuthConfigSchema,
  AuthConfigurationError,
  AuthenticationError,
  createForwardedUserAuthProvider,
  ipMatchesAny,
  parseRule,
  parseRules,
} from '../src/auth/index.js'

function makeReq(opts: { peerAddress?: string; user?: string; email?: string; groups?: string }): {
  headers: ReadonlyMap<string, string>
  peerAddress?: string
} {
  const map = new Map<string, string>()
  if (opts.user) map.set('x-forwarded-user', opts.user)
  if (opts.email) map.set('x-forwarded-email', opts.email)
  if (opts.groups) map.set('x-forwarded-groups', opts.groups)
  return { headers: map, peerAddress: opts.peerAddress }
}

describe('parseRule (Cut 3)', () => {
  it('parses an exact IPv4 address', () => {
    const r = parseRule('10.0.0.1')
    expect(r.family).toBe(4)
    expect(r.prefixBits).toBe(32)
  })

  it('parses an IPv4 CIDR', () => {
    const r = parseRule('10.0.0.0/8')
    expect(r.family).toBe(4)
    expect(r.prefixBits).toBe(8)
  })

  it('parses an exact IPv6 address', () => {
    const r = parseRule('fe80::1')
    expect(r.family).toBe(6)
    expect(r.prefixBits).toBe(128)
  })

  it('parses an IPv6 CIDR', () => {
    const r = parseRule('fd00::/8')
    expect(r.family).toBe(6)
    expect(r.prefixBits).toBe(8)
  })

  it('canonicalizes the network for non-aligned CIDR input', () => {
    // Operator may write 10.1.2.3/8 — we canonicalize to 10.0.0.0/8
    // so subsequent matches against 10.99.99.99 hit.
    const sloppy = parseRule('10.1.2.3/8')
    const canonical = parseRule('10.0.0.0/8')
    expect(sloppy.network).toBe(canonical.network)
  })

  it('throws on a malformed address', () => {
    expect(() => parseRule('not-an-ip')).toThrow()
  })

  it('throws on a non-integer prefix', () => {
    expect(() => parseRule('10.0.0.0/notanumber')).toThrow()
  })

  it('throws on an out-of-range prefix', () => {
    expect(() => parseRule('10.0.0.0/33')).toThrow()
    expect(() => parseRule('fe80::/129')).toThrow()
  })
})

describe('ipMatchesAny (Cut 3)', () => {
  it('matches an exact IPv4 entry', () => {
    const rules = parseRules(['10.0.0.1'])
    expect(ipMatchesAny('10.0.0.1', rules)).toBe(true)
    expect(ipMatchesAny('10.0.0.2', rules)).toBe(false)
  })

  it('matches inside an IPv4 CIDR', () => {
    const rules = parseRules(['10.0.0.0/8'])
    expect(ipMatchesAny('10.0.0.1', rules)).toBe(true)
    expect(ipMatchesAny('10.255.255.255', rules)).toBe(true)
    expect(ipMatchesAny('11.0.0.1', rules)).toBe(false)
  })

  it('matches inside an IPv6 CIDR', () => {
    const rules = parseRules(['fd00::/8'])
    expect(ipMatchesAny('fd00::1', rules)).toBe(true)
    expect(ipMatchesAny('fdff:abcd::1', rules)).toBe(true)
    expect(ipMatchesAny('fc00::1', rules)).toBe(false)
  })

  it('does not cross-match IPv4 against IPv6 or vice versa', () => {
    const v4Rules = parseRules(['10.0.0.0/8'])
    expect(ipMatchesAny('::ffff:a00:1', v4Rules)).toBe(false) // even though ::ffff:0a00:1 == 10.0.0.1
    const v6Rules = parseRules(['fd00::/8'])
    expect(ipMatchesAny('10.0.0.1', v6Rules)).toBe(false)
  })

  it('returns false for empty / undefined / malformed input (fail-closed)', () => {
    const rules = parseRules(['10.0.0.0/8'])
    expect(ipMatchesAny(undefined, rules)).toBe(false)
    expect(ipMatchesAny('', rules)).toBe(false)
    expect(ipMatchesAny('not-an-ip', rules)).toBe(false)
  })

  it('returns false against an empty rules list', () => {
    expect(ipMatchesAny('10.0.0.1', [])).toBe(false)
  })

  it('handles loopback + private ranges as just-another-CIDR', () => {
    const rules = parseRules(['127.0.0.0/8', '192.168.0.0/16'])
    expect(ipMatchesAny('127.0.0.1', rules)).toBe(true)
    expect(ipMatchesAny('192.168.1.50', rules)).toBe(true)
    expect(ipMatchesAny('10.0.0.1', rules)).toBe(false)
  })
})

describe('AuthConfigSchema — forwarded-user (Cut 3)', () => {
  it('accepts trust: forwarded-user with trustedProxies', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'forwarded-user',
      trustedProxies: ['10.0.0.0/8'],
    })
    expect(r.success).toBe(true)
  })

  it('accepts trust: forwarded-user with allowAnyOrigin: true', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'forwarded-user',
      allowAnyOrigin: true,
    })
    expect(r.success).toBe(true)
  })

  it('rejects forwarded-user with neither trustedProxies nor allowAnyOrigin (fail-closed default)', () => {
    const r = AuthConfigSchema.safeParse({ trust: 'forwarded-user' })
    expect(r.success).toBe(false)
  })

  it('rejects forwarded-user with empty trustedProxies and no allowAnyOrigin', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'forwarded-user',
      trustedProxies: [],
    })
    expect(r.success).toBe(false)
  })

  it('still accepts trust: none alongside forwarded-user (discriminated union)', () => {
    expect(AuthConfigSchema.safeParse({ trust: 'none' }).success).toBe(true)
  })

  it('rejects roleMapping with extra unknown fields (strict)', () => {
    const r = AuthConfigSchema.safeParse({
      trust: 'forwarded-user',
      allowAnyOrigin: true,
      roleMapping: { claim: 'groups', map: { admins: 'admin' }, extraField: 'nope' },
    })
    expect(r.success).toBe(false)
  })
})

describe('createForwardedUserAuthProvider (Cut 3)', () => {
  it('throws AuthConfigurationError when trustedProxies is empty + allowAnyOrigin is false', () => {
    expect(() => createForwardedUserAuthProvider({})).toThrow(AuthConfigurationError)
  })

  it('throws AuthConfigurationError on malformed trustedProxies entry', () => {
    expect(() => createForwardedUserAuthProvider({ trustedProxies: ['not-an-ip'] })).toThrow(AuthConfigurationError)
  })

  it('rejects a request on a connection from an untrusted address', async () => {
    const provider = createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.0/8'] })
    await expect(provider.extractPrincipal(makeReq({ peerAddress: '8.8.8.8', user: 'alice' }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })

  it('rejects a request whose connection address is unknown when trustedProxies is set', async () => {
    const provider = createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.0/8'] })
    await expect(provider.extractPrincipal(makeReq({ user: 'alice' }))).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('returns null (anonymous) when source is trusted but X-Forwarded-User is missing', async () => {
    const provider = createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.0/8'] })
    const principal = await provider.extractPrincipal(makeReq({ peerAddress: '10.0.0.1' }))
    expect(principal).toBeNull()
  })

  it('returns Principal when source is trusted and headers are present', async () => {
    const provider = createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.0/8'] })
    const principal = await provider.extractPrincipal(
      makeReq({
        peerAddress: '10.0.0.1',
        user: 'alice',
        email: 'alice@example.com',
        groups: 'admins,editors',
      }),
    )
    expect(principal).not.toBeNull()
    expect(principal!.id).toBe('alice')
    expect(principal!.email).toBe('alice@example.com')
    expect(principal!.trustMode).toBe('forwarded-user')
    // Until Cut 6 wires the role-resolver, default role is editor.
    expect(principal!.role).toBe('editor')
  })

  it('respects custom defaultRole config', async () => {
    const provider = createForwardedUserAuthProvider({
      trustedProxies: ['10.0.0.0/8'],
      defaultRole: 'viewer',
    })
    const principal = await provider.extractPrincipal(makeReq({ peerAddress: '10.0.0.1', user: 'bob' }))
    expect(principal!.role).toBe('viewer')
  })

  it('allowAnyOrigin: true skips the trusted-proxy check', async () => {
    const provider = createForwardedUserAuthProvider({ allowAnyOrigin: true })
    const principal = await provider.extractPrincipal(makeReq({ peerAddress: '8.8.8.8', user: 'alice' }))
    expect(principal).not.toBeNull()
    expect(principal!.id).toBe('alice')
  })

  it('allowAnyOrigin: true still returns null when X-Forwarded-User is missing', async () => {
    const provider = createForwardedUserAuthProvider({ allowAnyOrigin: true })
    const principal = await provider.extractPrincipal(makeReq({ peerAddress: '8.8.8.8' }))
    expect(principal).toBeNull()
  })

  it('does NOT trust forged X-Forwarded-User from untrusted origin (security regression test)', async () => {
    // The reason the trusted-proxy check exists. Without it, an attacker
    // could set X-Forwarded-User: admin in a curl request from any
    // network and impersonate the admin role.
    const provider = createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.0/8'] })
    await expect(
      provider.extractPrincipal(makeReq({ peerAddress: '203.0.113.1', user: 'admin', email: 'attacker@example.com' })),
    ).rejects.toBeInstanceOf(AuthenticationError)
  })

  it('handles IPv6 trusted proxies', async () => {
    const provider = createForwardedUserAuthProvider({ trustedProxies: ['fd00::/8'] })
    const principal = await provider.extractPrincipal(makeReq({ peerAddress: 'fd12::1', user: 'alice' }))
    expect(principal!.id).toBe('alice')
  })

  it('handles mixed IPv4 + IPv6 trustedProxies list', async () => {
    const provider = createForwardedUserAuthProvider({
      trustedProxies: ['10.0.0.0/8', 'fd00::/8'],
    })
    expect((await provider.extractPrincipal(makeReq({ peerAddress: '10.0.0.1', user: 'a' })))?.id).toBe('a')
    expect((await provider.extractPrincipal(makeReq({ peerAddress: 'fd12::1', user: 'b' })))?.id).toBe('b')
    await expect(provider.extractPrincipal(makeReq({ peerAddress: '8.8.8.8', user: 'c' }))).rejects.toBeInstanceOf(
      AuthenticationError,
    )
  })
})

/**
 * Cut 4 tests: pseudonymization + source-IP / user-agent processing.
 *
 * Each module is a pure function; tests pin the documented modes
 * and the trust-mode-driven extraction matrix.
 */
import { describe, expect, it } from 'vitest'
import {
  computePseudonymizedId,
  extractSourceIp,
  processSourceIp,
  processUserAgent,
  pseudonymizeActor,
  type AuditActor,
} from '../src/audit/index.js'

const sampleActor: AuditActor = {
  id: 'oidc-sub-12345',
  email: 'alice@example.com',
  role: 'editor',
  trustMode: 'cloudflare-access',
}

describe('pseudonymizeActor (Cut 4)', () => {
  it("'none' mode passes the actor through unchanged", () => {
    const out = pseudonymizeActor(sampleActor, 'none')
    expect(out).toEqual(sampleActor)
    // Same reference — no allocation cost when feature is off.
    expect(out).toBe(sampleActor)
  })

  it("'sha256' mode replaces id with salted hash prefix", () => {
    const out = pseudonymizeActor(sampleActor, 'sha256', 'salt-1234567890')
    expect(out.id).not.toBe(sampleActor.id)
    expect(out.id).toMatch(/^[a-f0-9]{16}$/)
    expect(out.role).toBe('editor')
    expect(out.trustMode).toBe('cloudflare-access')
  })

  it("'sha256' mode drops the email field", () => {
    const out = pseudonymizeActor(sampleActor, 'sha256', 'salt')
    expect(out.email).toBeUndefined()
  })

  it("'sha256' mode is deterministic across calls (multi-instance correctness)", () => {
    const a = pseudonymizeActor(sampleActor, 'sha256', 'shared-salt')
    const b = pseudonymizeActor(sampleActor, 'sha256', 'shared-salt')
    expect(a.id).toBe(b.id)
  })

  it('different salts produce different hashes (salt rotation breaks correlation)', () => {
    const a = pseudonymizeActor(sampleActor, 'sha256', 'old-salt')
    const b = pseudonymizeActor(sampleActor, 'sha256', 'new-salt')
    expect(a.id).not.toBe(b.id)
  })

  it("'sha256' without a salt throws (catches operator misconfiguration)", () => {
    expect(() => pseudonymizeActor(sampleActor, 'sha256')).toThrow(/salt/)
    expect(() => pseudonymizeActor(sampleActor, 'sha256', '')).toThrow(/salt/)
  })

  it('does not mutate the input actor', () => {
    const before = JSON.stringify(sampleActor)
    pseudonymizeActor(sampleActor, 'sha256', 'salt')
    expect(JSON.stringify(sampleActor)).toBe(before)
  })

  it('computePseudonymizedId matches pseudonymizeActor for forensic queries', () => {
    // The forensic query path: operator knows sub + salt, computes
    // the hash, searches the audit log. Must match the recorder's
    // pseudonymization exactly.
    const direct = computePseudonymizedId(sampleActor.id, 'salt')
    const viaActor = pseudonymizeActor(sampleActor, 'sha256', 'salt').id
    expect(direct).toBe(viaActor)
  })
})

// --- Source IP --------------------------------------------------

function headerMap(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]))
}

describe('extractSourceIp (Cut 4) — trust-mode dispatch', () => {
  it("'none' trust mode: returns the connection's address", () => {
    expect(extractSourceIp({ trustMode: 'none', headers: headerMap({}), peerIp: '203.0.113.1' })).toBe('203.0.113.1')
  })

  it("'tailscale' trust mode: returns the connection's address", () => {
    expect(extractSourceIp({ trustMode: 'tailscale', headers: headerMap({}), peerIp: '100.64.0.1' })).toBe('100.64.0.1')
  })

  it("'cloudflare-access': prefers Cf-Connecting-IP", () => {
    expect(
      extractSourceIp({
        trustMode: 'cloudflare-access',
        headers: headerMap({ 'Cf-Connecting-IP': '203.0.113.5' }),
        peerIp: '198.51.100.1', // peer would be Cloudflare's edge
      }),
    ).toBe('203.0.113.5')
  })

  it("'cloudflare-access': leaves the field out when Cf-Connecting-IP is absent", () => {
    expect(
      extractSourceIp({
        trustMode: 'cloudflare-access',
        headers: headerMap({}),
        peerIp: '198.51.100.1',
      }),
    ).toBeNull()
  })

  // Each proxy appends the address it received the request from, so with
  // N trusted proxies the client is the Nth X-Forwarded-For entry from the
  // right; anything further left came from the client.
  it("'forwarded-user' with trustedProxyCount=1: the entry the proxy appended", () => {
    expect(
      extractSourceIp({
        trustMode: 'forwarded-user',
        headers: headerMap({ 'X-Forwarded-For': '203.0.113.1' }),
        peerIp: '10.0.0.1',
        trustedProxyCount: 1,
      }),
    ).toBe('203.0.113.1')
  })

  it("'forwarded-user' ignores entries the client sent", () => {
    expect(
      extractSourceIp({
        trustMode: 'forwarded-user',
        headers: headerMap({ 'X-Forwarded-For': '6.6.6.6, 203.0.113.1' }),
        peerIp: '10.0.0.1',
        trustedProxyCount: 1,
      }),
    ).toBe('203.0.113.1')
  })

  it("'forwarded-user' with trustedProxyCount=2: the second entry from the right", () => {
    expect(
      extractSourceIp({
        trustMode: 'forwarded-user',
        headers: headerMap({ 'X-Forwarded-For': '6.6.6.6, 203.0.113.1, 10.0.0.1' }),
        peerIp: '10.0.0.2',
        trustedProxyCount: 2,
      }),
    ).toBe('203.0.113.1')
  })

  it("'forwarded-user' default trustedProxyCount is 1", () => {
    expect(
      extractSourceIp({
        trustMode: 'forwarded-user',
        headers: headerMap({ 'X-Forwarded-For': '6.6.6.6, 203.0.113.1' }),
        // No trustedProxyCount supplied — should default to 1
      }),
    ).toBe('203.0.113.1')
  })

  it('leaves the field out when X-Forwarded-For is absent', () => {
    expect(extractSourceIp({ trustMode: 'forwarded-user', headers: headerMap({}), peerIp: '10.0.0.1' })).toBeNull()
  })

  it('leaves the field out when X-Forwarded-For has fewer entries than trustedProxyCount', () => {
    // Proxy misconfiguration: the operator says two proxies append, the
    // header has one entry.
    expect(
      extractSourceIp({
        trustMode: 'forwarded-user',
        headers: headerMap({ 'X-Forwarded-For': '203.0.113.1' }),
        peerIp: '10.0.0.1',
        trustedProxyCount: 2,
      }),
    ).toBeNull()
  })

  it("'azure-easy-auth': uses X-Forwarded-For (default trustedProxyCount 1)", () => {
    expect(
      extractSourceIp({
        trustMode: 'azure-easy-auth',
        headers: headerMap({ 'X-Forwarded-For': '6.6.6.6, 203.0.113.1' }),
      }),
    ).toBe('203.0.113.1')
  })

  it("'aws-cognito': uses X-Forwarded-For (default trustedProxyCount 1)", () => {
    expect(
      extractSourceIp({
        trustMode: 'aws-cognito',
        headers: headerMap({ 'X-Forwarded-For': '203.0.113.1' }),
      }),
    ).toBe('203.0.113.1')
  })

  it('unknown trust mode falls back to peer IP', () => {
    expect(
      extractSourceIp({
        trustMode: 'plugin-supplied-future',
        headers: headerMap({}),
        peerIp: '203.0.113.1',
      }),
    ).toBe('203.0.113.1')
  })
})

describe('processSourceIp (Cut 4) — mode dispatch', () => {
  it("'none' returns null regardless of input", () => {
    expect(processSourceIp('203.0.113.1', 'none')).toBeNull()
  })

  it('null input returns null in any mode', () => {
    expect(processSourceIp(null, 'raw')).toBeNull()
    expect(processSourceIp(null, 'truncated')).toBeNull()
  })

  it("'raw' returns the IP unchanged", () => {
    expect(processSourceIp('203.0.113.1', 'raw')).toBe('203.0.113.1')
    expect(processSourceIp('fe80::1', 'raw')).toBe('fe80::1')
  })

  it("'hashed' produces a 16-char hex prefix", () => {
    const out = processSourceIp('203.0.113.1', 'hashed', 'salt')
    expect(out).toMatch(/^[a-f0-9]{16}$/)
  })

  it("'hashed' is deterministic + salt-rotation-aware", () => {
    expect(processSourceIp('1.2.3.4', 'hashed', 'salt')).toBe(processSourceIp('1.2.3.4', 'hashed', 'salt'))
    expect(processSourceIp('1.2.3.4', 'hashed', 'salt')).not.toBe(processSourceIp('1.2.3.4', 'hashed', 'other-salt'))
  })

  it("'hashed' without salt throws", () => {
    expect(() => processSourceIp('1.2.3.4', 'hashed')).toThrow(/salt/)
  })

  it("'truncated' IPv4 → /24", () => {
    expect(processSourceIp('203.0.113.42', 'truncated')).toBe('203.0.113.0/24')
    expect(processSourceIp('10.1.2.3', 'truncated')).toBe('10.1.2.0/24')
  })

  it("'truncated' IPv6 → /48 (first 3 groups)", () => {
    expect(processSourceIp('2001:db8:abcd:1234::1', 'truncated')).toBe('2001:db8:abcd::/48')
    expect(processSourceIp('fe80::1', 'truncated')).toBe('fe80:0:0::/48')
  })

  it("'truncated' on malformed IP returns null", () => {
    expect(processSourceIp('not-an-ip', 'truncated')).toBeNull()
    expect(processSourceIp('1.2.3', 'truncated')).toBeNull()
    expect(processSourceIp('1.2.3.999', 'truncated')).toBeNull()
  })
})

// --- User Agent -------------------------------------------------

describe('processUserAgent (Cut 4)', () => {
  it("'none' mode returns null", () => {
    expect(processUserAgent('Mozilla/5.0 ...', 'none')).toBeNull()
  })

  it('null/empty input returns null', () => {
    expect(processUserAgent(undefined, 'raw')).toBeNull()
    expect(processUserAgent('', 'raw')).toBeNull()
  })

  it("'raw' returns the full UA", () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0.0.0'
    expect(processUserAgent(ua, 'raw')).toBe(ua)
  })

  it("'truncated' detects Chrome", () => {
    expect(processUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0.0.0', 'truncated')).toBe(
      'Chrome/119',
    )
  })

  it("'truncated' detects Firefox", () => {
    expect(processUserAgent('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Firefox/120.0', 'truncated')).toBe('Firefox/120')
  })

  it("'truncated' detects Safari", () => {
    expect(processUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/17.0 Safari/605.1', 'truncated')).toBe(
      'Safari/17',
    )
  })

  it("'truncated' detects Edge before Chrome (UA contains Chrome)", () => {
    expect(processUserAgent('Mozilla/5.0 ... Chrome/119 Edg/119.0', 'truncated')).toBe('Edge/119')
  })

  it("'truncated' falls back to 'Other' for unknown families", () => {
    expect(processUserAgent('curl/8.0.0', 'truncated')).toBe('Other')
    expect(processUserAgent('AcmeBot/1.0', 'truncated')).toBe('Other')
  })
})

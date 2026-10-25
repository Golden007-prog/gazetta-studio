/**
 * #1402: the aws-cognito default JWKS resolver cached ALB public keys
 * in an unbounded map — one entry per kid seen for the process's
 * lifetime. The cache is now a bounded LRU
 * (AWS_COGNITO_KEY_CACHE_MAX): it holds at most a fixed number of
 * keys, and a burst of unknown kids evicts the least-recently-used
 * entry instead of growing forever.
 *
 * An ALB key never changes for a given kid, so eviction is safe: a
 * re-request just refetches. Cache behavior is observed through the
 * number of upstream fetches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AWS_COGNITO_KEY_CACHE_MAX, defaultJwksFactory } from '../src/auth/providers/aws-cognito.js'

async function makePublicKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
  const b64 = Buffer.from(spki).toString('base64')
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`
}

function stubFetch(pem: string) {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    return new Response(pem, { status: 200 })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('aws-cognito default JWKS cache (#1402)', () => {
  it(`holds at most AWS_COGNITO_KEY_CACHE_MAX (${AWS_COGNITO_KEY_CACHE_MAX}) keys`, async () => {
    const pem = await makePublicKeyPem()
    const calls = stubFetch(pem)
    const resolve = defaultJwksFactory('us-east-1')

    // Fill beyond the bound: one fetch per new kid.
    for (let i = 0; i <= AWS_COGNITO_KEY_CACHE_MAX; i++) {
      await resolve({ kid: `kid-${i}`, alg: 'ES256' })
    }
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX + 1)

    // The most recent kid is still cached: no new fetch.
    await resolve({ kid: `kid-${AWS_COGNITO_KEY_CACHE_MAX}`, alg: 'ES256' })
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX + 1)

    // kid-0 overflowed the bound and was evicted: it refetches.
    await resolve({ kid: 'kid-0', alg: 'ES256' })
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX + 2)
  })

  it('a cache hit refreshes recency, so steady keys survive an unknown-kid burst', async () => {
    const pem = await makePublicKeyPem()
    const calls = stubFetch(pem)
    const resolve = defaultJwksFactory('us-east-1')

    // Fill exactly to the bound.
    for (let i = 0; i < AWS_COGNITO_KEY_CACHE_MAX; i++) {
      await resolve({ kid: `kid-${i}`, alg: 'ES256' })
    }
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX)

    // Touch kid-0: it becomes the most recently used.
    await resolve({ kid: 'kid-0', alg: 'ES256' })
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX)

    // A new kid overflows the bound and evicts kid-1 (the LRU
    // entry), not the just-touched kid-0.
    await resolve({ kid: 'kid-new', alg: 'ES256' })
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX + 1)

    await resolve({ kid: 'kid-0', alg: 'ES256' })
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX + 1) // still cached

    await resolve({ kid: 'kid-1', alg: 'ES256' })
    expect(calls).toHaveLength(AWS_COGNITO_KEY_CACHE_MAX + 2) // evicted
  })
})

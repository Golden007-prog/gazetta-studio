import { describe, it, expect } from 'vitest'
import { authTrustOf, resolveListenHost } from '../src/cli/listen-host.js'

describe('resolveListenHost (#1074)', () => {
  it.each([
    ['dev', undefined, 'none', '127.0.0.1'],
    ['dev', undefined, 'forwarded-user', '127.0.0.1'],
    ['admin', undefined, 'none', '127.0.0.1'],
    ['admin', undefined, 'cloudflare-access', undefined],
    ['serve', undefined, 'none', undefined],
    ['dev', '0.0.0.0', 'none', '0.0.0.0'],
    ['admin', '127.0.0.1', 'forwarded-user', '127.0.0.1'],
    ['serve', '127.0.0.1', 'none', '127.0.0.1'],
  ] as const)('%s with --host %s and trust %s listens on %s', (command, flag, trust, expected) => {
    expect(resolveListenHost(command, flag, trust)).toBe(expected)
  })
})

describe('authTrustOf', () => {
  it.each([
    [undefined, 'none'],
    [{}, 'none'],
    [{ trust: 'none' }, 'none'],
    [{ trust: 'forwarded-user', header: 'x-user' }, 'forwarded-user'],
  ])('%j → %s', (block, expected) => {
    expect(authTrustOf(block)).toBe(expected)
  })
})

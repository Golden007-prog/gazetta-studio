import { describe, it, expect } from 'vitest'
import { resolveListenHost } from '../src/cli/listen-host.js'

describe('resolveListenHost (#1074)', () => {
  it.each([
    ['dev', undefined, '127.0.0.1'],
    ['admin', undefined, '127.0.0.1'],
    ['serve', undefined, undefined],
    ['dev', '0.0.0.0', '0.0.0.0'],
    ['admin', '192.168.1.20', '192.168.1.20'],
    ['serve', '127.0.0.1', '127.0.0.1'],
  ] as const)('%s with --host %s listens on %s', (command, flag, expected) => {
    expect(resolveListenHost(command, flag)).toBe(expected)
  })
})

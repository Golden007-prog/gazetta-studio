import { describe, expect, it } from 'vitest'
import { spawnBounded } from '../spawn-bounded.js'

const node = process.execPath

describe('spawnBounded', () => {
  it('returns stdout when asked and the command succeeds', () => {
    expect(
      spawnBounded(node, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 10_000, captureStdout: true }),
    ).toEqual({ ok: true, stdout: 'hi' })
  })

  it('returns stderr when the command fails', () => {
    expect(spawnBounded(node, ['-e', 'console.error("boom"); process.exit(3)'], { timeoutMs: 10_000 })).toEqual({
      ok: false,
      error: 'boom',
    })
  })

  it('kills a command that runs past the limit and says so', () => {
    const started = Date.now()
    const r = spawnBounded(node, ['-e', 'setTimeout(() => {}, 30_000)'], { timeoutMs: 300 })
    expect(r).toEqual({ ok: false, error: `${node} timed out after 0 s` })
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

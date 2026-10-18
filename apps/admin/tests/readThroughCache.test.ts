/**
 * The read path the site tree uses. Offline it must answer from the
 * cache without touching the network; online it must prefer a fresh
 * answer and only fall back when the fetch fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/vue-query'
import { configureReadThrough, readThrough } from '../src/client/queries/read-through.js'

afterEach(() => configureReadThrough(null))

function setup(opts: { offline?: boolean; cached?: unknown; restored?: Promise<void> } = {}) {
  const client = new QueryClient()
  if (opts.cached !== undefined) client.setQueryData(['k'], opts.cached)
  let offline = opts.offline ?? false
  configureReadThrough({ client, restored: opts.restored ?? Promise.resolve(), isOffline: () => offline })
  return { client, goOffline: () => (offline = true) }
}

describe('readThrough', () => {
  it('without a registered client, just fetches', async () => {
    expect(await readThrough(['k'], async () => 'fresh')).toBe('fresh')
  })

  it('online: fetches fresh and caches the answer', async () => {
    const { client } = setup({ cached: 'old' })
    expect(await readThrough(['k'], async () => 'fresh')).toBe('fresh')
    expect(client.getQueryData(['k'])).toBe('fresh')
  })

  it('online, fetch fails: falls back to the cached answer', async () => {
    setup({ cached: 'old' })
    expect(await readThrough(['k'], () => Promise.reject(new Error('Failed to fetch')))).toBe('old')
  })

  it('online, fetch fails, allowCache false: rethrows so the caller can retry', async () => {
    setup({ cached: 'old' })
    await expect(readThrough(['k'], () => Promise.reject(new Error('502')), { allowCache: false })).rejects.toThrow(
      '502',
    )
  })

  it('offline with a cached answer: returns it without fetching', async () => {
    setup({ cached: 'old', offline: true })
    const fetch = vi.fn(async () => 'fresh')
    expect(await readThrough(['k'], fetch)).toBe('old')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('offline with no cached answer: tries the network and surfaces its error', async () => {
    setup({ offline: true })
    await expect(readThrough(['k'], () => Promise.reject(new Error('Failed to fetch')))).rejects.toThrow(
      'Failed to fetch',
    )
  })

  it('fails instead of pausing while the query client thinks it is offline', async () => {
    // The connection store calls onlineManager.setOnline(false) when offline.
    const { onlineManager } = await import('@tanstack/vue-query')
    onlineManager.setOnline(false)
    try {
      setup()
      await expect(readThrough(['k'], () => Promise.reject(new Error('Failed to fetch')))).rejects.toThrow()
    } finally {
      onlineManager.setOnline(true)
    }
  })

  it('waits for the persisted cache to be restored before reading it', async () => {
    let restore!: () => void
    const restored = new Promise<void>(r => (restore = r))
    const { client } = setup({ offline: true, restored })
    const fetch = vi.fn(async () => 'fresh')
    const pending = readThrough(['k'], fetch)
    client.setQueryData(['k'], 'restored') // what the restore puts in
    restore()
    expect(await pending).toBe('restored')
    expect(fetch).not.toHaveBeenCalled()
  })
})

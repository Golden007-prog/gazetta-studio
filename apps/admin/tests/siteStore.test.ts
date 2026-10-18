/**
 * The site store's read path (Cut 5b). The site tree must render from
 * the last answer when the server can't be reached, and a cached list
 * for one target must never be shown for another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { QueryClient } from '@tanstack/vue-query'
import { api } from '../src/client/api/client.js'
import { setActiveTargetProvider } from '../src/client/api/_request.js'
import { configureReadThrough } from '../src/client/queries/read-through.js'
import { useSiteStore } from '../src/client/stores/site.js'

const SITE = { name: 'main' }
const page = (name: string) => ({ name, route: `/${name}`, template: 'page-default' })

let client: QueryClient
let offline = false
let target: string | null = 'local'

beforeEach(() => {
  setActivePinia(createPinia())
  client = new QueryClient()
  offline = false
  target = 'local'
  setActiveTargetProvider(() => target)
  configureReadThrough({ client, restored: Promise.resolve(), isOffline: () => offline })
})
afterEach(() => {
  vi.restoreAllMocks()
  configureReadThrough(null)
  setActiveTargetProvider(null)
})

function serve(pages: string[]) {
  vi.spyOn(api, 'getSite').mockResolvedValue(SITE as never)
  vi.spyOn(api, 'getPages').mockResolvedValue(pages.map(page) as never)
  vi.spyOn(api, 'getFragments').mockResolvedValue([] as never)
}
function fail(message: string) {
  const err = () => Promise.reject(new Error(message))
  vi.spyOn(api, 'getSite').mockImplementation(err)
  vi.spyOn(api, 'getPages').mockImplementation(err)
  vi.spyOn(api, 'getFragments').mockImplementation(err)
}
const names = () => useSiteStore().pages.map(p => p.name)

describe('site store reads', () => {
  it('online: loads fresh', async () => {
    serve(['home'])
    await useSiteStore().load(0)
    expect(names()).toEqual(['home'])
    expect(useSiteStore().error).toBeNull()
  })

  it.each([
    'Failed to fetch',
    '500 Internal Server Error',
  ])('fetch fails (%s): shows the last answer, no error', async message => {
    serve(['home', 'about'])
    await useSiteStore().load(0)
    vi.restoreAllMocks()
    fail(message)
    await useSiteStore().load(0)
    expect(names()).toEqual(['home', 'about'])
    expect(useSiteStore().error).toBeNull()
  })

  it('offline: answers from the cache without calling the API', async () => {
    serve(['home'])
    await useSiteStore().load(0)
    vi.restoreAllMocks()
    const getPages = vi.spyOn(api, 'getPages')
    offline = true
    await useSiteStore().load(0)
    expect(names()).toEqual(['home'])
    expect(getPages).not.toHaveBeenCalled()
  })

  it('fetch fails with nothing cached: reports the error', async () => {
    fail('Failed to fetch')
    await useSiteStore().load(0)
    expect(useSiteStore().error).toBe('Failed to fetch')
    expect(names()).toEqual([])
  })

  it("never shows one target's cached pages for another target", async () => {
    serve(['home'])
    await useSiteStore().load(0)
    vi.restoreAllMocks()
    fail('Failed to fetch')
    target = 'staging'
    await useSiteStore().load(0)
    expect(useSiteStore().error).toBe('Failed to fetch')
  })
})

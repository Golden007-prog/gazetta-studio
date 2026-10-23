/**
 * #1125: the Cloudflare worker keys its Cache API entries on the
 * target's `.gazetta/publish-generation`. A response read from R2
 * before a publish but stored after its purge used to be served until
 * s-maxage ran out; with the generation in the key, nothing cached
 * before a publish matches after it. The generation is memoized for
 * 5 seconds per isolate, so a cache hit doesn't wait for an R2 read
 * and a page is stale for at most those 5 seconds after a publish.
 *
 * Verified fail-unfixed before commit: "a response cached under the
 * old generation is not served after the generation changes" fails on
 * main (the old response is served from the cache), while the
 * no-generation-file behavior is unchanged with and without the fix.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWorker } from '../src/workers/cloudflare-r2.js'

const GENERATION_PATH = '.gazetta/publish-generation'
const LIVE_A = '<!DOCTYPE html><html><body>Version A</body></html>'
const LIVE_B = '<!DOCTYPE html><html><body>Version B</body></html>'

interface FakeBucket {
  bucket: { get(key: string): Promise<unknown> }
  getCalls: string[]
  files: Map<string, string>
}

function fakeBucket(seed: Record<string, string>): FakeBucket {
  const files = new Map(Object.entries(seed))
  const getCalls: string[] = []
  return {
    getCalls,
    files,
    bucket: {
      async get(key: string) {
        getCalls.push(key)
        const value = files.get(key)
        if (value === undefined) return null
        return {
          async text() {
            return value
          },
        }
      },
    },
  }
}

function liveSeed(): Record<string, string> {
  return {
    'pages/about/index.html': `<!--cache:browser=60,edge=300-->\n${LIVE_A}`,
  }
}

let originalCaches: PropertyDescriptor | undefined
let cacheStore: Map<string, Response>
let cachePuts: string[]

beforeEach(() => {
  originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  cacheStore = new Map()
  cachePuts = []
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      default: {
        match: async (request: Request) => cacheStore.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          cachePuts.push(request.url)
          cacheStore.set(request.url, response.clone())
        },
      },
    },
  })
})

afterEach(() => {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
  else delete (globalThis as { caches?: unknown }).caches
  vi.useRealTimers()
})

async function fetchPage(app: ReturnType<typeof createWorker>, bucket: unknown, path: string) {
  return app.fetch(
    new Request(`https://example.com${path}`),
    { SITE_BUCKET: bucket } as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )
}

describe('Cloudflare worker publish generation (#1125)', () => {
  it('a response cached under the old generation is not served after the generation changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
    const { bucket, files } = fakeBucket({ ...liveSeed(), [GENERATION_PATH]: 'gen-A' })
    const app = createWorker()

    const first = await fetchPage(app, bucket, '/about')
    expect(first.status).toBe(200)
    expect(await first.text()).toContain('Version A')
    expect(cachePuts.some(url => url.includes('gazetta-generation=gen-A'))).toBe(true)

    // Publish: new page content and a new generation land on the target.
    files.set('pages/about/index.html', `<!--cache:browser=60,edge=300-->\n${LIVE_B}`)
    files.set(GENERATION_PATH, 'gen-B')
    // Past the 5 second per-isolate memo, the worker re-reads the generation.
    vi.setSystemTime(new Date('2026-10-24T00:00:06Z'))

    const second = await fetchPage(app, bucket, '/about')
    expect(second.status).toBe(200)
    expect(await second.text()).toContain('Version B')
    expect(cachePuts.some(url => url.includes('gazetta-generation=gen-B'))).toBe(true)
  })

  it('serves the cached copy within the 5 second generation memo window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
    const { bucket, files } = fakeBucket({ ...liveSeed(), [GENERATION_PATH]: 'gen-A' })
    const app = createWorker()

    expect((await fetchPage(app, bucket, '/about')).status).toBe(200)
    files.set('pages/about/index.html', `<!--cache:browser=60,edge=300-->\n${LIVE_B}`)
    files.set(GENERATION_PATH, 'gen-B')
    vi.setSystemTime(new Date('2026-10-24T00:00:04Z'))

    // Accepted bound: at most 5 seconds stale after a publish.
    const second = await fetchPage(app, bucket, '/about')
    expect(second.status).toBe(200)
    expect(await second.text()).toContain('Version A')
  })

  it('with no generation file a second request is served from the cache, as before', async () => {
    const { bucket, getCalls } = fakeBucket(liveSeed())
    const app = createWorker()

    expect((await fetchPage(app, bucket, '/about')).status).toBe(200)
    const pageReads = getCalls.filter(key => key.startsWith('pages/')).length

    const second = await fetchPage(app, bucket, '/about')
    expect(second.status).toBe(200)
    expect(getCalls.filter(key => key.startsWith('pages/'))).toHaveLength(pageReads)
    expect(cachePuts).toHaveLength(1)
  })
})

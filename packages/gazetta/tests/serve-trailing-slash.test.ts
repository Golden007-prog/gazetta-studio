/**
 * `gazetta serve` strips a trailing slash and re-dispatches the request
 * (/about/ → /about). Through a real HTTP server the incoming request is
 * @hono/node-server's own object, not a native Request; on Node 26,
 * building the re-dispatched Request from it threw "Illegal invocation"
 * and every trailing-slash URL answered 500. `app.request()` uses a native
 * Request and can't show this, so these tests go through a real server.
 * On Node 22 they pass either way; CI's node-26 job is what they guard.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { createServer } from '../src/serve.js'
import { memoryStorage } from './_helpers/memory-storage.js'

let server: ServerType | undefined

afterEach(async () => {
  await new Promise<void>(done => (server ? server.close(() => done()) : done()))
  server = undefined
})

async function listen(app: ReturnType<typeof createServer>): Promise<string> {
  return new Promise(done => {
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info =>
      done(`http://127.0.0.1:${(info as AddressInfo).port}`),
    )
  })
}

describe('gazetta serve — trailing slash through a real server', () => {
  it('serves /about/ as /about', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>', '/about/index.html': '<h1>about</h1>' })
    const base = await listen(createServer({ storage, type: 'static' }))

    const res = await fetch(`${base}/about/`)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>about</h1>')
  })

  it('serves a language route with a trailing slash', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>', '/fr/index.html': '<h1>accueil</h1>' })
    const base = await listen(createServer({ storage, type: 'static', locales: ['en', 'fr'], defaultLocale: 'en' }))

    const res = await fetch(`${base}/fr/`)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>accueil</h1>')
  })
})

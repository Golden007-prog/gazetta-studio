import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { devNotFound } from '../src/cli/dev-not-found.js'
import type { Site } from '../src/site-loader.js'

function devApp(pages: Record<string, string>) {
  const map: Site['pages'] = new Map(
    Object.entries(pages).map(([name, route]) => [name, { route, dir: `pages/${name}` }]),
  )
  const app = new Hono()
  app.notFound(devNotFound(map))
  return app
}

describe("gazetta dev's not-found page", () => {
  it('answers 404 with the path and the site routes', async () => {
    const res = await devApp({ home: '/', about: '/about' }).request('/missing')

    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).toContain('Page not found: /missing')
    expect(body).toContain('  / → home\n  /about → about')
    expect(body).toContain('/admin → CMS editor')
  })

})

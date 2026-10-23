import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type BrowserLike, captureScreenshots, chromiumAvailable, type PageLike, screenshot } from '../screenshot.js'
import { serveStatic } from '../storybook-server.js'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47]

interface FakeLog {
  viewports: unknown[]
  gotos: string[]
  waited: string[]
  pagesClosed: number
  browserClosed: number
}

function fakeBrowser(
  log: FakeLog,
  behave: (url: string) => { status?: number; throws?: string; bytes?: Uint8Array },
): () => Promise<BrowserLike> {
  return async () => ({
    async newPage(opts) {
      log.viewports.push(opts.viewport)
      let current = ''
      const page: PageLike = {
        async goto(url) {
          current = url
          log.gotos.push(url)
          const b = behave(url)
          if (b.throws) throw new Error(b.throws)
          return { status: () => b.status ?? 200 }
        },
        async waitForSelector(sel) {
          log.waited.push(sel)
        },
        async screenshot() {
          return behave(current).bytes ?? new Uint8Array([1, 2, 3])
        },
        async close() {
          log.pagesClosed++
        },
      }
      return page
    },
    async close() {
      log.browserClosed++
    },
  })
}

const newLog = (): FakeLog => ({ viewports: [], gotos: [], waited: [], pagesClosed: 0, browserClosed: 0 })

describe('screenshot', () => {
  it('returns the page PNG as base64, at the requested viewport, after the ready selector', async () => {
    const log = newLog()
    const r = await screenshot(
      'http://sb/iframe.html?id=a--b',
      { width: 400, height: 300 },
      {
        readySelector: '#storybook-root > *',
        launch: fakeBrowser(log, () => ({ bytes: new Uint8Array([7, 8, 9]) })),
      },
    )
    expect(r).toEqual({ ok: true, base64: Buffer.from([7, 8, 9]).toString('base64') })
    expect(log.viewports).toEqual([{ width: 400, height: 300 }])
    expect(log.waited).toEqual(['#storybook-root > *'])
    expect(log.browserClosed).toBe(1)
  })

  it.each([
    ['an unreachable URL', { throws: 'net::ERR_CONNECTION_REFUSED' }, /couldn't load .*ERR_CONNECTION_REFUSED/],
    ['an error status', { status: 404 }, /answered 404/],
    ['an empty screenshot', { bytes: new Uint8Array() }, /empty screenshot/],
  ])('reports %s instead of throwing, and still closes the browser', async (_, behave, error) => {
    const log = newLog()
    const r = await screenshot('http://x/', undefined, { launch: fakeBrowser(log, () => behave) })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(error)
    expect(log.browserClosed).toBe(1)
    expect(log.pagesClosed).toBe(1)
  })

  it('reports a browser that will not launch', async () => {
    const r = await screenshot('http://x/', undefined, {
      launch: async () => {
        throw new Error('Executable does not exist')
      },
    })
    expect(r).toEqual({ ok: false, error: "couldn't launch the browser: Executable does not exist" })
  })
})

describe('captureScreenshots', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shots-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes each shot with one browser and reports the ones that failed', async () => {
    const log = newLog()
    const out = await captureScreenshots(
      [
        { url: 'http://sb/ok', path: join(dir, 'nested', 'ok.png') },
        { url: 'http://sb/down', path: join(dir, 'down.png') },
      ],
      undefined,
      {
        launch: fakeBrowser(log, url =>
          url.endsWith('down') ? { throws: 'refused' } : { bytes: new Uint8Array([5]) },
        ),
      },
    )
    expect(out.map(o => o.ok)).toEqual([true, false])
    expect([...readFileSync(join(dir, 'nested', 'ok.png'))]).toEqual([5])
    expect(log.browserClosed).toBe(1)
  })

  it('marks every shot failed when the browser will not launch', async () => {
    const out = await captureScreenshots([{ url: 'http://a', path: join(dir, 'a.png') }], undefined, {
      launch: async () => {
        throw new Error('nope')
      },
    })
    expect(out).toEqual([
      { url: 'http://a', path: join(dir, 'a.png'), ok: false, error: "couldn't launch the browser: nope" },
    ])
  })
})

describe('screenshot with real Chromium', async () => {
  const available = await chromiumAvailable()
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shot-real-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it.skipIf(!available)('renders a served page to a PNG', async () => {
    writeFileSync(join(dir, 'index.html'), '<div id="storybook-root"><p style="color:red">hello</p></div>')
    const server = await serveStatic(dir)
    try {
      const r = await screenshot(
        `${server.url}/`,
        { width: 200, height: 100 },
        { readySelector: '#storybook-root > *' },
      )
      expect(r.ok).toBe(true)
      const bytes = Buffer.from(r.ok ? r.base64 : '', 'base64')
      expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE)
    } finally {
      await server.stop()
    }
  })

  it.skipIf(!available)('reports an unreachable URL', async () => {
    const server = await serveStatic(dir)
    const url = server.url
    await server.stop()
    const r = await screenshot(`${url}/`, undefined, { timeoutMs: 5000 })
    expect(r.ok).toBe(false)
  })
})

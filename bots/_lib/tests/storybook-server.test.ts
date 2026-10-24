import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readStoryIndex, serveStatic, startStorybook, storyUrl } from '../storybook-server.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sb-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Raw GET, so `..` reaches the server unnormalised. */
function get(url: string, path: string): Promise<{ status: number; type?: string; body: string }> {
  const u = new URL(url)
  return new Promise((ok, fail) => {
    const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, res => {
      let body = ''
      res.on('data', c => {
        body += c
      })
      res.on('end', () => ok({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }))
    })
    req.on('error', fail)
    req.end()
  })
}

function fakeBuild(): void {
  writeFileSync(join(dir, 'iframe.html'), '<html>story</html>')
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      v: 5,
      entries: {
        'banner--error': {
          type: 'story',
          id: 'banner--error',
          title: 'Primitives / Banner',
          name: 'Error',
          importPath: './apps/admin/src/client/components/Banner.stories.ts',
        },
        'banner--docs': { type: 'docs', id: 'banner--docs', importPath: './x.mdx' },
      },
    }),
  )
}

describe('serveStatic', () => {
  it('serves files from the directory with their content type', async () => {
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'iframe.html'), '<p>hi</p>')
    writeFileSync(join(dir, 'assets', 'a.js'), 'x=1')
    const server = await serveStatic(dir)
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(await get(server.url, '/iframe.html?id=x--y')).toMatchObject({
        status: 200,
        type: 'text/html; charset=utf-8',
        body: '<p>hi</p>',
      })
      expect(await get(server.url, '/assets/a.js')).toMatchObject({
        status: 200,
        type: 'text/javascript; charset=utf-8',
      })
    } finally {
      await server.stop()
    }
  })

  it.each(['/missing.html', '/../package.json', '/%2e%2e/package.json'])('answers 404 for %s', async path => {
    writeFileSync(join(dir, 'iframe.html'), 'x')
    const server = await serveStatic(dir)
    try {
      expect((await get(server.url, path)).status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('refuses an encoded `..%2f` path to a file next to the served folder', async () => {
    // new URL() resolves `/../x` and `/%2e%2e/x` itself; only `%2f` reaches the guard.
    const served = join(dir, 'served')
    mkdirSync(served)
    writeFileSync(join(served, 'iframe.html'), 'x')
    writeFileSync(join(dir, 'secret.txt'), 'outside')
    const server = await serveStatic(served)
    try {
      expect((await get(server.url, '/..%2fsecret.txt')).status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('answers a malformed escape with 400 and keeps serving', async () => {
    writeFileSync(join(dir, 'iframe.html'), 'x')
    const server = await serveStatic(dir)
    try {
      expect((await get(server.url, '/%E0%A4%A')).status).toBe(400)
      expect((await get(server.url, '/iframe.html')).status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  it.skipIf(process.getuid?.() === 0)("answers a file it can't read with 500 and keeps serving", async () => {
    writeFileSync(join(dir, 'iframe.html'), 'x')
    writeFileSync(join(dir, 'locked.js'), 'x')
    chmodSync(join(dir, 'locked.js'), 0o000)
    const server = await serveStatic(dir)
    try {
      expect((await get(server.url, '/locked.js')).status).toBe(500)
      expect((await get(server.url, '/iframe.html')).status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  it('stops listening when stopped', async () => {
    const server = await serveStatic(dir)
    await server.stop()
    await expect(get(server.url, '/')).rejects.toThrow()
  })
})

describe('startStorybook', () => {
  it('builds into the output dir and serves it', async () => {
    const calls: string[][] = []
    const r = await startStorybook({
      cwd: '/repo',
      outputDir: dir,
      run: (cmd, args) => {
        calls.push([cmd, ...args])
        fakeBuild()
        return { ok: true }
      },
    })
    expect(calls).toEqual([['npm', 'run', 'build-storybook', '--', '--output-dir', dir, '--quiet']])
    expect(r.kind).toBe('served')
    if (r.kind !== 'served') return
    try {
      expect((await get(r.url, '/iframe.html')).body).toBe('<html>story</html>')
    } finally {
      await r.stop()
    }
  })

  it('returns skipped, not a throw, when the build fails', async () => {
    const r = await startStorybook({ cwd: '/repo', outputDir: dir, run: () => ({ ok: false, error: 'vite: boom' }) })
    expect(r).toEqual({ kind: 'skipped', reason: 'Storybook build failed: vite: boom' })
  })

  it('returns skipped when the build leaves no iframe.html', async () => {
    const r = await startStorybook({ cwd: '/repo', outputDir: dir, run: () => ({ ok: true }) })
    expect(r.kind).toBe('skipped')
    expect(r.kind === 'skipped' && r.reason).toMatch(/no iframe\.html/)
  })
})

describe('readStoryIndex', () => {
  it('lists stories with repo-relative import paths and drops docs entries', () => {
    fakeBuild()
    expect(readStoryIndex(dir)).toEqual([
      {
        id: 'banner--error',
        title: 'Primitives / Banner',
        name: 'Error',
        importPath: 'apps/admin/src/client/components/Banner.stories.ts',
      },
    ])
  })

  it('returns [] when there is no index', () => {
    expect(readStoryIndex(dir)).toEqual([])
  })
})

it('storyUrl opens the story alone in the iframe', () => {
  expect(storyUrl('http://127.0.0.1:5', 'validation-banner--single-error')).toBe(
    'http://127.0.0.1:5/iframe.html?id=validation-banner--single-error&viewMode=story',
  )
})

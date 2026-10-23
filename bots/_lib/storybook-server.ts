/**
 * Build the admin Storybook and serve the static output on a local port, so
 * a headless browser can open `iframe.html?id=<story-id>` (ADR-0016).
 *
 * Built from bot code, not a workflow step: bots can't push
 * `.github/workflows/**` (#840). A failed build is a `skipped` result, never
 * a throw — the visual check is advisory and must not stop the review.
 */
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'

export type CommandResult = { ok: true } | { ok: false; error: string }
export type RunCommand = (cmd: string, args: readonly string[], cwd: string) => CommandResult

export const runCommand: RunCommand = (cmd, args, cwd) => {
  const r = spawnSync(cmd, [...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (r.status === 0) return { ok: true }
  return { ok: false, error: (r.stderr?.trim() || r.error?.message || `exit ${r.status}`).slice(-1000) }
}

export interface StaticServer {
  url: string
  stop(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
}

/** Serve `dir` on 127.0.0.1 at a free port. Paths outside `dir` answer 404. */
export async function serveStatic(dir: string): Promise<StaticServer> {
  const root = resolve(dir)
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    let file = resolve(join(root, pathname))
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(404).end()
      return
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok())
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>(ok => {
        server.closeAllConnections()
        server.close(() => ok())
      }),
  }
}

export type StorybookResult =
  | { kind: 'served'; url: string; outputDir: string; stop(): Promise<void> }
  | { kind: 'skipped'; reason: string }

/** `npm run build-storybook` into `outputDir`, then serve it. Never throws. */
export async function startStorybook(o: {
  cwd: string
  outputDir: string
  run?: RunCommand
}): Promise<StorybookResult> {
  const built = (o.run ?? runCommand)(
    'npm',
    ['run', 'build-storybook', '--', '--output-dir', o.outputDir, '--quiet'],
    o.cwd,
  )
  if (!built.ok) return { kind: 'skipped', reason: `Storybook build failed: ${built.error}` }
  if (!existsSync(join(o.outputDir, 'iframe.html'))) {
    return { kind: 'skipped', reason: `Storybook build left no iframe.html in ${o.outputDir}` }
  }
  try {
    const server = await serveStatic(o.outputDir)
    return { kind: 'served', url: server.url, outputDir: o.outputDir, stop: server.stop }
  } catch (err) {
    return { kind: 'skipped', reason: `couldn't serve Storybook: ${err instanceof Error ? err.message : err}` }
  }
}

export interface StoryEntry {
  id: string
  title: string
  name: string
  /** Repo-relative, no leading `./`. */
  importPath: string
}

/** The stories (not docs) in a built Storybook's `index.json`; `[]` when unreadable. */
export function readStoryIndex(outputDir: string): StoryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(outputDir, 'index.json'), 'utf-8')) as {
      entries?: Record<string, { type?: string; id?: string; title?: string; name?: string; importPath?: string }>
    }
    return Object.values(raw.entries ?? {})
      .filter(e => e.type === 'story' && e.id && e.importPath)
      .map(e => ({
        id: e.id!,
        title: e.title ?? '',
        name: e.name ?? '',
        importPath: e.importPath!.replace(/^\.\//, ''),
      }))
  } catch {
    return []
  }
}

/** The URL that renders one story alone, as Storybook's own test runner opens it. */
export function storyUrl(baseUrl: string, storyId: string): string {
  return `${baseUrl}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story`
}

/**
 * Headless screenshots for the bots (ADR-0016 "validation stack").
 *
 * Calls Playwright directly rather than the `tools/mcp-dev` MCP server: a
 * bot in CI has no MCP host, only Node. Playwright is a root dev
 * dependency, so it is imported lazily — a runner without it (or without a
 * downloaded browser) gets an `ok: false` result instead of a crash, which
 * is what lets the visual check stay best-effort.
 *
 * CLI, for Agent B's extra shots (it has Bash, not this module):
 *   npx tsx bots/_lib/screenshot.ts <url> <out.png> [width] [height]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Viewport {
  width: number
  height: number
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 }

export type ScreenshotResult = { ok: true; base64: string } | { ok: false; error: string }

/** The slice of Playwright's Page this module uses; tests supply fakes. */
export interface PageLike {
  goto(url: string, opts: { waitUntil: 'load'; timeout: number }): Promise<{ status(): number } | null>
  waitForSelector(selector: string, opts: { state: 'attached'; timeout: number }): Promise<unknown>
  screenshot(opts: { type: 'png' }): Promise<Uint8Array>
  close(): Promise<void>
}

export interface BrowserLike {
  newPage(opts: { viewport: Viewport }): Promise<PageLike>
  close(): Promise<void>
}

export type LaunchBrowser = () => Promise<BrowserLike>

export interface ScreenshotOptions {
  /** Waited for after load; a timeout here still takes the shot (an empty story is itself a finding). */
  readySelector?: string
  timeoutMs?: number
  launch?: LaunchBrowser
}

export const launchChromium: LaunchBrowser = async () => {
  const { chromium } = await import('playwright')
  return (await chromium.launch()) as unknown as BrowserLike
}

/** Render `url` headless and return the PNG as base64. Never throws. */
export async function screenshot(
  url: string,
  viewport: Viewport = DEFAULT_VIEWPORT,
  opts: ScreenshotOptions = {},
): Promise<ScreenshotResult> {
  let browser: BrowserLike
  try {
    browser = await (opts.launch ?? launchChromium)()
  } catch (err) {
    return { ok: false, error: `couldn't launch the browser: ${message(err)}` }
  }
  try {
    return await shoot(browser, url, viewport, opts)
  } finally {
    await browser.close().catch(() => {})
  }
}

export interface ShotRequest {
  url: string
  /** Where the PNG is written. */
  path: string
}

export type ShotOutcome = ShotRequest & ({ ok: true } | { ok: false; error: string })

/** Many shots with one browser; each written to its `path`. Never throws. */
export async function captureScreenshots(
  shots: readonly ShotRequest[],
  viewport: Viewport = DEFAULT_VIEWPORT,
  opts: ScreenshotOptions = {},
): Promise<ShotOutcome[]> {
  if (shots.length === 0) return []
  let browser: BrowserLike
  try {
    browser = await (opts.launch ?? launchChromium)()
  } catch (err) {
    const error = `couldn't launch the browser: ${message(err)}`
    return shots.map(s => ({ ...s, ok: false as const, error }))
  }
  const out: ShotOutcome[] = []
  try {
    for (const shot of shots) {
      const r = await shoot(browser, shot.url, viewport, opts)
      if (!r.ok) {
        out.push({ ...shot, ok: false, error: r.error })
        continue
      }
      try {
        mkdirSync(dirname(shot.path), { recursive: true })
        writeFileSync(shot.path, Buffer.from(r.base64, 'base64'))
        out.push({ ...shot, ok: true })
      } catch (err) {
        out.push({ ...shot, ok: false, error: `couldn't write ${shot.path}: ${message(err)}` })
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }
  return out
}

async function shoot(
  browser: BrowserLike,
  url: string,
  viewport: Viewport,
  opts: ScreenshotOptions,
): Promise<ScreenshotResult> {
  const timeout = opts.timeoutMs ?? 15_000
  let page: PageLike
  try {
    page = await browser.newPage({ viewport })
  } catch (err) {
    return { ok: false, error: `couldn't open a page: ${message(err)}` }
  }
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout })
    const status = response?.status() ?? 0
    if (status >= 400) return { ok: false, error: `${url} answered ${status}` }
    if (opts.readySelector) {
      await page.waitForSelector(opts.readySelector, { state: 'attached', timeout }).catch(() => {})
    }
    const png = await page.screenshot({ type: 'png' })
    if (png.length === 0) return { ok: false, error: `empty screenshot of ${url}` }
    return { ok: true, base64: Buffer.from(png).toString('base64') }
  } catch (err) {
    return { ok: false, error: `couldn't load ${url}: ${message(err)}` }
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * Download Chromium for Playwright if it isn't on the runner. CI's bot
 * workflow installs npm deps but no browsers, and the workflow file can't
 * be changed by a bot (#840), so the install happens here at runtime.
 */
export function ensureChromium(cwd: string): { ok: true } | { ok: false; error: string } {
  const r = spawnSync('npx', ['playwright', 'install', 'chromium'], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf-8',
  })
  if (r.status === 0) return { ok: true }
  return { ok: false, error: (r.stderr?.trim() || r.error?.message || `exit ${r.status}`).slice(0, 500) }
}

/** True when Playwright can be imported and its Chromium binary is downloaded. */
export async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright')
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] : String(err)
}

async function cli(argv: readonly string[]): Promise<number> {
  const [url, out, width, height] = argv
  if (!url || !out) {
    console.error('usage: tsx bots/_lib/screenshot.ts <url> <out.png> [width] [height]')
    return 2
  }
  const viewport = {
    width: Number(width ?? DEFAULT_VIEWPORT.width),
    height: Number(height ?? DEFAULT_VIEWPORT.height),
  }
  const r = await screenshot(url, viewport, { readySelector: '#storybook-root > *' })
  if (!r.ok) {
    console.error(r.error)
    return 1
  }
  const path = resolve(out)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(r.base64, 'base64'))
  console.log(path)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(code => process.exit(code))
}

import { test, expect } from './fixtures'

/**
 * #1388: under `gazetta dev` the connection health check requested
 * `/api/health` — the site root, which always 404s — so once the
 * Offline banner appeared it never cleared, even after the network
 * recovered. The check now targets `${API_BASE}/health`
 * (`/admin/api/health` under the admin mount).
 *
 * Fails on current main: the banner survives a full offline heartbeat
 * interval (30 s) after the network comes back, and no "Connection
 * back" toast fires.
 */
test('offline then online hides the Offline banner within one check interval and shows "Connection back"', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)

  // The Offline banner and connection store live in App.vue, so any
  // admin route works; the site view is far lighter than the editor
  // on a cold dev server.
  await page.goto('/admin')
  await page.waitForSelector('[data-testid="publish-btn"]', { timeout: 60_000 })

  // The offline phase fails resource loads by design; the fixture
  // fails tests on console errors unless they opt out first.
  test.info().annotations.push({ type: 'allow-console-errors' })

  // Drop the network. Route aborts make the emulated offline
  // deterministic: without them, requests can hang pending under CDP
  // emulation and heartbeat failures never count. The store hears the
  // browser's offline event, degrades, then flips to Offline after
  // three failed heartbeats.
  await context.setOffline(true)
  await page.route('**/*', route => route.abort())
  const banner = page.locator('[data-testid="offline-banner"][data-state="offline"]')
  await expect(banner).toBeVisible({ timeout: 30_000 })

  // Network back. The browser's online event triggers an immediate
  // probe (probeNow), so the banner hides and the transient
  // "Connection back" toast fires well within one check interval.
  await page.unroute('**/*')
  await context.setOffline(false)
  await expect(banner).toBeHidden({ timeout: 40_000 })
  await expect(page.locator('[data-testid="global-toast"]')).toContainText('Connection back', { timeout: 5_000 })
})

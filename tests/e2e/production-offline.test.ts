import { test, expect } from '@playwright/test'

/**
 * Offline cold load of the production admin (`gazetta admin` serving the
 * built bundle): after one online visit, the service worker serves the app
 * shell when the network is gone. Dev mode has no service worker, so this
 * only runs in the prod-admin project.
 *
 * Covers the shell, icon font and Offline banner, and — since Cut 5b —
 * the site tree from the persisted query cache (design-offline.md, "The
 * site tree reads through the query cache") plus deep links served by
 * the service worker's navigation fallback. Before Cut 5b the tree said
 * "Failed to fetch" and deep links didn't load offline at all.
 *
 * Not covered: editing a page offline (needs the page manifest, template
 * schema and custom editor modules cached).
 */
test.describe('Production admin offline', () => {
  test('reloads offline from the service worker with icons and the Offline banner', async ({ page, context }) => {
    test.setTimeout(90_000)

    // First visit online: the app registers the service worker, which
    // precaches the bundle (including the primeicons woff2).
    await page.goto('/admin')
    await expect(page.locator('[data-testid="site-page-home"]')).toBeVisible({ timeout: 20_000 })
    await page.waitForFunction(
      async () => (await navigator.serviceWorker.getRegistrations()).some(r => r.active?.state === 'activated'),
      null,
      { timeout: 30_000 },
    )
    // A page loaded before activation isn't controlled; reload once online.
    await page.reload()
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)

    await context.setOffline(true)
    await page.reload()

    // App shell from the service worker.
    await expect(page).toHaveTitle('Gazetta CMS')
    await expect(page.locator('[data-testid="publish-btn"]')).toBeVisible()
    // Icon font precached (not just the CSS): icons render offline.
    await expect
      .poll(() => page.evaluate(async () => (await document.fonts.ready, document.fonts.check('1em primeicons'))))
      .toBe(true)
    // Connection state settles on Offline (passes through "Connection unstable").
    await expect(page.locator('[data-testid="offline-banner"]')).toContainText('Offline', { timeout: 30_000 })
    // Site tree from the persisted query cache, not "Failed to fetch".
    await expect(page.locator('[data-testid="site-page-home"]')).toBeVisible({ timeout: 20_000 })

    // A deep link still loads offline (service-worker navigation fallback).
    await page.goto('/admin/pages/home')
    await expect(page.locator('[data-testid="site-page-home"]')).toBeVisible({ timeout: 20_000 })

    // Back online: the banner clears.
    await context.setOffline(false)
    await expect(page.locator('[data-testid="offline-banner"]')).toBeHidden({ timeout: 30_000 })
  })
})

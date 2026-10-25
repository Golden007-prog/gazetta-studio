import { expect, test } from './fixtures'

/**
 * #1399: a supported browser must never see the too-old message that
 * index.html shows when the pre-bundle check fails. Old-browser behavior
 * cannot be simulated with a modern Playwright Chromium, so this only
 * covers the supported-browser side.
 */
test('supported browser does not show the browser-too-old message', async ({ page }) => {
  await page.goto('/admin')
  await page.waitForSelector('[data-testid="publish-btn"]', { timeout: 60_000 })
  await expect(page.locator('#browser-too-old')).toBeHidden()
})

import { expect, test } from './fixtures'

/**
 * #1399: the supported-browser side (no false positive) and the
 * failing-probe side of the pre-bundle check in index.html. The
 * failing side is exercised by controlled API removal before page
 * scripts run, which proves the unhide path fires; it does not claim
 * compatibility with any real old browser.
 */
test('supported browser does not show the browser-too-old message', async ({ page }) => {
  await page.goto('/admin')
  await page.waitForSelector('[data-testid="publish-btn"]', { timeout: 60_000 })
  await expect(page.locator('#browser-too-old')).toBeHidden()
})

test('browser missing a probed feature sees the browser-too-old message', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'structuredClone', { value: undefined })
  })
  // The app may hit the removed API and log errors after the message
  // shows; that noise is expected here.
  test.info().annotations.push({ type: 'allow-console-errors' })
  await page.goto('/admin')
  await expect(page.locator('#browser-too-old')).toBeVisible()
  await expect(page.locator('#browser-too-old')).toContainText('Chrome or Edge 111+, Firefox 114+ or Safari 16.4+')
})

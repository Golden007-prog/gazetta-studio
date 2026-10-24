import { test, expect } from './fixtures'

/**
 * The preview shows a page's HTML, which carries script from templates and
 * content. It runs in a sandboxed frame with an origin of its own, so that
 * script can't reach the admin page or act as the person previewing.
 */
test.describe('Preview frame', () => {
  test('runs page script in its own origin', async ({ page }) => {
    await page.goto('/admin/pages/home')
    await page.frameLocator('[data-testid="preview-iframe"]').locator('[data-gz]').first().waitFor({ timeout: 10000 })

    const frame = await (await page.locator('[data-testid="preview-iframe"]').elementHandle())?.contentFrame()
    const seen = await frame?.evaluate(() => {
      let parentAccess: string
      try {
        parentAccess = String(window.parent.document.title)
      } catch (err) {
        parentAccess = (err as Error).name
      }
      return { origin: self.origin, parentAccess }
    })

    expect(seen).toEqual({ origin: 'null', parentAccess: 'SecurityError' })
  })
})

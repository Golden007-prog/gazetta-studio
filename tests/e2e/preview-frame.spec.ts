import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

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

  test('applies an edit to the preview in place, without reloading it', async ({ page }) => {
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    const preview = page.frameLocator('[data-testid="preview-iframe"]')
    await preview.locator('[data-gz]').first().waitFor({ timeout: 10000 })

    // A mark on the frame's current document; a reload would drop it.
    const frame = await (await page.locator('[data-testid="preview-iframe"]').elementHandle())?.contentFrame()
    await frame?.evaluate(() => {
      ;(window as Window & { gzMark?: boolean }).gzMark = true
    })

    const title = page.locator('input[name="root_title"]').first()
    await title.waitFor({ timeout: 10000 })
    await title.fill('Updated in place')

    await expect(preview.locator('h1', { hasText: 'Updated in place' })).toBeVisible({ timeout: 15000 })
    expect(await frame?.evaluate(() => (window as Window & { gzMark?: boolean }).gzMark)).toBe(true)
  })
})

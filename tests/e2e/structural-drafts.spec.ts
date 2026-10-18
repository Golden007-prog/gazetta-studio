import { test, expect } from './fixtures'
import { openEditor, storedDraftKeys } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * A reorder kept across a reload comes back only on its own page (#979).
 * Restored as pending at once, it enabled Save on whichever page was open.
 */
test('a reorder draft survives a reload and comes back only on its own page', async ({ page }) => {
  test.setTimeout(90_000)
  const tree = new ComponentTreePom(page)
  const order = () =>
    page
      .locator('[data-testid^="component-"]')
      .evaluateAll(els => els.map(e => e.getAttribute('data-testid')).join(','))
  await openEditor(page, 'home')
  await tree.row('hero').waitFor({ timeout: 20000 })
  const before = await order()
  await tree.moveDown('hero')
  await expect.poll(order).not.toBe(before)
  const reordered = await order()
  // Wait for the debounced write so a reload can't beat it.
  await expect.poll(() => storedDraftKeys(page, 'structural')).toContain(JSON.stringify(['page', 'home', '']))

  // Reload onto another page: nothing to save, and leaving edit mode doesn't ask.
  await openEditor(page, 'about')
  await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()
  await page.click('[data-testid="back-to-browse"]')
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/pages/about')

  // Its own page: the reorder is back, pending.
  await openEditor(page, 'home')
  await tree.row('hero').waitFor({ timeout: 20000 })
  await expect.poll(order).toBe(reordered)
  await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
})

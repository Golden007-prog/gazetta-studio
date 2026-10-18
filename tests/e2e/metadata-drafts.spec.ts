import { test, expect } from './fixtures'
import { openEditor, storedMetadataTitles } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * An unsaved SEO edit is kept across a reload, like other drafts, and
 * becomes pending again only when its page is opened (design-editor-ux.md,
 * "Page metadata is a pending lane"). Restoring reorder drafts as pending
 * at once made them act on whichever page was open (#979).
 */
test('an SEO draft survives a reload and comes back only on its own page', async ({ page }) => {
  test.setTimeout(90_000)
  await openEditor(page, 'home')
  const title = page.locator('[data-testid="meta-title"]')
  await title.waitFor({ timeout: 20000 })
  await title.fill('Kept across reload')
  // Wait for the debounced write so a reload can't beat it.
  await expect.poll(() => storedMetadataTitles(page)).toContain('Kept across reload')

  // Another page: nothing to save, and leaving edit mode doesn't ask.
  await openEditor(page, 'about')
  await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()
  await page.click('[data-testid="back-to-browse"]')
  await expect.poll(() => new URL(page.url()).pathname).toBe('/admin/pages/about')

  // Its own page: the edit is back, pending.
  await openEditor(page, 'home')
  await title.waitFor({ timeout: 20000 })
  await expect(title).toHaveValue('Kept across reload')
  const tree = new ComponentTreePom(page)
  await expect(tree.dirtyDot('home')).toBeVisible()
  await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()

  // Reverting it removes the stored draft too.
  await tree.revert('home')
  await expect.poll(() => storedMetadataTitles(page)).not.toContain('Kept across reload')
})

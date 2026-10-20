import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * Edits to a page's own content fields, on the page row. The starter's
 * `page-default` has no fields, so fixtures.ts gives each worker copy an
 * optional `intro` field. #981 fixed the page row's dot for these edits
 * (it compared the page directory with the editor path `'_root'`).
 */

async function editIntro(page: import('@playwright/test').Page, value: string) {
  await openEditor(page, 'home')
  const tree = new ComponentTreePom(page)
  // The page row is selected on open; clicking it again can remount the form mid-fill.
  const intro = page.locator('input[name="root_intro"]')
  await intro.waitFor({ timeout: 20000 })
  await intro.fill(value)
  await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
  return { intro, tree }
}

test.describe("Edits to a page's own content", () => {
  test('the page row shows a dot', async ({ page }) => {
    const { tree } = await editIntro(page, 'Edited intro')
    await expect(tree.dirtyDot('home')).toBeVisible()
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
  })

  test("the page row's revert drops it", async ({ page }) => {
    const { intro, tree } = await editIntro(page, 'Reverted intro')
    await expect(tree.dirtyDot('home')).toBeVisible()
    await tree.revert('home')
    await expect(intro).toHaveValue('')
    await expect(tree.dirtyDot('home')).toBeHidden()
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()
  })

  test('opening another component and coming back keeps the edit', async ({ page }) => {
    const { intro, tree } = await editIntro(page, 'Kept intro')
    await tree.open('hero')
    await expect(intro).toBeHidden()
    await expect(tree.dirtyDot('home')).toBeVisible()
    await tree.open('home')
    await expect(intro).toHaveValue('Kept intro')
    await expect(tree.dirtyDot('home')).toBeVisible()
  })
})

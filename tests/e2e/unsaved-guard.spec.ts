import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { SiteTreePom } from './pages/SiteTree'
import { ComponentTreePom } from './pages/ComponentTree'

test.describe('Unsaved changes dialog', () => {
  test('shows styled dialog with Save/Discard/Cancel when leaving with unsaved changes', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // Click hero component to start editing
    await tree.openEditor('hero')

    // Type into a field to make it dirty
    const input = page.locator('[data-testid="editor-container"] input').first()
    await input.fill('changed content')

    // Click back button in toolbar — should show unsaved dialog
    await page.click('[data-testid="back-to-browse"]')

    // Verify styled dialog appears (not native confirm)
    const dialog = page.locator('.p-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog).toContainText('Unsaved Changes')
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: "Don't Save" })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()
  })

  test('Cancel keeps the editor open', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    await tree.openEditor('hero')

    const input = page.locator('[data-testid="editor-container"] input').first()
    await input.fill('changed content')

    await page.click('[data-testid="back-to-browse"]')
    await page.locator('.p-dialog').waitFor({ timeout: 5000 })

    // Click Cancel
    await page.locator('.p-dialog button', { hasText: 'Cancel' }).click()

    // Dialog closes, still in edit mode with editor visible
    await expect(page.locator('.p-dialog')).not.toBeVisible()
    await expect(page.locator('[data-testid="editor-container"]')).toBeVisible()
  })

  test("Don't Save exits edit mode", async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    await tree.openEditor('hero')

    const input = page.locator('[data-testid="editor-container"] input').first()
    await input.fill('changed content')

    await page.click('[data-testid="back-to-browse"]')
    await page.locator('.p-dialog').waitFor({ timeout: 5000 })

    // Click Discard
    await page.locator('.p-dialog button', { hasText: "Don't Save" }).click()

    // Dialog closes, back to browse mode (SiteTree visible)
    await expect(page.locator('.p-dialog')).not.toBeVisible()
    const siteTree = new SiteTreePom(page)
    await expect(siteTree.pageRow('home')).toBeVisible()
  })
})

test.describe('Component stashing', () => {
  test('switching components stashes edits and shows dot', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // Edit hero
    await tree.openEditor('hero')
    const input = page.locator('[data-testid="editor-container"] input').first()
    await input.fill('stashed edit')

    // Switch to features — no dialog, hero should show dot
    await tree.openEditor('features')

    // Hero should have a dirty dot
    await expect(tree.dirtyDot('hero')).toBeVisible()
  })

  test('switching back restores stashed edits', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // Edit hero
    await tree.openEditor('hero')
    const input = page.locator('[data-testid="editor-container"] input').first()
    await input.fill('restored edit')

    // Switch to features
    await tree.openEditor('features')

    // Switch back to hero — click the label directly to avoid the revert
    // button. The row's `.node-label` is the click-safe target when the
    // row has a dirty state; `tree.open()` would hit whichever child the
    // row's `.click()` resolves to and can land on the hover-revealed
    // revert button in CI timing.
    await tree.row('hero').locator('.node-label').click()
    const restoredInput = tree.editor('hero').locator('input').first()
    await expect(restoredInput).toHaveValue('restored edit', { timeout: 10000 })
  })

  test('discard clears current dot, stashed dots remain', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // Edit hero
    await tree.openEditor('hero')
    await page.locator('[data-testid="editor-container"] input').first().fill('hero pending')

    // Switch to features — hero stashed with dot
    await tree.openEditor('features')

    // Hero should have stashed dot
    const heroDot = tree.dirtyDot('hero')
    await expect(heroDot).toBeVisible({ timeout: 5000 })

    // Edit features to make it dirty
    await page.locator('[data-testid="editor-container"] input').first().fill('features pending')

    // Hover hero to reveal revert button, click it
    const heroRevert = tree.revertButton('hero')
    await tree.row('hero').hover()
    await expect(heroRevert).toBeVisible({ timeout: 3000 })
    await heroRevert.click()

    // Hero dot gone, features still dirty (current editor)
    await expect(heroDot).not.toBeVisible()
  })
})

test.describe('Escape key behavior', () => {
  test('Escape from unsaved dialog does not reopen it', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    await tree.openEditor('hero')
    await page.locator('[data-testid="editor-container"] input').first().fill('escape test')

    await page.click('[data-testid="back-to-browse"]')
    const dialog = page.locator('.p-dialog')
    await dialog.waitFor({ timeout: 5000 })

    // Press Escape to close dialog
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible({ timeout: 2000 })

    // Wait a moment — dialog should NOT reappear
    await page.waitForTimeout(500)
    await expect(dialog).not.toBeVisible()
  })
})

// Choosing Save in the dialog used to clear the editor even when the save
// failed, so the edits were lost. A failed save must keep them and stay.
test.describe('A failed save in the dialog keeps the edits', () => {
  async function failEverySave(page: import('@playwright/test').Page) {
    await page.route('**/admin/api/pages/**', route =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Disk full' }) })
        : route.continue(),
    )
  }

  async function dirtyHero(page: import('@playwright/test').Page) {
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    const title = page.locator('input[name="root_title"]').first()
    await title.waitFor({ timeout: 15000 })
    await title.fill('Edit that must survive')
    return title
  }

  test('switching target', async ({ page }) => {
    test.info().annotations.push({ type: 'allow-console-errors' }) // the failed PUT
    const title = await dirtyHero(page)
    await failEverySave(page)
    await page.locator('[data-testid="active-target-indicator"]').click()
    await page.locator('[data-testid="active-target-menu"]').getByRole('menuitem', { name: 'staging' }).click()
    const dialog = page.getByRole('dialog', { name: /unsaved changes/i })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(dialog).toBeHidden()
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('local')
    await expect(title).toHaveValue('Edit that must survive')
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
  })

  test('switching locale', async ({ page }) => {
    test.info().annotations.push({ type: 'allow-console-errors' }) // the failed PUT
    const title = await dirtyHero(page)
    await failEverySave(page)
    await page.locator('[data-testid="locale-fr"]').click()
    const dialog = page.getByRole('dialog', { name: /unsaved changes/i })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(dialog).toBeHidden()
    expect(new URL(page.url()).searchParams.get('locale')).toBeNull()
    await expect(title).toHaveValue('Edit that must survive')
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
  })

  test('opening a linked fragment', async ({ page }) => {
    test.info().annotations.push({ type: 'allow-console-errors' }) // the failed PUT
    await dirtyHero(page)
    await failEverySave(page)
    await new ComponentTreePom(page).open('header') // a fragment reference: shows "Edit @header"
    await page.locator('[data-testid="fragment-go-link"]').click()
    const dialog = page.getByRole('dialog', { name: /unsaved changes/i })
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(dialog).toBeHidden()
    expect(new URL(page.url()).pathname).toBe('/admin/pages/home/edit')
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
  })
})

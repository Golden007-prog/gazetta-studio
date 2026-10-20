import { test, expect } from './fixtures'
import { SiteTreePom } from './pages/SiteTree'

test.describe('Deep linking', () => {
  test('direct URL to page selects it in browse mode', async ({ page }) => {
    await page.goto('/admin/pages/about')
    const tree = new SiteTreePom(page)
    await expect(tree.selectedPage('about')).toBeVisible({ timeout: 10000 })
    // Preview should show about page
    const iframe = page.frameLocator('[data-testid="preview-iframe"]')
    await iframe.locator('[data-gz]').first().waitFor({ timeout: 10000 })
  })

  test('direct URL to page/edit enters edit mode', async ({ page }) => {
    await page.goto('/admin/pages/home/edit')
    // Should be in edit mode with component tree visible
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })
  })

  test('direct URL to fragment selects it', async ({ page }) => {
    await page.goto('/admin/fragments/header')
    const tree = new SiteTreePom(page)
    await expect(tree.selectedFragment('header')).toBeVisible({ timeout: 10000 })
  })

  test('back button navigates from edit to browse', async ({ page }) => {
    await page.goto('/admin/pages/home')
    const tree = new SiteTreePom(page)
    await tree.selectedPage('home').waitFor({ timeout: 10000 })

    // Enter edit mode via preview click
    const iframe = page.frameLocator('[data-testid="preview-iframe"]')
    await iframe.locator('[data-gz]').first().waitFor({ timeout: 10000 })
    await iframe.locator('[data-gz]').first().click()
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })

    // URL should reflect edit mode
    await expect(page).toHaveURL(/\/pages\/home\/edit/)

    // Browser back should return to browse mode
    await page.goBack()
    await expect(page).toHaveURL(/\/pages\/home$/)
    await expect(tree.pageRow('home')).toBeVisible()
  })

  test('URL updates when switching pages', async ({ page }) => {
    await page.goto('/admin/pages/home')
    const tree = new SiteTreePom(page)
    await tree.selectedPage('home').waitFor({ timeout: 10000 })

    await tree.openPage('about')
    await expect(page).toHaveURL(/\/pages\/about/)
    await expect(tree.selectedPage('about')).toBeVisible()
  })

  test('clicking a link in preview while editing keeps the user in edit mode on the destination', async ({ page }) => {
    // Regression: clicking a preview link used to drop the user back to
    // browse mode by pushing /pages/{name} (no /edit suffix), even
    // though they were actively editing. The fix preserves the current
    // ui mode in the gazetta:navigate handler.
    await page.goto('/admin/pages/home/edit')
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })
    await expect(page).toHaveURL(/\/pages\/home\/edit/)

    // The starter site's header fragment includes a /about nav link.
    const iframe = page.frameLocator('[data-testid="preview-iframe"]')
    const aboutLink = iframe.locator('a[href="/about"]').first()
    // The bridge script is injected at the end of the preview's <body>, so
    // the link exists before its click handler does; a click in that gap
    // is lost. #gz-select is created by the same synchronous script that
    // attaches the handler. The preview can also be re-rendered after the
    // first load, dropping a click in flight, so the click is retried.
    await expect(async () => {
      await iframe.locator('#gz-select').waitFor({ state: 'attached', timeout: 2000 })
      await aboutLink.click({ timeout: 2000 })
      // After navigation we should be on the about page AND still in edit
      // mode — the URL must end with /edit, and the component tree (only
      // rendered in edit mode) must be visible.
      await expect(page).toHaveURL(/\/pages\/about\/edit/, { timeout: 2000 })
    }).toPass({ timeout: 15000 })
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })
  })

  test('clicking a preview link with unsaved edits fires the guard dialog', async ({ page }) => {
    // The preview link triggers a regular `router.push`, so the
    // existing unsaved-changes guard (router.ts beforeEach) must fire
    // before navigating away from a dirty editor — same as clicking a
    // tree row or the toolbar back button.
    await page.goto('/admin/pages/home/edit')
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })

    // Open hero editor and dirty the form.
    await page.click('[data-testid="component-hero"]')
    await page.waitForSelector('[data-testid="editor-container"]')
    const input = page.locator('[data-testid="editor-container"] input').first()
    await input.fill('preview-link-dirty edit')
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()

    // Click the /about preview link — should NOT navigate immediately.
    const iframe = page.frameLocator('[data-testid="preview-iframe"]')
    const aboutLink = iframe.locator('a[href="/about"]').first()
    await aboutLink.click()

    // Unsaved-changes dialog appears.
    const dialog = page.locator('.p-dialog')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog).toContainText('Unsaved Changes')

    // Cancel keeps us on /home/edit with the dirty value intact.
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page).toHaveURL(/\/pages\/home\/edit/)
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
  })
})

test.describe('Deep linking - component hash', () => {
  test('hash #hero opens hero editor on page load', async ({ page }) => {
    await page.goto('/admin/pages/home/edit#hero')
    await page.waitForSelector('[data-testid="editor-container"]', { timeout: 10000 })
    // Breadcrumb's current segment shows the component name (#82
    // replaced the template-name jargon h3 with a user-set-name path).
    await expect(page.locator('[data-testid="breadcrumb-segment-hero"]')).toBeVisible()
    // Hero should be selected in tree
    await expect(page.locator('[data-testid="component-hero"].selected')).toBeVisible()
  })

  test('hash persists across page refresh', async ({ page }) => {
    await page.goto('/admin/pages/home/edit')
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })
    // Click hero to set the hash
    await page.click('[data-testid="component-hero"]')
    await page.waitForSelector('[data-testid="editor-container"]')
    // Verify URL has #hero
    await expect(page).toHaveURL(/#hero/)
    // Reload the page
    await page.reload()
    // After reload, hero editor should still be open
    await page.waitForSelector('[data-testid="editor-container"]', { timeout: 10000 })
    await expect(page.locator('[data-testid="breadcrumb-segment-hero"]')).toBeVisible()
  })

  test('fragment link hash #@header/logo shows fragment link with logo selected', async ({ page }) => {
    await page.goto('/admin/pages/home/edit#@header/logo')
    await page.waitForSelector('[data-testid="editor-fragment-link"]', { timeout: 10000 })
    await expect(page.locator('[data-testid="editor-fragment-link"]')).toContainText('Edit @header')
    // Logo should be selected in tree
    await expect(page.locator('[data-testid="component-logo"].selected')).toBeVisible()
  })

  test('hash on fragment page #logo opens logo editor', async ({ page }) => {
    await page.goto('/admin/fragments/header/edit#logo')
    await page.waitForSelector('[data-testid="editor-container"]', { timeout: 10000 })
    await expect(page.locator('[data-testid="breadcrumb-segment-logo"]')).toBeVisible()
    await expect(page.locator('[data-testid="component-logo"].selected')).toBeVisible()
  })

  test('no hash opens root editor by default', async ({ page }) => {
    await page.goto('/admin/pages/home/edit')
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })
    // Root selected — breadcrumb shows just the page name `home`
    // (#82 replaced the template-name jargon h3 with the user-set
    // page name; the SEO metadata editor still renders below).
    await expect(page.locator('[data-testid="breadcrumb-segment-home"]')).toBeVisible()
  })
})

test.describe('Deep linking - dev playground', () => {
  test('direct URL to editor pre-selects it', async ({ page }) => {
    await page.goto('/admin/dev/editor/hero')
    await page.waitForSelector('[data-testid="playground-mount"]', { timeout: 10000 })
    const inspector = page.locator('[data-testid="playground-inspector"]')
    await expect(inspector).toContainText('Welcome to Gazetta', { timeout: 10000 })
  })

  test('selecting editor updates URL', async ({ page }) => {
    await page.goto('/admin/dev')
    await page.waitForSelector('[data-testid="dev-playground"]')
    await page.click('[data-testid="playground-editor-hero"]')
    await expect(page).toHaveURL(/\/dev\/editor\/hero/, { timeout: 5000 })
  })

  test('selecting field updates URL', async ({ page }) => {
    await page.goto('/admin/dev')
    await page.waitForSelector('[data-testid="dev-playground"]')
    await page.click('[data-testid="playground-field-brand-color"]')
    await expect(page).toHaveURL(/\/dev\/field\/brand-color/, { timeout: 5000 })
  })
})

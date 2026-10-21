import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { SiteTreePom } from './pages/SiteTree'
import { ComponentTreePom } from './pages/ComponentTree'

test.describe('Default editor', () => {
  test('loads @rjsf form for template without custom editor', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // Click a component without custom editor (features)
    await tree.openEditor('features')

    // Should show the default form with heading field
    const editorText = await page.locator('[data-testid="editor-panel"]').textContent()
    expect(editorText).toContain('heading')
  })
})

test.describe('Custom editor', () => {
  test('loads custom editor for hero template', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // Click hero component (has custom editor)
    await tree.openEditor('hero')

    // Wait for custom editor to load and render content
    const editorPanel = page.locator('[data-testid="editor-panel"]')
    await expect(editorPanel).toContainText('Welcome to Gazetta', { timeout: 20000 })
  })

  test('falls back to default form when switching to template without editor', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // First load hero (custom editor)
    await tree.openEditor('hero')

    // Then switch to features (no custom editor)
    await tree.open('features')
    // Wait for the editor to remount with the new content
    await page.waitForFunction(
      () => {
        const panel = document.querySelector('[data-testid="editor-panel"]')
        return panel?.textContent?.includes('heading')
      },
      { timeout: 5000 },
    )

    const editorText = await page.locator('[data-testid="editor-panel"]').textContent()
    expect(editorText).toContain('heading')
  })
})

test.describe('Custom field', () => {
  test('brand-color field renders inside banner editor', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)

    // Click banner component (uses custom brand-color field)
    await tree.openEditor('banner')

    // Wait for the custom field to load (async import)
    await page.waitForFunction(
      () => {
        const container = document.querySelector('[data-testid="editor-container"]')
        return container?.querySelector('input[type="color"]') !== null
      },
      { timeout: 10000 },
    )

    // Verify preset color buttons exist (brand-color has 6 presets)
    const buttons = await page.locator('[data-testid="editor-container"] button[title]').count()
    expect(buttons).toBeGreaterThanOrEqual(6)

    // Verify the hex input has a color value
    const hexInput = page.locator('[data-testid="editor-container"] input[type="text"]').last()
    const value = await hexInput.inputValue()
    expect(value).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

test.describe('Editor breadcrumb (#82)', () => {
  test('shows page-name > component-name when editing a top-level component', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    await tree.open('hero')
    await page.waitForSelector('[data-testid="editor-breadcrumb"]', { timeout: 10000 })

    const breadcrumb = page.locator('[data-testid="editor-breadcrumb"]')
    await expect(breadcrumb.locator('[data-testid="breadcrumb-segment-home"]')).toBeVisible()
    await expect(breadcrumb.locator('[data-testid="breadcrumb-segment-hero"]')).toBeVisible()

    // page-name segment is a button (clickable); current segment is a span.
    const homeSeg = breadcrumb.locator('[data-testid="breadcrumb-segment-home"]')
    const heroSeg = breadcrumb.locator('[data-testid="breadcrumb-segment-hero"]')
    await expect(homeSeg).toHaveJSProperty('tagName', 'BUTTON')
    await expect(heroSeg).toHaveJSProperty('tagName', 'SPAN')
  })

  test('clicking the page-name segment navigates back to root (clears the hash)', async ({ page }) => {
    await openEditor(page, 'home')
    const tree = new ComponentTreePom(page)
    await tree.open('hero')
    await page.waitForSelector('[data-testid="editor-breadcrumb"]', { timeout: 10000 })

    // We're on /pages/home/edit#hero; click home segment.
    expect(new URL(page.url()).hash).toBe('#hero')
    await page.locator('[data-testid="breadcrumb-segment-home"]').click()
    await expect.poll(() => new URL(page.url()).hash).toBe('')
  })
})

test.describe('Rapid selection', () => {
  test('last click wins when rapidly switching pages', { retry: 1 }, async ({ page }) => {
    await page.goto('/admin')
    const tree = new SiteTreePom(page)
    await expect(tree.pageRow('home')).toBeVisible()

    // Click two pages rapidly without waiting for the first to load.
    // Intentionally omit `await` on the first click so the two commands
    // race — we're testing the "last click wins" invariant.
    void tree.pageRow('home').click()
    await tree.openPage('about')

    // Wait for preview to settle — the about page should win
    const iframe = page.frameLocator('[data-testid="preview-iframe"]')
    await iframe.locator('[data-gz]').first().waitFor({ timeout: 10000 })

    // The selected item in the tree should be about, not home
    await expect(tree.selectedPage('about')).toBeVisible()
    await expect(tree.selectedPage('home')).not.toBeVisible()
  })
})

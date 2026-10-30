import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * The rich-text field (tiptap, `format.richtext()`) end to end: type,
 * format from the toolbar, save, and check the HTML that lands on disk and
 * in the preview. Guards tiptap upgrades — nothing else exercises the
 * widget in a real browser.
 *
 * Uses the starter's `showcase` page, whose `showcase-demo` component has a
 * rich-text `body` field.
 */
const pageJsonPath = (projectDir: string) => join(projectDir, 'sites/main/targets/local/pages/showcase/page.json')

test.describe('Rich-text field', () => {
  // The worker's site copy is shared with other spec files: put the page
  // back as this test found it.
  let original: string | undefined
  test.beforeEach(({ testSite }) => {
    original = readFileSync(pageJsonPath(testSite.projectDir), 'utf8')
  })
  test.afterEach(({ testSite }) => {
    if (original !== undefined) writeFileSync(pageJsonPath(testSite.projectDir), original)
  })

  test('toolbar formatting is saved as HTML and shown in the preview', async ({ page, testSite }) => {
    await openEditor(page, 'showcase')
    await new ComponentTreePom(page).open('showcase-demo')

    const editor = page.locator('[data-testid="richtext-editor"]')
    const prose = editor.locator('.tiptap')
    await expect(prose).toBeVisible({ timeout: 20000 })

    // Caret to the end of the existing body. There's no "end of document"
    // key that works on every platform, and ProseMirror ignores a DOM
    // selection set from outside, so use tiptap's own command (tiptap puts
    // the editor instance on its DOM node).
    await prose.evaluate(el => {
      ;(el as HTMLElement & { editor: { commands: { focus(pos: 'end'): boolean } } }).editor.commands.focus('end')
    })
    // tiptap applies the focus on the next animation frame; a key pressed
    // before then is lost (seen in CI: Enter never split the paragraph).
    await expect(prose).toBeFocused()
    // New paragraph after the existing body, made an H2.
    await page.keyboard.press('Enter')
    await editor.locator('[data-testid="richtext-h2"]').click()
    await page.keyboard.type('E2E heading')
    await expect(prose.locator('h2', { hasText: 'E2E heading' })).toBeVisible()

    // Next paragraph: plain text, then a bold run toggled from the toolbar.
    await page.keyboard.press('Enter')
    await page.keyboard.type('Plain then ')
    await editor.locator('[data-testid="richtext-bold"]').click()
    await page.keyboard.type('bold words')
    await expect(prose.locator('strong', { hasText: 'bold words' })).toBeVisible()
    await expect(editor.locator('[data-testid="richtext-bold"]')).toHaveClass(/active/)

    // Link: toggle bold off, type a word, select it, add a link via the
    // toolbar (it asks for the URL with window.prompt).
    await editor.locator('[data-testid="richtext-bold"]').click()
    await page.keyboard.type(' docs')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
    page.once('dialog', d => d.accept('https://example.com/docs'))
    await editor.locator('[data-testid="richtext-link"]').click()
    await expect(prose.locator('a[href="https://example.com/docs"]', { hasText: 'docs' })).toBeVisible()

    // Draft preview reflects the unsaved edit.
    const preview = page.frameLocator('[data-testid="preview-iframe"]')
    await expect(preview.locator('strong', { hasText: 'bold words' })).toBeVisible({ timeout: 15000 })

    const saveBtn = page.locator('[data-testid="save-btn"]')
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })

    const saved = JSON.parse(readFileSync(pageJsonPath(testSite.projectDir), 'utf8'))
    const demo = saved.components.find((c: { name?: string }) => c.name === 'showcase-demo')
    expect(demo.content.body).toContain('<h2>E2E heading</h2>')
    expect(demo.content.body).toContain('<p>Plain then <strong>bold words</strong> <a ')
    // The link options configured through StarterKit apply.
    const link = demo.content.body.match(/<a [^>]*>docs<\/a>/)?.[0]
    expect(link).toContain('href="https://example.com/docs"')
    expect(link).toContain('rel="noopener noreferrer"')

    // The saved HTML loads back into the editor.
    await page.reload()
    await new ComponentTreePom(page).open('showcase-demo')
    const reloaded = page.locator('[data-testid="richtext-editor"] .tiptap')
    await expect(reloaded.locator('h2', { hasText: 'E2E heading' })).toBeVisible({ timeout: 20000 })
    await expect(reloaded.locator('strong', { hasText: 'bold words' })).toBeVisible()
    await expect(reloaded.locator('a[href="https://example.com/docs"]', { hasText: 'docs' })).toBeVisible()
  })
})

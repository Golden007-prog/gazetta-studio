import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * Reordering items in an array field of the default editor
 * (`@hello-pangea/dnd`): keyboard drag, mouse drag, and the move buttons,
 * then save and check the order on disk. Guards dnd and rjsf upgrades —
 * nothing else exercises reordering in a real browser.
 *
 * Uses the starter's header fragment: its `nav` component has a `links`
 * array — Home, About, Blog.
 */
const fragmentJson = (projectDir: string) => join(projectDir, 'sites/main/targets/local/fragments/header/fragment.json')

function savedLabels(projectDir: string): string[] {
  const json = JSON.parse(readFileSync(fragmentJson(projectDir), 'utf8'))
  const nav = json.components.find((c: { name?: string }) => c.name === 'nav')
  return nav.content.links.map((l: { label: string }) => l.label)
}

async function openNavLinks(page: Page): Promise<{ items: Locator; labels: () => Promise<string[]> }> {
  await page.goto('/admin/fragments/header/edit')
  await page.waitForSelector('[data-testid^="component-"]', { timeout: 10000 })
  await new ComponentTreePom(page).open('nav')
  const array = page.locator('[data-testid="array-root_links"]')
  const items = array.locator('[data-testid="array-item"]')
  await expect(items).toHaveCount(3, { timeout: 20000 })
  const labels = () =>
    items.locator('input[id$="_label"]').evaluateAll(els => els.map(e => (e as HTMLInputElement).value))
  return { items, labels }
}

async function save(page: Page): Promise<void> {
  const saveBtn = page.locator('[data-testid="save-btn"]')
  await expect(saveBtn).toBeEnabled()
  await saveBtn.click()
  await expect(saveBtn).toBeDisabled({ timeout: 10000 })
}

test.describe('Array field reorder', () => {
  test('keyboard drag and move buttons reorder items, saved in order', async ({ page, testSite }) => {
    const { items, labels } = await openNavLinks(page)
    expect(await labels()).toEqual(['Home', 'About', 'Blog'])

    // Keyboard drag (the library's accessible path): lift Home with Space,
    // move it down two places, drop with Space.
    await items.nth(0).locator('[data-testid="array-item-handle"]').focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await expect.poll(labels).toEqual(['About', 'Blog', 'Home'])

    // Move-up button on the last item.
    await items.nth(2).locator('[data-testid="array-item-move-up"]').click()
    await expect.poll(labels).toEqual(['About', 'Home', 'Blog'])

    // Pending until save.
    expect(savedLabels(testSite.projectDir)).toEqual(['Home', 'About', 'Blog'])
    await save(page)
    expect(savedLabels(testSite.projectDir)).toEqual(['About', 'Home', 'Blog'])
  })

  test('mouse drag reorders items, saved in order', async ({ page, testSite }) => {
    const { items, labels } = await openNavLinks(page)

    // Drag Blog's handle above Home. Small steps: the library only starts a
    // drag after the pointer moves past a threshold.
    const handle = items.nth(2).locator('[data-testid="array-item-handle"]')
    const from = (await handle.boundingBox())!
    const to = (await items.nth(0).boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 5 })
    await page.mouse.move(from.x + from.width / 2, to.y + 2, { steps: 20 })
    await page.mouse.up()
    await expect.poll(labels).toEqual(['Blog', 'Home', 'About'])

    await save(page)
    expect(savedLabels(testSite.projectDir)).toEqual(['Blog', 'Home', 'About'])
  })
})

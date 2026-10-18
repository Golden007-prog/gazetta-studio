import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * Page metadata is a pending edit (design-editor-ux.md, "Page metadata is a
 * pending lane"). Before, the SEO form kept its edit to itself: the
 * unsaved-changes guard and the leave-page prompt didn't see it, the
 * toolbar Save didn't write it, and opening another component dropped it
 * (reproduced 2026-10-18).
 */

const homeFile = (projectDir: string) => join(projectDir, 'sites/main/targets/local/pages/home/page.json')
const metadataOf = (file: string) => JSON.parse(readFileSync(file, 'utf8')).metadata as Record<string, unknown>

async function editSeoTitle(page: Page, value: string) {
  await openEditor(page, 'home')
  const title = page.locator('[data-testid="meta-title"]')
  await title.waitFor({ timeout: 20000 })
  const original = await title.inputValue()
  await title.fill(value)
  return { title, original }
}

test.describe('SEO edits are saved with the page', () => {
  test('the page row shows a dot; the toolbar Save writes them and clears it', async ({ page, testSite }) => {
    test.setTimeout(60_000)
    const file = homeFile(testSite.projectDir)
    const before = readFileSync(file, 'utf8')
    try {
      const { title } = await editSeoTitle(page, 'Saved with the page')
      const tree = new ComponentTreePom(page)
      await expect(tree.dirtyDot('home')).toBeVisible()
      const save = page.locator('[data-testid="save-btn"]')
      await save.click()
      await expect(save).toBeDisabled({ timeout: 10000 })
      await expect(tree.dirtyDot('home')).toBeHidden()
      expect(metadataOf(file)).toEqual({ ...JSON.parse(before).metadata, title: 'Saved with the page' })
      await expect(title).toHaveValue('Saved with the page')
    } finally {
      writeFileSync(file, before)
    }
  })

  test('Ctrl/Cmd+S saves them; on a clean form it writes nothing', async ({ page, testSite }) => {
    test.setTimeout(60_000)
    const file = homeFile(testSite.projectDir)
    const before = readFileSync(file, 'utf8')
    try {
      const puts: string[] = []
      page.on('request', r => {
        if (r.method() === 'PUT') puts.push(r.url())
      })
      const { title } = await editSeoTitle(page, 'Saved with the shortcut')
      await title.press('ControlOrMeta+s')
      await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled({ timeout: 10000 })
      expect(metadataOf(file).title).toBe('Saved with the shortcut')

      const written = puts.length
      await title.press('ControlOrMeta+s')
      await page.waitForTimeout(500) // a write would start right away
      expect(puts.length).toBe(written)
    } finally {
      writeFileSync(file, before)
    }
  })

  test('saving keeps keys the form does not show and the other robots tokens', async ({ page, testSite }) => {
    test.setTimeout(60_000)
    const file = homeFile(testSite.projectDir)
    const before = readFileSync(file, 'utf8')
    const manifest = JSON.parse(before)
    const { description: _dropped, ...kept } = manifest.metadata
    try {
      const metadata = { ...manifest.metadata, robots: 'noindex, nofollow', twitterCard: 'summary' }
      writeFileSync(file, JSON.stringify({ ...manifest, metadata }, null, 2))
      await expect
        .poll(async () => (await (await fetch(`${testSite.baseURL}/admin/api/pages/home`)).json()).metadata)
        .toEqual(metadata)

      await openEditor(page, 'home')
      await page.locator('[data-testid="meta-noindex"]').uncheck()
      await page.locator('[data-testid="meta-description"]').fill('')
      const save = page.locator('[data-testid="save-btn"]')
      await save.click()
      await expect(save).toBeDisabled({ timeout: 10000 })
      expect(metadataOf(file)).toStrictEqual({ ...kept, robots: 'nofollow', twitterCard: 'summary' })
    } finally {
      writeFileSync(file, before)
    }
  })
})

test.describe('SEO edits are pending edits', () => {
  test('leaving edit mode, switching target or switching locale asks first', async ({ page }) => {
    const { title } = await editSeoTitle(page, 'Not saved yet')
    const dialog = page.getByRole('dialog', { name: /unsaved changes/i })

    await page.click('[data-testid="back-to-browse"]')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(title).toHaveValue('Not saved yet')

    await page.locator('[data-testid="active-target-indicator"]').click()
    await page.locator('[data-testid="active-target-menu"]').getByRole('menuitem', { name: 'staging' }).click()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('local')

    await page.locator('[data-testid="locale-fr"]').click()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    expect(new URL(page.url()).searchParams.get('locale')).toBeNull()
    await expect(title).toHaveValue('Not saved yet')
  })

  test("Don't Save drops the edit", async ({ page }) => {
    const { title, original } = await editSeoTitle(page, 'Thrown away')
    await page.locator('[data-testid="locale-fr"]').click()
    await page
      .getByRole('dialog', { name: /unsaved changes/i })
      .getByRole('button', { name: "Don't Save" })
      .click()
    await expect.poll(() => new URL(page.url()).searchParams.get('locale')).toBe('fr')
    // Back to English within the app (a reload would start empty anyway). A
    // surviving edit would raise the dialog again and keep the URL on fr.
    await page.locator('[data-testid="locale-en"]').click()
    await expect.poll(() => new URL(page.url()).searchParams.get('locale')).toBeNull()
    await expect(title).toHaveValue(original)
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()
  })

  test('the leave-page prompt is armed', async ({ page }) => {
    await openEditor(page, 'home')
    const title = page.locator('[data-testid="meta-title"]')
    await title.waitFor({ timeout: 20000 })
    const prompts = () =>
      page.evaluate(() => {
        const e = new Event('beforeunload', { cancelable: true })
        window.dispatchEvent(e)
        return e.defaultPrevented
      })
    expect(await prompts()).toBe(false)
    await title.fill('Not saved yet')
    expect(await prompts()).toBe(true)
  })

  test('opening another component and coming back keeps the edit', async ({ page }) => {
    const { title } = await editSeoTitle(page, 'Kept across components')
    const tree = new ComponentTreePom(page)
    await tree.open('hero')
    await expect(title).toBeHidden()
    await tree.open('home')
    await expect(title).toHaveValue('Kept across components')
    await expect(tree.dirtyDot('home')).toBeVisible()
  })

  test("the page row's revert drops it", async ({ page }) => {
    const { title, original } = await editSeoTitle(page, 'Reverted')
    const tree = new ComponentTreePom(page)
    await tree.revert('home')
    await expect(title).toHaveValue(original)
    await expect(tree.dirtyDot('home')).toBeHidden()
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()
  })
})

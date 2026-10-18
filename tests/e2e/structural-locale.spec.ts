import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * A reorder belongs to the locale file it was made in. Before the fix, a
 * French reorder restored after reloading in English was saved into
 * page.json — the French component list, French hero text included
 * (reproduced 2026-10-18).
 */
test('a reorder on fr is saved to page.fr.json, even from the English page', async ({ page, testSite }) => {
  test.setTimeout(90_000)
  const dir = join(testSite.projectDir, 'sites/main/targets/local/pages/home')
  const enFile = join(dir, 'page.json')
  const frFile = join(dir, 'page.fr.json')
  const enBefore = readFileSync(enFile, 'utf8')
  const frBefore = readFileSync(frFile, 'utf8')
  const names = (file: string) =>
    (JSON.parse(readFileSync(file, 'utf8')).components as Array<string | { name: string }>).map(c =>
      typeof c === 'string' ? c : c.name,
    )
  const heroTitle = (file: string) =>
    (JSON.parse(readFileSync(file, 'utf8')).components as Array<{ name?: string; content?: { title?: string } }>).find(
      c => c.name === 'hero',
    )?.content?.title
  const enOrder = names(enFile)
  const enHero = heroTitle(enFile)
  const tree = new ComponentTreePom(page)
  const order = () =>
    page
      .locator('[data-testid^="component-"]')
      .evaluateAll(els => els.map(e => e.getAttribute('data-testid')).join(','))

  try {
    await page.goto('/admin/pages/home/edit?locale=fr')
    await tree.row('hero').waitFor({ timeout: 20000 })
    const original = await order()
    await tree.moveDown('hero')
    await expect.poll(order).not.toBe(original)
    // Let the debounced write reach the draft store before reloading.
    await page.waitForTimeout(1000)

    // Reload in English: English shows its own order, not the French reorder.
    await page.goto('/admin/pages/home/edit')
    await tree.row('hero').waitFor({ timeout: 20000 })
    expect(await order()).toBe(original)

    // Save from the English page writes the pending French reorder to the French file.
    const saveBtn = page.locator('[data-testid="save-btn"]')
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })
    // English keeps its order and its English text. (Save also rewrites the
    // open English page, unchanged in meaning — so compare meaning, not bytes.)
    expect(names(enFile)).toEqual(enOrder)
    expect(heroTitle(enFile)).toBe(enHero)
    const fr = names(frFile)
    expect(fr.indexOf('hero')).toBe(fr.indexOf('features') + 1)
    expect(readFileSync(frFile, 'utf8')).toContain('Bienvenue')
  } finally {
    writeFileSync(frFile, frBefore)
    writeFileSync(enFile, enBefore)
  }
})

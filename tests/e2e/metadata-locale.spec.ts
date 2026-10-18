import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * Page metadata is per locale file. Before the fix, editing the French
 * page's title and saving wrote it into page.json (reproduced 2026-10-18).
 */
test("editing the French page's metadata writes page.fr.json, not page.json", async ({ page, testSite }) => {
  test.setTimeout(60_000)
  const dir = join(testSite.projectDir, 'sites/main/targets/local/pages/home')
  const enFile = join(dir, 'page.json')
  const frFile = join(dir, 'page.fr.json')
  const enBefore = readFileSync(enFile, 'utf8')
  const frBefore = readFileSync(frFile, 'utf8')
  const metadata = (file: string) => JSON.parse(readFileSync(file, 'utf8')).metadata as Record<string, unknown>
  const enMetadata = metadata(enFile)

  try {
    await page.goto('/admin/pages/home/edit?locale=fr')
    const title = page.locator('[data-testid="meta-title"]')
    await title.waitFor({ timeout: 20000 })
    await expect(title).toHaveValue(String(metadata(frFile).title))
    await title.fill('Titre modifié (FR)')
    const save = page.locator('[data-testid="metadata-save"]')
    await save.click()
    await expect(save).toBeHidden({ timeout: 10000 }) // shown only while dirty

    expect(metadata(frFile).title).toBe('Titre modifié (FR)')
    expect(metadata(enFile)).toEqual(enMetadata)
  } finally {
    writeFileSync(enFile, enBefore)
    writeFileSync(frFile, frBefore)
  }
})

test('after a French save the editor stays French', async ({ page, testSite }) => {
  // selection.reload() used to reload the default locale: after a French
  // metadata save the form and the components showed English under
  // ?locale=fr, and the next content save landed in neither file.
  test.setTimeout(90_000)
  const dir = join(testSite.projectDir, 'sites/main/targets/local/pages/home')
  const enFile = join(dir, 'page.json')
  const frFile = join(dir, 'page.fr.json')
  const enBefore = readFileSync(enFile, 'utf8')
  const frBefore = readFileSync(frFile, 'utf8')
  const heroTitle = (file: string) =>
    (JSON.parse(readFileSync(file, 'utf8')).components as Array<{ name?: string; content?: { title?: string } }>).find(
      c => c.name === 'hero',
    )?.content?.title
  const enHero = heroTitle(enFile)
  const frHero = heroTitle(frFile)

  try {
    await page.goto('/admin/pages/home/edit?locale=fr')
    const meta = page.locator('[data-testid="meta-title"]')
    await meta.waitFor({ timeout: 20000 })
    await meta.fill('Titre FR modifié')
    const metaSave = page.locator('[data-testid="metadata-save"]')
    await metaSave.click()
    await expect(metaSave).toBeHidden({ timeout: 10000 })
    await expect(meta).toHaveValue('Titre FR modifié')

    await new ComponentTreePom(page).open('hero')
    const hero = page.locator('input[name="root_title"]').first()
    await hero.waitFor({ timeout: 20000 })
    await expect(hero).toHaveValue(String(frHero))
    await hero.fill(`${frHero} — modifié`)
    const save = page.locator('[data-testid="save-btn"]')
    await save.click()
    await expect(save).toBeDisabled({ timeout: 10000 })

    expect(heroTitle(frFile)).toBe(`${frHero} — modifié`)
    expect(heroTitle(enFile)).toBe(enHero)
  } finally {
    writeFileSync(enFile, enBefore)
    writeFileSync(frFile, frBefore)
  }
})

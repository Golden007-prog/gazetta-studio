import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'

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

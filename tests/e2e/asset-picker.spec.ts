import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * #1345: asset fields render the asset picker inside the default editor
 * form. The starter's asset-demo hero has a required embeddedAsset()
 * image field pre-filled with `test-pattern`; the flow picks a new
 * asset and saves the reference. (Clearing an optional asset field is
 * covered by the component tests in
 * packages/gazetta/tests/editor-asset-field.test.tsx.)
 */
test.describe('Asset picker in the editor (#1345)', () => {
  test('the hero image field opens the picker and the pick saves the asset reference', async ({ page, testSite }) => {
    await openEditor(page, 'asset-demo')
    const tree = new ComponentTreePom(page)
    await tree.openEditor('hero')

    // The field renders the asset widget, not a raw _asset text input.
    // The field is required, so there is no Clear action.
    const pick = page.locator('[data-testid="asset-widget-pick"]')
    await expect(pick).toBeVisible({ timeout: 20000 })
    await expect(page.locator('input[id$="__asset"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="asset-widget-clear"]')).toHaveCount(0)

    // Pick the asset through the picker modal. The starter ships only
    // one asset and the field is pre-filled with it, so the pick alone
    // leaves the value unchanged; dirty the form through the headline
    // before saving. The assertion that matters is the reference
    // surviving the pick + save round trip.
    await pick.click()
    await expect(page.locator('[data-testid="asset-picker"]')).toBeVisible()
    await page.locator('[data-testid="asset-card-test-pattern"]').click()
    await page.locator('[data-testid="asset-picker-confirm"]').click()
    await expect(page.locator('[data-testid="asset-picker"]')).toBeHidden()

    await page.locator('input[id$="_headline"]').fill('Picked and saved')

    const saveBtn = page.locator('[data-testid="save-btn"]')
    await expect(saveBtn).toBeEnabled()
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })

    const pageJson = join(testSite.projectDir, 'sites/main/targets/local/pages/asset-demo/page.json')
    const saved = JSON.parse(readFileSync(pageJson, 'utf8'))
    expect(saved.components[1].content.image).toEqual({ _asset: 'test-pattern' })
    expect(saved.components[1].content.headline).toBe('Picked and saved')
  })
})

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * Drag-reordering must move the array that was dragged, whatever its shape.
 * The editor used to find the array by splitting rjsf's field id on `_`
 * (`root_nav_links` -> `nav`), so it moved the wrong list for names with an
 * underscore and for arrays inside array items, and nothing for arrays
 * inside objects.
 *
 * The template and page are written into this worker's temporary site copy
 * (never the repo) and removed afterwards.
 */
const TEMPLATE = `import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

const item = z.object({ label: z.string() })
export const schema = z.object({
  nav: z.array(item),
  nav_links: z.array(item),
  settings: z.object({ items: z.array(item) }),
  groups: z.array(z.object({ name: z.string(), tags: z.array(item) })),
})

const template: TemplateFunction = () => ({ html: '<div>array shapes</div>', css: '', js: '' })
export default template
`
const L = (...xs: string[]) => xs.map(label => ({ label }))
const CONTENT = {
  nav: L('N1', 'N2', 'N3'),
  nav_links: L('L1', 'L2', 'L3'),
  settings: { items: L('S1', 'S2', 'S3') },
  groups: [
    { name: 'G1', tags: L('T1', 'T2', 'T3') },
    { name: 'G2', tags: L('U1', 'U2') },
  ],
}

let pageJson = ''
const writePage = () =>
  writeFileSync(
    pageJson,
    JSON.stringify(
      {
        route: '/array-shapes',
        template: 'page-default',
        components: [{ name: 'shapes', template: 'array-shapes', content: CONTENT }],
      },
      null,
      2,
    ),
  )

test.beforeAll(({ testSite }) => {
  const tpl = join(testSite.projectDir, 'templates/array-shapes')
  mkdirSync(tpl, { recursive: true })
  writeFileSync(join(tpl, 'index.ts'), TEMPLATE)
  const pageDir = join(testSite.projectDir, 'sites/main/targets/local/pages/array-shapes')
  mkdirSync(pageDir, { recursive: true })
  pageJson = join(pageDir, 'page.json')
  writePage()
})

// Each case saves; restore so the next case in this worker starts clean.
test.afterEach(() => writePage())

test.afterAll(({ testSite }) => {
  rmSync(join(testSite.projectDir, 'templates/array-shapes'), { recursive: true, force: true })
  rmSync(join(testSite.projectDir, 'sites/main/targets/local/pages/array-shapes'), { recursive: true, force: true })
})

/** Direct item labels of one array, by rjsf field id (e.g. `root_settings_items`). */
function labelsOf(page: Page, id: string): Promise<string> {
  return page.evaluate(id => {
    const root = document.querySelector(`[data-testid="array-${id}"]`)
    const own = new RegExp(`^${id}_\\d+_(label|name)$`)
    return [...(root?.querySelectorAll('input') ?? [])]
      .filter(i => own.test(i.id))
      .map(i => (i as HTMLInputElement).value)
      .join(',')
  }, id)
}

const ALL = ['root_nav', 'root_nav_links', 'root_settings_items', 'root_groups', 'root_groups_0_tags']

for (const [target, expected] of [
  ['root_nav_links', 'L2,L1,L3'],
  ['root_settings_items', 'S2,S1,S3'],
  ['root_groups_0_tags', 'T2,T1,T3'],
] as const) {
  test(`keyboard drag in ${target} moves that array only`, async ({ page }) => {
    await page.goto('/admin/pages/array-shapes/edit')
    await page.waitForSelector('[data-testid^="component-"]', { timeout: 20000 })
    await new ComponentTreePom(page).open('shapes')
    const own = page.locator(`[data-testid="array-${target}"] > .gz-array-items > [data-testid="array-item"]`)
    await expect(own.first()).toBeVisible({ timeout: 20000 })
    const before = Object.fromEntries(await Promise.all(ALL.map(async id => [id, await labelsOf(page, id)])))

    await own.first().locator('> .gz-array-item-header > [data-testid="array-item-handle"]').focus()
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')

    await expect.poll(() => labelsOf(page, target)).toBe(expected)
    for (const id of ALL.filter(a => a !== target))
      expect(await labelsOf(page, id), `${id} must not change`).toBe(before[id])

    const saveBtn = page.locator('[data-testid="save-btn"]')
    await saveBtn.click()
    await expect(saveBtn).toBeDisabled({ timeout: 10000 })
    const saved = JSON.parse(readFileSync(pageJson, 'utf8')).components[0].content
    const savedLabels = (arr: Array<{ label: string }>) => arr.map(x => x.label).join(',')
    const byId: Record<string, string> = {
      root_nav: savedLabels(saved.nav),
      root_nav_links: savedLabels(saved.nav_links),
      root_settings_items: savedLabels(saved.settings.items),
      root_groups_0_tags: savedLabels(saved.groups[0].tags),
    }
    expect(byId[target]).toBe(expected)
  })
}

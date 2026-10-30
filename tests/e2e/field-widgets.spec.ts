import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * The editor's field widgets end to end: set a value the way an author
 * would, save, and check the saved manifest and the widget after a reload.
 * Guards `@rjsf` and widget upgrades. The rich-text field has its own spec.
 *
 * Uses the starter's `showcase` page, whose `showcase-demo` component has
 * one field of most formats.
 */

interface Row {
  field: string
  /** Set the value through the widget, as an author would. */
  set: (form: Locator) => Promise<void>
  /** What the manifest should hold, and the widget show, afterwards. */
  expected: string
  /** Check the widget shows `expected`. */
  shows: (form: Locator) => Promise<void>
}

const input = (form: Locator, field: string) => form.getByTestId(`field-root_${field}-input`)

const rows: Row[] = [
  {
    field: 'image',
    set: form => input(form, 'image').fill('https://example.com/e2e-image.png'),
    expected: 'https://example.com/e2e-image.png',
    shows: form => expect(input(form, 'image')).toHaveValue('https://example.com/e2e-image.png'),
  },
  {
    field: 'website',
    set: form => input(form, 'website').fill('https://example.com/e2e-site'),
    expected: 'https://example.com/e2e-site',
    shows: form => expect(input(form, 'website')).toHaveValue('https://example.com/e2e-site'),
  },
  {
    // The widget turns what the author types into a slug.
    field: 'slug',
    set: form => input(form, 'slug').fill('My E2E Slug'),
    expected: 'my-e2e-slug',
    shows: form => expect(input(form, 'slug')).toHaveValue('my-e2e-slug'),
  },
  {
    field: 'snippet',
    set: form => input(form, 'snippet').fill('<p class="e2e">\n  snippet\n</p>'),
    expected: '<p class="e2e">\n  snippet\n</p>',
    shows: form => expect(input(form, 'snippet')).toHaveValue('<p class="e2e">\n  snippet\n</p>'),
  },
  {
    field: 'metadata',
    set: form => input(form, 'metadata').fill('{ "e2e": true, "count": 2 }'),
    expected: '{ "e2e": true, "count": 2 }',
    shows: form => expect(input(form, 'metadata')).toHaveValue('{ "e2e": true, "count": 2 }'),
  },
  {
    // Picked with the color picker; the text box next to it shows the value.
    field: 'accentColor',
    set: form => input(form, 'accentColor').fill('#ff8800'),
    expected: '#ff8800',
    shows: async form => {
      await expect(input(form, 'accentColor')).toHaveValue('#ff8800')
      await expect(form.getByTestId('field-root_accentColor-text-input')).toHaveValue('#ff8800')
    },
  },
  {
    field: 'layout',
    set: async form => {
      await input(form, 'layout').locator('select').selectOption({ label: 'wide' })
    },
    expected: 'wide',
    // The select's option values are indexes; the label is the value.
    shows: form => expect(input(form, 'layout').locator('option:checked')).toHaveText('wide'),
  },
]

function pageJsonPath(projectDir: string): string {
  return join(projectDir, 'sites/main/targets/local/pages/showcase/page.json')
}

function savedDemoContent(projectDir: string): Record<string, unknown> {
  const saved = JSON.parse(readFileSync(pageJsonPath(projectDir), 'utf8'))
  return saved.components.find((c: { name?: string }) => c.name === 'showcase-demo').content
}

async function openDemo(page: Page): Promise<Locator> {
  await openEditor(page, 'showcase')
  return new ComponentTreePom(page).openEditor('showcase-demo')
}

test.describe('Field widgets', () => {
  // The worker's site copy is shared with other spec files: put the page
  // back as this test found it.
  let original: string | undefined
  test.beforeEach(({ testSite }) => {
    original = readFileSync(pageJsonPath(testSite.projectDir), 'utf8')
  })
  test.afterEach(({ testSite }) => {
    if (original !== undefined) writeFileSync(pageJsonPath(testSite.projectDir), original)
  })

  for (const row of rows) {
    test(`${row.field}: the entered value is saved and shown after a reload`, async ({ page, testSite }) => {
      const before = savedDemoContent(testSite.projectDir)
      expect(before[row.field]).not.toBe(row.expected)

      let form = await openDemo(page)
      await row.set(form)
      await row.shows(form)

      const saveBtn = page.getByTestId('save-btn')
      await saveBtn.click()
      await expect(saveBtn).toBeDisabled({ timeout: 10000 })
      await expect.poll(() => savedDemoContent(testSite.projectDir)[row.field]).toBe(row.expected)
      // Only this field changed.
      expect(savedDemoContent(testSite.projectDir)).toEqual({ ...before, [row.field]: row.expected })

      await page.reload()
      form = await openDemo(page)
      await row.shows(form)
    })
  }
})

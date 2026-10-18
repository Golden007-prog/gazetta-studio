import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { openEditor } from './helpers'
import { SiteTreePom } from './pages/SiteTree'
import { ComponentTreePom } from './pages/ComponentTree'
import { join } from 'node:path'
import { rmSafe } from './_helpers/rm-safe.js'

test.describe('Target switch preserves preview', () => {
  /**
   * Publish everything from local → staging so both targets have the home
   * page. Without this the staging target returns 404 and we can't assert
   * on scroll-preserved content swap.
   */
  async function seedStaging(baseURL: string) {
    const res = await fetch(`${baseURL}/admin/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: ['pages/home', 'pages/about', 'fragments/header', 'fragments/footer'],
        targets: ['staging'],
      }),
    })
    if (!res.ok) throw new Error(`seed publish failed: ${res.status}`)
  }

  test('scroll position is preserved when switching active target', async ({ page, testSite }) => {
    await seedStaging(testSite.baseURL)

    // Shorter viewport forces the home page to actually overflow so the
    // iframe has somewhere to scroll to.
    await page.setViewportSize({ width: 1200, height: 400 })
    await page.goto('/admin/pages/home')
    await page.waitForSelector('iframe[data-testid="preview-iframe"]', { timeout: 10000 })

    // `body` is truthy before layout completes; a scroll issued then is
    // silently discarded when readyState reaches 'complete'. Gate on
    // 'complete' AND body content (skips the iframe's initial blank doc).
    await expect
      .poll(
        async () => {
          return page.evaluate(() => {
            const f = document.querySelector('iframe[data-testid="preview-iframe"]') as HTMLIFrameElement | null
            return (
              f?.contentDocument?.readyState === 'complete' && (f?.contentDocument?.body?.innerHTML?.length ?? 0) > 500
            )
          })
        },
        { timeout: 10000 },
      )
      .toBe(true)

    // Scroll the iframe.
    await page.evaluate(() => {
      const f = document.querySelector('iframe[data-testid="preview-iframe"]') as HTMLIFrameElement | null
      f?.contentWindow?.scrollTo(0, 400)
    })
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const f = document.querySelector('iframe[data-testid="preview-iframe"]') as HTMLIFrameElement | null
            return f?.contentWindow?.scrollY ?? 0
          }),
        { timeout: 2000 },
      )
      .toBeGreaterThan(100)

    const scrolled = await page.evaluate(() => {
      const f = document.querySelector('iframe[data-testid="preview-iframe"]') as HTMLIFrameElement | null
      return f?.contentWindow?.scrollY ?? 0
    })

    // Open the top-bar target switcher and select staging. The preview
    // should swap content via morphdom, preserving scroll.
    await page.locator('[data-testid="active-target-indicator"]').click()
    await page.locator('[data-testid="active-target-menu"]').getByRole('menuitem', { name: 'staging' }).click()

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const f = document.querySelector('iframe[data-testid="preview-iframe"]') as HTMLIFrameElement | null
            return f?.contentWindow?.scrollY ?? 0
          }),
        { timeout: 5000 },
      )
      .toBe(scrolled)

    // Sanity: the indicator now reflects staging as active.
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('staging')
  })
})

test.describe('Target switch with missing item', () => {
  async function wipeStaging(projectDir: string) {
    await rmSafe(join(projectDir, 'sites/main/dist/staging'))
  }

  test('item missing on destination drops focus to root with a back-toast', async ({ page, testSite }) => {
    // Preview on an empty target responds 404 with a friendly "No content
    // on this target yet" placeholder — deliberate, but the browser logs
    // it as a console error which the fixture's guard would otherwise
    // fail the test on.
    test.info().annotations.push({ type: 'allow-console-errors' })
    await wipeStaging(testSite.projectDir)
    // Select home on local.
    await page.goto('/admin/pages/home')
    const tree = new SiteTreePom(page)
    await tree.pageRow('home').waitFor({ timeout: 10000 })
    // Switch to staging — home doesn't exist there.
    await page.locator('[data-testid="active-target-indicator"]').click()
    await page.locator('[data-testid="active-target-menu"]').getByRole('menuitem', { name: 'staging' }).click()
    // Toast appears with a "back" action.
    const toast = page.locator('[data-testid="global-toast"]')
    await expect(toast).toBeVisible()
    await expect(toast).toContainText("pages/home isn't on staging")
    await expect(toast).toContainText('showing site root')
    // Clicking the action restores the previous target + selection.
    await page.locator('[data-testid="toast-action"]').click()
    await expect(page).toHaveURL(/\/admin\/pages\/home/)
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('local')
  })
})

test.describe('Target switch with unsaved edits', () => {
  test('Cancel keeps the user on the current target with edits intact', async ({ page }) => {
    // Enter edit mode and make a change to mark the editor dirty.
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    await page.waitForTimeout(300)
    const titleField = page.locator('input[name="root_title"]').first()
    // hero's custom editor mounts only after its code loads (#912); under
    // `gazetta dev` a cold first load can take several seconds on CI.
    await titleField.waitFor({ timeout: 15000 })
    const original = await titleField.inputValue()
    await titleField.fill(original + ' — dirty')
    // Save button becomes enabled when there are pending edits.
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()

    // Try to switch to staging → the unsaved-dialog opens.
    await page.locator('[data-testid="active-target-indicator"]').click()
    await page.locator('[data-testid="active-target-menu"]').getByRole('menuitem', { name: 'staging' }).click()
    const dialog = page.getByRole('dialog', { name: /unsaved changes/i })
    await dialog.waitFor({ timeout: 5000 })
    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // Still on local (the original active target), edits preserved.
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('local')
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
    await expect(titleField).toHaveValue(original + ' — dirty')
  })

  test("Don't Save discards the edit, also after a reload", async ({ page }) => {
    // The edit is mirrored to the persisted-drafts store as it is typed.
    // "Don't Save" used to clear the editor but not that mirror, so the
    // discarded text came back on the next reload.
    test.setTimeout(60_000)
    // Switching to staging previews an unpublished target, which answers
    // 404 with its "No content on this target yet" placeholder.
    test.info().annotations.push({ type: 'allow-console-errors' })
    await openEditor(page, 'home')
    await new ComponentTreePom(page).open('hero')
    const titleField = page.locator('input[name="root_title"]').first()
    await titleField.waitFor({ timeout: 15000 })
    const original = await titleField.inputValue()
    await titleField.fill(original + ' — discarded')
    await expect(page.locator('[data-testid="save-btn"]')).toBeEnabled()
    // Wait for the debounced write so the test can't pass by reloading
    // before the draft reached IndexedDB.
    await expect.poll(() => storedDraftTitles(page)).toContain(original + ' — discarded')

    await page.locator('[data-testid="active-target-indicator"]').click()
    await page.locator('[data-testid="active-target-menu"]').getByRole('menuitem', { name: 'staging' }).click()
    const dialog = page.getByRole('dialog', { name: /unsaved changes/i })
    await dialog.waitFor({ timeout: 5000 })
    await dialog.getByRole('button', { name: "Don't Save" }).click()
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('staging')
    // Discarding is a store change too, persisted after the same debounce.
    await expect.poll(() => storedDraftTitles(page)).not.toContain(original + ' — discarded')

    await page.goto('/admin/pages/home/edit?target=local')
    await new ComponentTreePom(page).open('hero')
    await titleField.waitFor({ timeout: 15000 })
    await expect(titleField).toHaveValue(original)
    await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()
  })
})

test.describe('Target in URL', () => {
  test('default target has no ?target= in URL', async ({ page }) => {
    await page.goto('/admin/pages/home')
    await page.waitForSelector('[data-testid="active-target-indicator"]', { timeout: 10000 })
    // Default target (local) — URL should be clean, no ?target=
    const url = page.url()
    expect(url).not.toContain('?target=')
  })

  test('switching to non-default target adds ?target= to URL', async ({ page, testSite }) => {
    // Seed staging so the target has content
    const res = await fetch(`${testSite.baseURL}/admin/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })
    if (!res.ok) throw new Error(`seed failed: ${res.status}`)

    await page.goto('/admin/pages/home')
    await page.waitForSelector('[data-testid="active-target-indicator"]', { timeout: 10000 })

    // Click the target indicator to open the menu
    await page.click('[data-testid="active-target-indicator"]')
    await page.waitForSelector('.p-menu', { timeout: 5000 })
    // Click staging in the menu — use role to find the menu item
    const stagingItem = page.locator('.p-menu').locator('[role="menuitem"]').filter({ hasText: 'staging' }).first()
    await stagingItem.click()

    // Wait for target switch and URL update
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('staging', { timeout: 5000 })
    await expect(page).toHaveURL(/target=staging/, { timeout: 5000 })
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('staging')
  })

  test('?target= in URL switches active target on page load', async ({ page, testSite }) => {
    // Seed staging
    const res = await fetch(`${testSite.baseURL}/admin/api/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
    })
    if (!res.ok) throw new Error(`seed failed: ${res.status}`)

    await page.goto('/admin/pages/home?target=staging')
    await page.waitForSelector('[data-testid="active-target-indicator"]', { timeout: 10000 })
    await expect(page.locator('[data-testid="active-target-indicator"]')).toContainText('staging')
  })
})

/** Titles held in the persisted-drafts snapshot in IndexedDB. */
function storedDraftTitles(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const req = indexedDB.open('gazetta-cache')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const row = await new Promise<{ value?: { entries?: [string, { editedContent?: { title?: string } }][] } }>(res => {
      const req = db.transaction('cache').objectStore('cache').get('pending-edits:dirty')
      req.onsuccess = () => res(req.result ?? {})
    })
    return (row.value?.entries ?? []).map(([, e]) => e.editedContent?.title ?? '')
  })
}

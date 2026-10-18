/**
 * Cut 6 — manual Redirect creation scenario.
 *
 * Surfaces crossed: SiteTree's "+ New redirect" button + CreateRedirectDialog
 * (kind toggle / from-input / to-input / submit) + POST /api/page-redirects +
 * site-store reload + SiteTree's archive-toggle + greyed archived row with
 * alias suffix. No single feature test exercises the whole chain end-to-end.
 *
 * What regresses if this breaks:
 *   - The "+ New redirect" button disappears from SiteTree
 *   - CreateRedirectDialog's submit fails to write the archive manifest
 *   - The archive-toggle stops appearing when redirects exist
 *   - The new redirect doesn't surface in the tree under "Show archived"
 *   - The archive sub-issue's `aliasOf` suffix is missing from the tree row
 *   - The route handler's normalize-from-route fails to strip a leading slash
 *
 * Per design-redirect-ui.md Q3 + Q4: the dialog accepts either `/old-about`
 * or `old-about` for the from input; both produce a manifest at
 * `pages/old-about/page.json`. This test uses the slashed form to pin the
 * normalize path (operators paste URLs from analytics).
 *
 * Note on preview-iframe testing: design-redirect-ui.md's spec mentions
 * verifying the preview redirects from old to new. In `gazetta dev`, page
 * routes are statically registered from `allPageEntries` at server start;
 * the dev server has no marker-aware worker layer, so a freshly-created
 * redirect won't serve a 301 during the same `dev` session. The runtime
 * marker (`<!-- gazetta:archived alias=X -->`) is exercised by the
 * publish-side tests + the worker-side tests; this scenario covers the
 * editor flow that creates the manifest in the first place.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures'
import { resetScenarioState } from './_isolation'

test.describe('Scenario — create a manual redirect, see it greyed in tree', () => {
  test.beforeEach(async ({ testSite }) => {
    await resetScenarioState(testSite.projectDir)
  })

  // Both tests create the old-about redirect; resetScenarioState doesn't
  // remove created pages, so the next test in this worker would hit a 409
  // (or see the archived toggle it asserts is absent). Purge through the
  // app so its alias sidecar goes too. 404 = nothing was created.
  test.afterEach(async ({ request, baseURL }) => {
    const res = await request.delete(`${baseURL}/admin/api/pages/old-about/purge`)
    expect([200, 204, 404]).toContain(res.status())
  })

  test('happy path: + New redirect → fill /old-about → about → tree shows archived row', async ({ page, testSite }) => {
    // --- Open admin (browse mode) ---
    // SiteTree only renders in browse mode; /admin lands here by default.
    await page.goto('/admin')

    // --- Sanity: the "Show archived" toggle should be absent before any
    // redirect exists. Krug "absence-as-state" — no archived items
    // means no toggle. ---
    const archiveToggle = page.locator('[data-testid="archive-toggle"]')
    await expect(archiveToggle).toHaveCount(0)

    // --- Click "+ New redirect" → CreateRedirectDialog opens ---
    const newRedirectBtn = page.locator('[data-testid="sitetree-new-redirect-button"]')
    await expect(newRedirectBtn).toBeVisible({ timeout: 10000 })
    await newRedirectBtn.click()

    const modal = page.locator('[data-testid="create-redirect-modal"]')
    await expect(modal).toBeVisible({ timeout: 5000 })

    // --- Page kind is the default — confirm via the radio state ---
    // The kind toggle defaults to page; the test pins this so an accidental
    // swap to fragment-default doesn't silently change UX semantics.
    const pageKindRadio = page.locator('#redirect-kind-page')
    await expect(pageKindRadio).toBeChecked()

    // --- Type "/old-about" in the from field (slashed form pins
    // normalize behavior per Q4 — operator paste from analytics) ---
    const fromInput = page.locator('[data-testid="create-redirect-from-input"]')
    await fromInput.fill('/old-about')

    // --- Type "about" in the to field — `about` is a live page in the
    // starter, satisfying the alias-target-exists check ---
    const toInput = page.locator('[data-testid="create-redirect-to-input"]')
    await toInput.fill('about')

    // --- Submit ---
    const submitBtn = page.locator('[data-testid="create-redirect-submit"]')
    await expect(submitBtn).toBeEnabled()
    await submitBtn.click()

    // --- Modal closes on success (the @close emit clears showCreateRedirect
    // in SiteTree); no error inline ---
    await expect(modal).not.toBeVisible({ timeout: 10000 })

    // --- Manifest landed on disk at pages/old-about/page.json with
    // archive fields (Q4 normalize: leading slash stripped) ---
    const manifestPath = join(testSite.projectDir, 'sites/main/targets/local/pages/old-about/page.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
    expect(manifest.archived).toBe(true)
    expect(manifest.aliasOf).toBe('about')
    expect(typeof manifest.archivedAt).toBe('string')
    // The schema refinement from Cut 1 makes `template` conditionally
    // optional when archived: true — manifest carries archive fields only,
    // no template field on a pure redirect.
    expect(manifest.template).toBeUndefined()

    // --- After site.reload(), the "Show archived" toggle becomes visible
    // because archivedCount === 1 ---
    await expect(archiveToggle).toBeVisible({ timeout: 10000 })
    await expect(archiveToggle).toContainText('Show archived (1)')

    // --- The archived row is hidden by default (Q7 J1 lock) ---
    const archivedRow = page.locator('[data-testid="site-page-old-about"]')
    await expect(archivedRow).toHaveCount(0)

    // --- Toggle on → row appears with alias suffix ---
    await page.locator('[data-testid="archive-toggle-input"]').check()
    await expect(archivedRow).toBeVisible({ timeout: 5000 })
    // Alias suffix renders as "→ about" (page kind; fragments would be "→ @about")
    await expect(archivedRow).toContainText('→ about')
  })

  test('opening a redirect shows the archive banner and no editor (#965)', async ({ page, request, baseURL }) => {
    // A redirect has no template. The editor used to request the schema of
    // template "undefined" and show "Failed to load" under the banner.
    const res = await request.post(`${baseURL}/admin/api/page-redirects`, { data: { from: 'old-about', to: 'about' } })
    expect(res.status()).toBe(201)
    const schemaRequests: string[] = []
    page.on('request', r => {
      if (r.url().includes('/templates/')) schemaRequests.push(r.url())
    })

    await page.goto('/admin/pages/old-about/edit')
    await expect(page.locator('[data-testid="archive-banner-page-old-about"]')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('[data-testid="editor-error"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="editor-empty"]')).toHaveCount(0)
    expect(schemaRequests.filter(u => u.includes('/templates/undefined/'))).toEqual([])
  })
})

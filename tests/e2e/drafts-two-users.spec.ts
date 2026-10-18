import { test, expect } from './fixtures'
import { openEditor, storedDraftTitles } from './helpers'
import { ComponentTreePom } from './pages/ComponentTree'

/**
 * Two people on one browser profile, behind an auth proxy (forwarded-user
 * trust mode). Before Cut 8c, user B opened user A's unsaved draft with
 * Save enabled (reproduced 2026-10-18). Drafts are now owned by the user
 * who wrote them; another user's online boot deletes them.
 */
test.use({ siteAdminAuth: { trust: 'forwarded-user', allowAnyOrigin: true } })

test("a user never sees another user's unsaved draft", async ({ page, context }) => {
  test.setTimeout(90_000)
  const title = page.locator('input[name="root_title"]').first()
  const openHero = async () => {
    await new ComponentTreePom(page).open('hero')
    await title.waitFor({ timeout: 20000 })
  }

  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'alice' })
  await openEditor(page, 'home')
  await openHero()
  const original = await title.inputValue()
  const draft = `${original} — Alice, unsaved`
  await title.fill(draft)
  await expect.poll(() => storedDraftTitles(page)).toContain(draft)

  // Control: the draft does survive a reload for its own author.
  await page.goto('/admin/pages/home/edit')
  await openHero()
  await expect(title).toHaveValue(draft)

  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'bob' })
  await page.goto('/admin/pages/home/edit')
  await openHero()
  await expect(title).toHaveValue(original)
  await expect(page.locator('[data-testid="save-btn"]')).toBeDisabled()
  // Bob's boot deleted Alice's draft rather than just hiding it.
  await expect.poll(() => storedDraftTitles(page)).not.toContain(draft)
})

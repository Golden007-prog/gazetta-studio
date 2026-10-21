/**
 * Unit tests for restoreRevision. Exercises:
 *   - Writing blob content back at snapshot paths
 *   - Deleting items present today but absent from the target revision
 *   - Recording a forward revision with operation='rollback' + restoredFrom
 *   - Soft undo invariant: every restore appends, nothing is destroyed
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { recordWrite } from '../src/history-recorder.js'
import { restoreRevision } from '../src/history-restorer.js'
import { memoryStorage } from './_helpers/memory-storage.js'

describe('restoreRevision', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  // recordWrite emits a baseline on the first call, so the ordering is:
  //   baseline (pre-write scan), first save, second save, ...
  // "Restore the first save" = "undo the second save".
  it("writes the target revision's snapshot back to the content tree", async () => {
    storage.seed({
      'pages/home/page.json': 'v1',
      'pages/about/page.json': 'unchanged',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    const firstSave = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v1' }],
    })
    storage.seed({ 'pages/home/page.json': 'v2' })
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v2' }],
    })

    // Restore to the first-save revision — back to v1.
    const restored = await restoreRevision({ history, contentRoot, revisionId: firstSave.id })

    expect(restored.operation).toBe('rollback')
    expect(restored.restoredFrom).toBe(firstSave.id)
    expect(await storage.readFile('pages/home/page.json')).toBe('v1')
    expect(await storage.readFile('pages/about/page.json')).toBe('unchanged')
  })

  it('deletes items present today but absent from the restored snapshot', async () => {
    storage.seed({
      'pages/home/page.json': 'v1',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    // First recordWrite emits baseline + first save. pages/new doesn't
    // exist yet, so the first save's snapshot contains only pages/home.
    const firstSave = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v1' }],
    })
    // Author adds pages/new — next save captures both.
    storage.seed({ 'pages/new/page.json': 'new-content' })
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/new/page.json', content: 'new-content' }],
    })

    // Restore the first-save revision → pages/new should be removed.
    await restoreRevision({ history, contentRoot, revisionId: firstSave.id })

    expect(await storage.exists('pages/home/page.json')).toBe(true)
    expect(await storage.exists('pages/new/page.json')).toBe(false)
  })

  it('undoing the first save of a translation reverts it instead of deleting it (#1088)', async () => {
    // page.fr.json exists before the target has any history. The first
    // save records the baseline (which must include the variant) and a
    // revision; undoing back to the baseline must restore the original
    // translation content, not delete the file.
    storage.seed({
      'pages/home/page.json': 'v1',
      'pages/home/page.fr.json': 'fr-v1',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    // First save: edit the translation. recordWrite runs BEFORE the new
    // content lands on the tree (admin save order), so its baseline scan
    // still sees fr-v1; the new content arrives via the items delta.
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.fr.json', content: 'fr-v2' }],
    })
    storage.seed({ 'pages/home/page.fr.json': 'fr-v2' })

    // Undo: restore the baseline.
    const list = await history.listRevisions()
    const baseline = list.find(r => r.message === 'Initial baseline')!
    await restoreRevision({ history, contentRoot, revisionId: baseline.id })

    // The translation is reverted to its pre-save content - NOT deleted.
    expect(await storage.readFile('pages/home/page.fr.json')).toBe('fr-v1')
    expect(await storage.readFile('pages/home/page.json')).toBe('v1')
  })

  it('records a new forward revision (soft undo)', async () => {
    storage.seed({ 'pages/home/page.json': 'v1' })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    const firstSave = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v1' }],
    })
    storage.seed({ 'pages/home/page.json': 'v2' })
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v2' }],
    })

    const restored = await restoreRevision({ history, contentRoot, revisionId: firstSave.id })
    expect(restored.operation).toBe('rollback')

    // Full list: baseline + 2 saves + rollback = 4 revisions; nothing destroyed.
    const list = await history.listRevisions()
    expect(list).toHaveLength(4)
    expect(list[0].id).toBe(restored.id) // head = the rollback we just recorded
  })

  it('passes through author + message on the forward revision', async () => {
    storage.seed({ 'pages/home/page.json': 'v1' })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v1' }],
    })
    storage.seed({ 'pages/home/page.json': 'v2' })
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v2' }],
    })

    // Restore the baseline (oldest) with custom author + message.
    const list = await history.listRevisions()
    const baselineId = list[list.length - 1].id
    const restored = await restoreRevision({
      history,
      contentRoot,
      revisionId: baselineId,
      author: 'alice',
      message: 'Undo typo fix',
    })
    expect(restored.author).toBe('alice')
    expect(restored.message).toBe('Undo typo fix')
  })

  it('skips writes for items whose content already matches the restored snapshot', async () => {
    // Two items; only pages/home differs between revisions. pages/about
    // stays the same.
    storage.seed({
      'pages/home/page.json': 'home-v1',
      'pages/about/page.json': 'about-same',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    const firstSave = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'home-v1' }],
    })
    storage.seed({ 'pages/home/page.json': 'home-v2' })
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'home-v2' }],
    })

    // Instrument writeFile + writeBytes to count content-tree writes
    // during restore. The restorer writes content via `writeBytes`
    // (uniform binary path); the new forward revision's blobs also
    // go through writeBytes; index + revision-manifest still use
    // writeFile. Filter out `.gazetta/` paths to count just the
    // content-tree writes the test cares about.
    const origWriteFile = storage.writeFile
    const origWriteBytes = storage.writeBytes
    let writeCount = 0
    storage.writeFile = async (p, c) => {
      if (!p.startsWith('.gazetta/')) writeCount += 1
      return origWriteFile.call(storage, p, c)
    }
    storage.writeBytes = async (p, c) => {
      if (!p.startsWith('.gazetta/')) writeCount += 1
      return origWriteBytes.call(storage, p, c)
    }

    await restoreRevision({ history, contentRoot, revisionId: firstSave.id })

    // Only pages/home needed to change — pages/about's hash matches
    // the current head so the restorer should skip it.
    expect(writeCount).toBe(1)
    expect(await storage.readFile('pages/home/page.json')).toBe('home-v1')
    expect(await storage.readFile('pages/about/page.json')).toBe('about-same')
  })

  it('restoring the head is a no-op delete + a forward revision with identical snapshot', async () => {
    storage.seed({ 'pages/home/page.json': 'v1' })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    const head = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v1' }],
    })

    // Restoring the current head is a valid no-op — content stays put
    // but history still appends a rollback revision (forward-only).
    const restored = await restoreRevision({ history, contentRoot, revisionId: head.id })
    expect(restored.operation).toBe('rollback')
    expect(await storage.readFile('pages/home/page.json')).toBe('v1')
    const list = await history.listRevisions()
    expect(list).toHaveLength(3) // baseline + save + rollback
    expect(list[0].id).toBe(restored.id)
  })

  /**
   * Cross-foundation gap #2 (per testing-plan.md punch list):
   * history restore of an archived page must preserve archive marker,
   * alias, archivedAt, and archivedBy fields. The restorer copies
   * blob bytes verbatim — these tests pin the contract so a future
   * refactor that introduces a manifest-field whitelist on restore
   * can't silently strip archive state.
   *
   * Forensic concern: restoring an archived revision MUST produce a
   * working archive. If `archivedAt` were dropped, the audit-restored
   * page would render as live but with stale URL semantics; if
   * `aliasOf` were dropped, the 301 redirect would silently break.
   */
  it('preserves archive fields when restoring an archived revision (alias variant)', async () => {
    const archivedManifest = JSON.stringify({
      template: 'page-default',
      content: { title: 'Old landing' },
      archived: true,
      archivedAt: '2026-05-09T14:30:00Z',
      archivedBy: 'alice@example.com',
      aliasOf: 'welcome',
    })

    storage.seed({ 'pages/landing/page.json': archivedManifest })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    // Snapshot the archived state.
    const archivedRev = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/landing/page.json', content: archivedManifest }],
    })

    // Mutate to a different state — record an unarchive (strips the
    // archive fields). This produces a different snapshot for the
    // restored path, so restore actually writes the archived bytes
    // back rather than no-op'ing.
    const livePromoted = JSON.stringify({
      template: 'page-default',
      content: { title: 'Old landing' },
    })
    storage.seed({ 'pages/landing/page.json': livePromoted })
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/landing/page.json', content: livePromoted }],
    })

    // Restore the archived revision — bytes round-trip verbatim.
    await restoreRevision({ history, contentRoot, revisionId: archivedRev.id })

    const restored = JSON.parse(await storage.readFile('pages/landing/page.json'))
    expect(restored.archived).toBe(true)
    expect(restored.archivedAt).toBe('2026-05-09T14:30:00Z')
    expect(restored.archivedBy).toBe('alice@example.com')
    expect(restored.aliasOf).toBe('welcome')
    // Content + template preserved alongside the archive fields.
    expect(restored.template).toBe('page-default')
    expect(restored.content.title).toBe('Old landing')
  })

  it('preserves archive fields when restoring a pure soft-delete (no aliasOf)', async () => {
    const archivedManifest = JSON.stringify({
      template: 'page-default',
      content: { title: 'Retired promo' },
      archived: true,
      archivedAt: '2026-04-01T10:00:00Z',
      archivedBy: 'bob@example.com',
    })

    storage.seed({ 'pages/promo/page.json': archivedManifest })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    const archivedRev = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/promo/page.json', content: archivedManifest }],
    })

    // Restore (using head-restore round-trip to exercise the no-op
    // delete path while still asserting bytes survive).
    await restoreRevision({ history, contentRoot, revisionId: archivedRev.id })

    const restored = JSON.parse(await storage.readFile('pages/promo/page.json'))
    expect(restored.archived).toBe(true)
    expect(restored.archivedAt).toBe('2026-04-01T10:00:00Z')
    expect(restored.archivedBy).toBe('bob@example.com')
    // No aliasOf for pure soft-delete — restored manifest must NOT
    // synthesize one (would change render semantics from 410 to 301).
    expect(restored.aliasOf).toBeUndefined()
  })
})

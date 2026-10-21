/**
 * Unit tests for the history-recorder helper. Covers the two-phase
 * behavior: first revision scans the tree, subsequent revisions
 * overlay deltas from the previous snapshot.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { recordWrite } from '../src/history-recorder.js'
import { memoryStorage } from './_helpers/memory-storage.js'

// memoryStorage now imported from _helpers — all storage mocks share
// one canonical impl that satisfies the full StorageProvider contract.

describe('recordWrite', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('first recordWrite emits a baseline revision then the delta revision', async () => {
    // Seed some content before the first save.
    storage.seed({
      'site.config.ts': "export default { name: 'demo' }\n",
      'pages/home/page.json': '{"template":"page-default"}',
      'pages/about/page.json': '{"template":"page-default"}',
      'fragments/header/fragment.json': '{"template":"header-layout"}',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    // Simulate a save of pages/home: author just edited the manifest.
    storage.seed({ 'pages/home/page.json': '{"template":"page-default","content":{"title":"Home"}}' })
    const rev = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [
        {
          path: 'pages/home/page.json',
          content: '{"template":"page-default","content":{"title":"Home"}}',
        },
      ],
    })

    // First call produces TWO revisions: a baseline capturing the pre-
    // save scan, then the delta revision for the save itself. This
    // makes "undo my first save" a well-defined operation (there's an
    // earlier revision to restore to).
    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    // listRevisions returns newest-first — the returned rev matches the head.
    expect(list[0].id).toBe(rev.id)
    const baseline = await history.readRevision(list[1].id)
    expect(baseline.message).toBe('Initial baseline')
    const manifest = await history.readRevision(rev.id)
    // Full tree captured — not just the one item that was written.
    expect(Object.keys(manifest.snapshot).sort()).toEqual([
      'fragments/header/fragment.json',
      'pages/about/page.json',
      'pages/home/page.json',
      'site.config.ts',
    ])
  })

  it('baseline captures locale variant manifests, including nested pages (#1088)', async () => {
    // A translation that exists before the target has any history must
    // be in the first snapshot - otherwise undoing its first save
    // restores a baseline without it and DELETES it.
    storage.seed({
      'site.config.ts': "export default { name: 'demo' }\n",
      'pages/home/page.json': '{"template":"page-default"}',
      'pages/home/page.fr.json': '{"template":"page-default","content":{"title":"Accueil"}}',
      'pages/blog/[slug]/page.json': '{"template":"page-default"}',
      'pages/blog/[slug]/page.ja.json': '{"template":"page-default","content":{"title":"ホーム"}}',
      'fragments/header/fragment.json': '{"template":"header-layout"}',
      'fragments/header/fragment.pt-br.json': '{"template":"header-layout"}',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: '{"template":"page-default","edited":true}' }],
    })

    const list = await history.listRevisions()
    expect(list).toHaveLength(2)
    const baseline = await history.readRevision(list[1].id)
    expect(baseline.message).toBe('Initial baseline')
    const paths = Object.keys(baseline.snapshot)
    expect(paths).toContain('pages/home/page.json')
    expect(paths).toContain('pages/home/page.fr.json')
    expect(paths).toContain('pages/blog/[slug]/page.json')
    expect(paths).toContain('pages/blog/[slug]/page.ja.json')
    expect(paths).toContain('fragments/header/fragment.json')
    expect(paths).toContain('fragments/header/fragment.pt-br.json')
  })

  it('second revision overlays the delta onto the previous snapshot', async () => {
    storage.seed({
      'site.config.ts': "export default { name: 'demo' }\n",
      'pages/home/page.json': 'v1',
      'pages/about/page.json': 'unchanged',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v1' }],
    })

    // Second save — only pages/home changes, pages/about carries forward.
    const rev2 = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v2' }],
    })

    const m2 = await history.readRevision(rev2.id)
    expect(Object.keys(m2.snapshot).sort()).toEqual(['pages/about/page.json', 'pages/home/page.json', 'site.config.ts'])
    // pages/about carries forward with an unchanged hash (same blob).
    // Grab the first save's revision (= head-1; the oldest is baseline).
    const list = await history.listRevisions()
    const firstSaveId = list[1].id
    const m1 = await history.readRevision(firstSaveId)
    expect(m2.snapshot['pages/about/page.json']).toBe(m1.snapshot['pages/about/page.json'])
    // pages/home has a different hash.
    expect(m2.snapshot['pages/home/page.json']).not.toBe(m1.snapshot['pages/home/page.json'])
  })

  it('null content marks a deletion in the next snapshot', async () => {
    storage.seed({
      'pages/home/page.json': 'v1',
      'pages/old-contact/page.json': 'gone',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'v1' }],
    })

    const rev2 = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/old-contact/page.json', content: null }],
    })

    const m = await history.readRevision(rev2.id)
    expect(m.snapshot).not.toHaveProperty('pages/old-contact/page.json')
    expect(m.snapshot).toHaveProperty('pages/home/page.json')
  })

  it('publish revision passes source + operation through to the manifest', async () => {
    storage.seed({ 'pages/home/page.json': 'local-content' })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)

    const rev = await recordWrite({
      history,
      contentRoot,
      operation: 'publish',
      source: 'local',
      message: 'promote local → prod',
      items: [{ path: 'pages/home/page.json', content: 'local-content' }],
    })

    const m = await history.readRevision(rev.id)
    expect(m.operation).toBe('publish')
    expect(m.source).toBe('local')
    expect(m.message).toBe('promote local → prod')
  })

  it('nested page routes are captured in the initial scan', async () => {
    storage.seed({
      'pages/blog/[slug]/page.json': '{"template":"blog-post"}',
      'pages/blog/hello/page.json': '{"template":"blog-post"}',
      'pages/home/page.json': '{"template":"page-default"}',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    const rev = await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: '{"template":"page-default"}' }],
    })
    const m = await history.readRevision(rev.id)
    expect(Object.keys(m.snapshot).sort()).toEqual([
      'pages/blog/[slug]/page.json',
      'pages/blog/hello/page.json',
      'pages/home/page.json',
    ])
  })

  it('unchanged content across revisions dedupes via content-addressed blobs', async () => {
    storage.seed({
      'pages/home/page.json': 'same',
      'pages/about/page.json': 'same',
    })
    const history = createHistoryProvider({ storage })
    const contentRoot = createContentRoot(storage)
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'same' }],
    })
    await recordWrite({
      history,
      contentRoot,
      operation: 'save',
      items: [{ path: 'pages/home/page.json', content: 'same' }],
    })
    // Two items with identical content + two revisions, but only one blob.
    const blobs = [...storage.dump().keys()].filter(k => k.startsWith('.gazetta/history/objects/'))
    expect(blobs).toHaveLength(1)
  })
})

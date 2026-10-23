/**
 * #1174: a translation-only admin publish must copy the variant manifest
 * and record it in history. Before the fix, `POST /api/publish` with
 * `items: ['pages/about:fr']` rendered the new French HTML but left the
 * target's old `page.fr.json` underneath it (publishItems looked for a
 * literal `about:fr` folder and copied nothing), and the revision
 * recorded no items (collectPublishedItemsForHistory read
 * `pages/about:fr/page.json`, which never exists), so undo could not
 * revert a published translation.
 *
 * A bare item publish copies the item's whole folder, so its revision
 * records `page.json` AND every translation manifest the copy wrote.
 *
 * Verified fail-unfixed before commit: with `src/admin-api/routes/
 * publish.ts` reverted, all three tests fail — the variant manifest is
 * absent from the target and from the publish revision's snapshot (cases
 * 1 and 3), and the bare publish records `page.json` only (case 2).
 *
 * Pages publish through the route with the starter's real templates
 * directory; source and targets stay in-memory.
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'
import type { RevisionManifest } from '../src/history.js'

function buildApp(): { app: Hono; sourceStorage: MemoryStorage; targetStorage: MemoryStorage } {
  const sourceStorage = memoryStorage()
  const targetStorage = memoryStorage()
  sourceStorage.seed({
    'pages/about/page.json': JSON.stringify({
      template: 'page-default',
      route: '/about',
      content: { heading: 'About v1' },
    }),
    'pages/about/page.fr.json': JSON.stringify({
      template: 'page-default',
      content: { heading: 'À propos v1' },
    }),
    'fragments/footer/fragment.json': JSON.stringify({
      template: 'footer-layout',
      content: { text: 'Footer v1' },
    }),
    'fragments/footer/fragment.fr.json': JSON.stringify({
      template: 'footer-layout',
      content: { text: 'Pied de page v1' },
    }),
  })

  const targetConfig = {
    storage: targetStorage,
    type: 'esi' as const,
    environment: 'staging' as const,
  }
  const localConfig = {
    storage: sourceStorage,
    type: 'esi' as const,
    environment: 'local' as const,
    editable: true,
  }

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      locales: { default: 'en', supported: ['en', 'fr'] },
      targets: { local: localConfig, staging: targetConfig },
    },
  })

  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: { local: localConfig, staging: targetConfig },
    disableCacheStatsLogger: true,
  })

  return { app, sourceStorage, targetStorage }
}

async function publish(app: Hono, items: string[]): Promise<void> {
  const res = await app.request('/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, targets: ['staging'] }),
  })
  expect(res.status).toBeLessThan(300)
}

/** Read every stored revision manifest on the target, newest last. */
async function readRevisions(targetStorage: MemoryStorage): Promise<RevisionManifest[]> {
  const entries = await targetStorage.readDir('.gazetta/history/revisions')
  const out: RevisionManifest[] = []
  for (const e of entries) {
    if (e.isDirectory || !e.name.endsWith('.json')) continue
    out.push(JSON.parse(await targetStorage.readFile(`.gazetta/history/revisions/${e.name}`)))
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return out
}

/** The publish revision (not the automatic baseline) for one publish. */
function publishRevision(revisions: RevisionManifest[]): RevisionManifest {
  const rev = revisions.filter(r => r.operation === 'publish').at(-1)
  if (!rev) throw new Error('no publish revision recorded')
  return rev
}

describe('publish route — translation manifests copied and recorded (#1174)', () => {
  it('a translation-only page publish copies page.fr.json to the target and records it in the revision', async () => {
    const { app, sourceStorage, targetStorage } = buildApp()

    await publish(app, ['pages/about:fr'])

    const sourceManifest = await sourceStorage.readFile('pages/about/page.fr.json')
    expect(await targetStorage.readFile('pages/about/page.fr.json')).toBe(sourceManifest)

    const rev = publishRevision(await readRevisions(targetStorage))
    expect(rev.snapshot).toHaveProperty('pages/about/page.fr.json')
  })

  it('a bare page publish records page.json and every translation manifest the copy wrote', async () => {
    const { app, targetStorage } = buildApp()

    await publish(app, ['pages/about'])

    const rev = publishRevision(await readRevisions(targetStorage))
    expect(rev.snapshot).toHaveProperty('pages/about/page.json')
    expect(rev.snapshot).toHaveProperty('pages/about/page.fr.json')
  })

  it('fails closed on an invalid locale: no manifest path is built from it, and history records none', async () => {
    // `pages/about:../escape`: isValidLocale rejects the locale before
    // it reaches a manifest filename, so the copy writes no variant
    // manifest and the revision records nothing derived from it.
    // (publishRun's render-side locale handling is out of scope here.)
    const { app, sourceStorage, targetStorage } = buildApp()
    // The manifest an unvalidated `../escape` locale would name. On a
    // hierarchical filesystem this path escapes the item folder; the
    // flat in-memory storage keys it literally.
    sourceStorage.seed({
      'pages/about/page.../escape.json': JSON.stringify({ template: 'page-default', content: {} }),
    })

    await publish(app, ['pages/about:../escape'])

    const manifestKeys = [...targetStorage.dump().keys()].filter(k => k.endsWith('.json') && !k.startsWith('.gazetta/'))
    expect(manifestKeys.some(k => k.includes('..'))).toBe(false)

    const rev = publishRevision(await readRevisions(targetStorage))
    expect(Object.keys(rev.snapshot).some(k => k.includes('..'))).toBe(false)
  })

  it('does not record a translation manifest whose locale fails LOCALE_PATTERN', async () => {
    // `page.fr-x.json` carries a one-letter subtag that LOCALE_PATTERN
    // rejects (`-[a-z]{2,8}`). The copy still writes it (whole-folder
    // copy), but history records only valid translation manifests.
    const { app, sourceStorage, targetStorage } = buildApp()
    sourceStorage.seed({
      'pages/about/page.fr-x.json': JSON.stringify({ template: 'page-default', content: {} }),
    })

    await publish(app, ['pages/about'])

    const rev = publishRevision(await readRevisions(targetStorage))
    expect(rev.snapshot).toHaveProperty('pages/about/page.json')
    expect(rev.snapshot).toHaveProperty('pages/about/page.fr.json')
    expect(rev.snapshot).not.toHaveProperty('pages/about/page.fr-x.json')
  })

  it('a translation-only fragment publish on an ESI target copies fragment.fr.json and records it', async () => {
    const { app, sourceStorage, targetStorage } = buildApp()

    await publish(app, ['fragments/footer:fr'])

    const sourceManifest = await sourceStorage.readFile('fragments/footer/fragment.fr.json')
    expect(await targetStorage.readFile('fragments/footer/fragment.fr.json')).toBe(sourceManifest)

    const rev = publishRevision(await readRevisions(targetStorage))
    expect(rev.snapshot).toHaveProperty('fragments/footer/fragment.fr.json')
  })
})

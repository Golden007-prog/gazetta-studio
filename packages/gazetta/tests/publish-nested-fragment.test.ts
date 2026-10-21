/**
 * A change to a nested fragment reaches every item that bakes it (#1090),
 * and publish and compare agree on the hashes they write and read.
 *
 * The starter has no nested fragments, so each test copies its content and
 * makes `@header` include `@footer`, while `home` drops its own `@footer`:
 * `home` then reaches the footer only through the header.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { compareTargets } from '../src/compare.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { publishRun } from '../src/publish-run.js'
import { loadSite } from '../src/site-loader.js'
import { scanTemplates } from '../src/templates-scan.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterProjectRoot, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'
import { tempDir } from './_helpers/temp.js'

async function editJson(path: string, edit: (json: any) => void) {
  const json = JSON.parse(await readFile(path, 'utf8'))
  edit(json)
  await writeFile(path, JSON.stringify(json, null, 2))
}

describe.each(['static', 'dynamic'] as const)('nested fragment changes on a %s target (#1090)', type => {
  let dir: string

  beforeEach(async () => {
    dir = tempDir(`nested-frag-${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterTargetDir, dir, { recursive: true })
    await editJson(join(dir, 'fragments/header/fragment.json'), j => j.components.push('@footer'))
    await editJson(join(dir, 'pages/home/page.json'), j => {
      j.components = j.components.filter((c: unknown) => c !== '@footer')
    })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function compare(
    target: ReturnType<typeof memoryStorage>,
    templateInfos: Awaited<ReturnType<typeof scanTemplates>>,
  ) {
    return compareTargets({
      sourceRoot: createContentRoot(createFilesystemProvider(dir), ''),
      target,
      templatesDir: starterTemplatesDir,
      projectRoot: starterProjectRoot,
      type,
      scanTemplates: async () => templateInfos,
      manifest: await starterManifest(),
    })
  }

  it('publish then compare is unchanged; editing the nested fragment marks what bakes it', async () => {
    const manifest = await starterManifest()
    const sourceRoot = createContentRoot(createFilesystemProvider(dir), '')
    const site = await loadSite({ contentRoot: sourceRoot, templatesDir: starterTemplatesDir, manifest })
    const templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
    const target = memoryStorage()
    const items =
      type === 'static'
        ? [{ kind: 'page' as const, name: 'home' }]
        : [
            { kind: 'page' as const, name: 'home' },
            { kind: 'fragment' as const, name: 'header' },
            { kind: 'fragment' as const, name: 'footer' },
          ]

    await publishRun({
      items,
      targets: ['t'],
      site,
      sourceRoot,
      siteManifest: { ...manifest, targets: { t: { storage: target, type } } } as typeof manifest,
      targetStorages: new Map([['t', target]]),
      templateInfos,
      publishAssetsBeforeItems: false,
      publishDepIndicesAfter: false,
      publishSiteManifestAfter: false,
    })

    const before = await compare(target, templateInfos)
    expect(before.unchanged).toContain('pages/home')
    if (type === 'dynamic') expect(before.unchanged).toContain('fragments/header')

    await editJson(join(dir, 'fragments/footer/fragment.json'), j => {
      j.content = { ...(j.content ?? {}), copyright: `changed ${Date.now()}` }
    })
    const after = await compare(target, templateInfos)
    if (type === 'static') {
      expect(after.modified).toContain('pages/home')
    } else {
      // ESI: home's top-level @header is composed per request, so home is
      // unchanged; @header bakes @footer, so it must be republished.
      expect(after.unchanged).toContain('pages/home')
      expect(after.modified).toContain('fragments/header')
    }
  }, 60_000)
})

describe('nested fragments resolve like rendering does (#1090)', () => {
  let dir: string

  beforeEach(async () => {
    dir = tempDir(`nested-frag-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterTargetDir, dir, { recursive: true })
    for (const f of ['page.json', 'page.fr.json']) {
      await editJson(join(dir, 'pages/home', f), j => {
        j.components = j.components.filter((c: unknown) => c !== '@footer')
      })
    }
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function publishThenCompare(items: { kind: 'page'; name: string; locale?: string }[]) {
    const manifest = await starterManifest()
    const sourceRoot = createContentRoot(createFilesystemProvider(dir), '')
    const site = await loadSite({ contentRoot: sourceRoot, templatesDir: starterTemplatesDir, manifest })
    const templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
    const target = memoryStorage()
    await publishRun({
      items,
      targets: ['t'],
      site,
      sourceRoot,
      siteManifest: { ...manifest, targets: { t: { storage: target, type: 'static' } } } as typeof manifest,
      targetStorages: new Map([['t', target]]),
      templateInfos,
      publishAssetsBeforeItems: false,
      publishDepIndicesAfter: false,
      publishSiteManifestAfter: false,
    })
    return () =>
      compareTargets({
        sourceRoot: createContentRoot(createFilesystemProvider(dir), ''),
        target,
        templatesDir: starterTemplatesDir,
        projectRoot: starterProjectRoot,
        type: 'static',
        scanTemplates: async () => templateInfos,
        manifest,
      })
  }

  it("a nested fragment's locale variant changes only that locale's pages", async () => {
    // The French page renders header.fr.json, so that's where the nested ref goes.
    await editJson(join(dir, 'fragments/header/fragment.fr.json'), j => {
      j.components = [...(j.components ?? []), '@footer']
    })
    const compare = await publishThenCompare([{ kind: 'page', name: 'home', locale: 'fr' }])
    expect((await compare()).unchanged).toContain('pages/home:fr')

    await editJson(join(dir, 'fragments/footer/fragment.fr.json'), j => {
      j.content = { ...(j.content ?? {}), copyright: `fr ${Date.now()}` }
    })
    expect((await compare()).modified).toContain('pages/home:fr')
  }, 60_000)

  it('a change to an alias target reaches pages that reference the archived name', async () => {
    const footer = JSON.parse(await readFile(join(dir, 'fragments/footer/fragment.json'), 'utf8'))
    await cp(join(dir, 'fragments/footer'), join(dir, 'fragments/oldfooter'), { recursive: true })
    for (const f of ['fragment.json', 'fragment.fr.json', 'fragment.ar.json', 'fragment.ja.json']) {
      await rm(join(dir, 'fragments/oldfooter', f), { force: true })
    }
    await writeFile(
      join(dir, 'fragments/oldfooter/fragment.json'),
      JSON.stringify({ template: footer.template, archived: true, aliasOf: 'footer' }),
    )
    await editJson(join(dir, 'fragments/header/fragment.json'), j => j.components.push('@oldfooter'))
    const compare = await publishThenCompare([{ kind: 'page', name: 'home' }])
    expect((await compare()).unchanged).toContain('pages/home')

    await editJson(join(dir, 'fragments/footer/fragment.json'), j => {
      j.content = { ...(j.content ?? {}), copyright: `changed ${Date.now()}` }
    })
    expect((await compare()).modified).toContain('pages/home')
  }, 60_000)
})

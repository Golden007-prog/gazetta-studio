/** #1329: audit the selected translation's manifest and rendered HTML. */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createContentRoot } from '../src/content-root.js'
import { loadSite } from '../src/site-loader.js'
import { runPublishAudit } from '../src/validation/publish-audit.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import type { SavedItem, Validator } from '../src/validation/types.js'
import { brokenLinks } from '../src/validation/validators/broken-links.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'

function seedStorage() {
  const storage = memoryStorage()
  function page(body: string, title: string) {
    return JSON.stringify({
      template: 'page-default',
      route: '/about',
      metadata: { title },
      content: {},
      components: [{ name: 'body', template: 'text-block', content: { heading: title, body } }],
    })
  }
  storage.seed({
    'pages/about/page.json': page('<a href="/about">English</a>', 'About'),
    'pages/about/page.fr.json': page('<a href="/missing-fr">Français</a>', 'À propos'),
    'pages/about/page.de.json': page('<a href="/missing-de">Deutsch</a>', 'Über uns'),
    'fragments/footer/fragment.json': JSON.stringify({ template: 'text-block', content: { heading: 'Footer' } }),
    'fragments/footer/fragment.fr.json': JSON.stringify({
      template: 'text-block',
      content: { heading: 'Pied de page' },
    }),
  })
  return storage
}

const locales = { default: 'en', supported: ['en', 'fr', 'de'] }

describe('runPublishAudit locale identity', () => {
  it('audits default and translated page/fragment manifests with distinct paths', async () => {
    const storage = seedStorage()
    const contentRoot = createContentRoot(storage, '')
    const site = await loadSite({ contentRoot, manifest: { name: 'audit-test', locales } })
    const seen: SavedItem[] = []
    const validator: Validator = {
      source: 'site-local:test',
      name: 'manifest-probe',
      stages: ['pre-publish'],
      defaultSeverity: () => 'warn',
      async validate(input) {
        if (input.scope.kind !== 'pre-publish') return []
        seen.push(...input.scope.items)
        return Promise.all(
          input.scope.items.map(async item => {
            const manifest = JSON.parse(await input.storage.readFile(item.itemPath))
            return {
              validator: 'manifest-probe',
              severity: 'warn' as const,
              message: manifest.metadata?.title ?? manifest.content.heading,
              itemPath: item.itemPath,
            }
          }),
        )
      },
    }
    const issues = await runPublishAudit({
      items: [
        { kind: 'page', name: 'about' },
        { kind: 'fragment', name: 'footer' },
        { kind: 'page', name: 'about:fr' },
        { kind: 'fragment', name: 'footer:fr' },
      ],
      site,
      contentRoot,
      storage,
      registry: createValidatorRegistry([validator]),
      strict: false,
    })
    expect(seen).toEqual([
      { kind: 'page', name: 'about', itemPath: 'pages/about/page.json' },
      { kind: 'fragment', name: 'footer', itemPath: 'fragments/footer/fragment.json' },
      { kind: 'page', name: 'about', locale: 'fr', itemPath: 'pages/about/page.fr.json' },
      { kind: 'fragment', name: 'footer', locale: 'fr', itemPath: 'fragments/footer/fragment.fr.json' },
    ])
    expect(issues.map(issue => [issue.itemPath, issue.message])).toEqual([
      ['pages/about/page.json', 'About'],
      ['fragments/footer/fragment.json', 'Footer'],
      ['pages/about/page.fr.json', 'À propos'],
      ['fragments/footer/fragment.fr.json', 'Pied de page'],
    ])
  })

  it('does not substitute the default manifest for a missing translation', async () => {
    const storage = seedStorage()
    const contentRoot = createContentRoot(storage, '')
    const site = await loadSite({ contentRoot, manifest: { name: 'audit-test', locales } })
    let calls = 0
    const validator: Validator = {
      source: 'site-local:test',
      name: 'missing-translation-probe',
      stages: ['pre-publish'],
      defaultSeverity: () => 'warn',
      async validate() {
        calls++
        return []
      },
    }
    expect(
      await runPublishAudit({
        items: [
          { kind: 'page', name: 'about:es' },
          { kind: 'fragment', name: 'footer:de' },
        ],
        site,
        contentRoot,
        storage,
        registry: createValidatorRegistry([validator]),
        strict: false,
      }),
    ).toEqual([])
    expect(calls).toBe(0)
  })
})

function buildApp(strict = false) {
  const storage = seedStorage()
  const target = memoryStorage()
  const targets = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: { storage: target, type: 'esi' as const, environment: 'staging' as const, publishAudit: { strict } },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/audit-test',
    manifest: { name: 'audit-test', locales, targets },
  })
  const app = createAdminApp({
    source,
    siteDir: '/audit-test',
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', storage],
      ['staging', target],
    ]),
    targetConfigs: targets,
    validators: createValidatorRegistry([brokenLinks]),
    disableCacheStatsLogger: true,
  })
  return { app, target }
}

describe('publish audit translation HTML', () => {
  it('reports each translation’s broken link and keeps the default audit clean', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'staging',
        items: [
          { kind: 'page', name: 'about' },
          { kind: 'page', name: 'about:fr' },
          { kind: 'page', name: 'about:de' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.issues).toEqual([
      expect.objectContaining({
        validator: 'broken-links',
        itemPath: 'pages/about/page.fr.json',
        message: expect.stringContaining('/missing-fr'),
      }),
      expect.objectContaining({
        validator: 'broken-links',
        itemPath: 'pages/about/page.de.json',
        message: expect.stringContaining('/missing-de'),
      }),
    ])
  })

  it('blocks a strict translation publish even when the client skips the audit endpoint', async () => {
    const { app, target } = buildApp(true)
    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/about:fr'], targets: ['staging'] }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('PUBLISH_AUDIT_FAILED')
    expect(body.blocked[0].issues).toEqual([
      expect.objectContaining({
        validator: 'broken-links',
        severity: 'error',
        itemPath: 'pages/about/page.fr.json',
        message: expect.stringContaining('/missing-fr'),
      }),
    ])
    expect(await target.readDir('pages')).toEqual([])
  })
})

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
  it('expands bare items to all translated manifests without duplicate explicit variants', async () => {
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
        { kind: 'page', name: 'about:FR' },
        { kind: 'fragment', name: 'footer:fR' },
      ],
      site,
      contentRoot,
      storage,
      registry: createValidatorRegistry([validator]),
      strict: false,
    })
    expect(seen).toEqual([
      { kind: 'page', name: 'about', itemPath: 'pages/about/page.json' },
      { kind: 'page', name: 'about', locale: 'fr', itemPath: 'pages/about/page.fr.json' },
      { kind: 'page', name: 'about', locale: 'de', itemPath: 'pages/about/page.de.json' },
      { kind: 'fragment', name: 'footer', itemPath: 'fragments/footer/fragment.json' },
      { kind: 'fragment', name: 'footer', locale: 'fr', itemPath: 'fragments/footer/fragment.fr.json' },
    ])
    expect(issues.map(issue => [issue.itemPath, issue.message])).toEqual([
      ['pages/about/page.json', 'About'],
      ['pages/about/page.fr.json', 'À propos'],
      ['pages/about/page.de.json', 'Über uns'],
      ['fragments/footer/fragment.json', 'Footer'],
      ['fragments/footer/fragment.fr.json', 'Pied de page'],
    ])
  })

  it('audits the manifest publishing resolves when the requested translation is absent', async () => {
    const storage = seedStorage()
    const contentRoot = createContentRoot(storage, '')
    const site = await loadSite({ contentRoot, manifest: { name: 'audit-test', locales } })
    const seen: SavedItem[] = []
    const validator: Validator = {
      source: 'site-local:test',
      name: 'missing-translation-probe',
      stages: ['pre-publish'],
      defaultSeverity: () => 'warn',
      async validate(input) {
        if (input.scope.kind === 'pre-publish') seen.push(...input.scope.items)
        return []
      },
    }
    expect(
      await runPublishAudit({
        items: [
          { kind: 'page', name: 'about:es' },
          { kind: 'fragment', name: 'footer:de' },
          { kind: 'page', name: 'missing:fr' },
          { kind: 'fragment', name: 'missing:fr' },
        ],
        site,
        contentRoot,
        storage,
        registry: createValidatorRegistry([validator]),
        strict: false,
      }),
    ).toEqual([])
    // Page resolution falls back to page.json. Fragment resolution uses
    // the site's locale fallback resolver (first available here: French).
    expect(seen).toEqual([
      { kind: 'page', name: 'about', locale: 'es', itemPath: 'pages/about/page.json' },
      { kind: 'fragment', name: 'footer', locale: 'de', itemPath: 'fragments/footer/fragment.fr.json' },
    ])
  })
})

function buildApp(strict = false, targetLocales?: string[], wireValidators = true) {
  const storage = seedStorage()
  const target = memoryStorage()
  const targets = {
    local: { storage, type: 'dynamic' as const, environment: 'local' as const, editable: true },
    staging: {
      storage: target,
      type: 'dynamic' as const,
      environment: 'staging' as const,
      publishAudit: { strict },
      ...(targetLocales ? { locales: targetLocales } : {}),
    },
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
    ...(wireValidators ? { validators: createValidatorRegistry([brokenLinks]) } : {}),
    disableCacheStatsLogger: true,
  })
  return { app, target, storage }
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

  it.each(['FR', 'fR'])('normalizes %s for both the audit endpoint and strict publish gate', async locale => {
    const { app, target } = buildApp(true)
    const audit = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [{ kind: 'page', name: `about:${locale}` }] }),
    })
    expect(audit.status).toBe(200)
    expect((await audit.json()).issues).toEqual([
      expect.objectContaining({
        itemPath: 'pages/about/page.fr.json',
        message: expect.stringContaining('/missing-fr'),
      }),
    ])
    const publish = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [`pages/about:${locale}`], targets: ['staging'] }),
    })
    expect(publish.status).toBe(409)
    expect((await publish.json()).code).toBe('PUBLISH_AUDIT_FAILED')
    expect([...target.dump().keys()]).toEqual([])
  })

  it('publishes mixed-case locale requests from the same canonical variant that was audited', async () => {
    const { app, target } = buildApp()
    const publish = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/about:fR', 'fragments/footer:fR'], targets: ['staging'] }),
    })
    expect(publish.status).toBe(200)
    expect(await target.readFile('pages/about/index.fr.html')).toContain('/missing-fr')
    expect(await target.exists('pages/about/index.fR.html')).toBe(false)
    expect(await target.readFile('fragments/footer/index.fr.html')).toContain('Pied de page')
    expect(await target.exists('fragments/footer/index.fR.html')).toBe(false)
  })

  it('audits only target-enabled translations expanded from a bare page', async () => {
    const { app, target } = buildApp(true, ['fr'])
    const audit = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [{ kind: 'page', name: 'about' }] }),
    })
    expect(audit.status).toBe(200)
    expect((await audit.json()).issues).toEqual([
      expect.objectContaining({
        itemPath: 'pages/about/page.fr.json',
        message: expect.stringContaining('/missing-fr'),
      }),
    ])
    const publish = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/about'], targets: ['staging'] }),
    })
    expect(publish.status).toBe(409)
    expect((await publish.json()).blocked[0].issues).toHaveLength(1)
    expect([...target.dump().keys()]).toEqual([])
  })

  it('does not audit translations excluded from the destination target', async () => {
    const { app } = buildApp(true, [])
    const audit = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [{ kind: 'page', name: 'about' }] }),
    })
    expect(audit.status).toBe(200)
    expect((await audit.json()).issues).toEqual([])
  })

  it('still audits an explicitly requested translation outside the bare-item target filter', async () => {
    const { app } = buildApp(true, [])
    const audit = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [{ kind: 'page', name: 'about:fr' }] }),
    })
    expect(audit.status).toBe(200)
    expect((await audit.json()).issues).toEqual([
      expect.objectContaining({
        itemPath: 'pages/about/page.fr.json',
        message: expect.stringContaining('/missing-fr'),
      }),
    ])
  })

  it('blocks a missing-translation publish when its default page fallback has broken links', async () => {
    const { app, target, storage } = buildApp(true)
    const page = JSON.parse(await storage.readFile('pages/about/page.json'))
    page.components[0].content.body = '<a href="/missing-default">Broken fallback</a>'
    await storage.writeFile('pages/about/page.json', JSON.stringify(page))
    const publish = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/about:es'], targets: ['staging'] }),
    })
    expect(publish.status).toBe(409)
    expect((await publish.json()).blocked[0].issues).toEqual([
      expect.objectContaining({
        itemPath: 'pages/about/page.json',
        message: expect.stringContaining('/missing-default'),
      }),
    ])
    expect([...target.dump().keys()]).toEqual([])
  })

  it.each([
    null,
    {},
    { kind: 'page' },
    { kind: 'page', name: 7 },
    { kind: 'page', name: null },
    { kind: 'asset', name: 'about' },
  ])('rejects malformed audit item %j at the request boundary', async item => {
    const { app, target } = buildApp()
    const audit = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [item] }),
    })
    expect(audit.status).toBe(400)
    expect((await audit.json()).error).toBeTypeOf('string')
    expect([...target.dump().keys()]).toEqual([])
  })

  it('validates audit items even without a validator registry', async () => {
    const { app, target } = buildApp(false, undefined, false)
    const audit = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'staging', items: [{ kind: 'page' }] }),
    })
    expect(audit.status).toBe(400)
    expect([...target.dump().keys()]).toEqual([])
  })
})

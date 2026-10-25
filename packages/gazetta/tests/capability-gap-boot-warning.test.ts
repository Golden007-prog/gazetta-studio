/**
 * #1305: the boot capability-gap warning fires only once the site has at
 * least one archived page. On a fresh `gazetta init` site nothing is
 * archived, so `gazetta dev` must boot without the warning; the gap still
 * shows in the archive dialog, site health and the publish check.
 *
 * The no-archived-pages test fails on code that warns per gapped target
 * regardless of archive state.
 */
import { describe, expect, it, vi } from 'vitest'
import { warnOnCapabilityGaps } from '../src/runtime/capability-gap-warnings.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'

// Plain-static target (type=static, no worker, no redirects.format):
// inspectTarget flags it for both 'redirects' and 'gone-status' gaps.
const targets: Record<string, TargetConfig> = {
  'plain-static': {
    type: 'static',
    environment: 'production',
  } as TargetConfig,
}
const manifest = { name: 'test-site', targets } as SiteManifest

describe('boot capability-gap warning (#1305)', () => {
  it('stays silent on a site with no archived pages', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const count = warnOnCapabilityGaps(manifest, { anyArchived: false })
      expect(count).toBe(0)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warns per gapped target once the site has an archived page', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const count = warnOnCapabilityGaps(manifest, { anyArchived: true })
      expect(count).toBe(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const msg = warnSpy.mock.calls[0][0] as string
      expect(msg).toContain('plain-static')
      expect(msg).toContain('redirects')
      expect(msg).toContain('gone-status')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps the previous warn-always behavior for callers without archive state', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(warnOnCapabilityGaps(manifest)).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe("deferred boot warning for servers without a boot site load ('defer')", () => {
  // loadSite also warns about the fixture's missing fragments/
  // directory; only capability-gap warnings matter here.
  const gapWarns = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.filter(call => String(call[0]).includes('capability gaps'))

  function deferredApp(seedArchived: boolean) {
    const storage = memoryStorage()
    storage.seed({
      ...(seedArchived
        ? {
            'pages/old-landing/page.json': JSON.stringify({
              template: 'page-default',
              content: { title: 'Old' },
              archived: true,
              aliasOf: 'home',
            }),
          }
        : {}),
      'pages/home/page.json': JSON.stringify({
        template: 'page-default',
        content: { title: 'Home' },
      }),
    })
    const source = createSourceContext({
      storage,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest,
    })
    return createAdminApp({
      source,
      siteDir: '/test-project',
      templatesDir: '/test-project/templates',
      anyArchived: 'defer',
      disableCacheStatsLogger: true,
    })
  }

  it('stays silent at boot, then warns once on the first site load when a page is archived', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = deferredApp(true)
      expect(gapWarns(warnSpy)).toHaveLength(0)
      const res = await app.request('/api/pages')
      expect(res.status).toBe(200)
      expect(gapWarns(warnSpy)).toHaveLength(1)
      expect(gapWarns(warnSpy)[0][0] as string).toContain('plain-static')
      // Once per process: a second site-loading request does not re-warn.
      await app.request('/api/pages')
      expect(gapWarns(warnSpy)).toHaveLength(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('never warns on the deferred path when nothing is archived', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const app = deferredApp(false)
      const res = await app.request('/api/pages')
      expect(res.status).toBe(200)
      expect(gapWarns(warnSpy)).toHaveLength(0)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

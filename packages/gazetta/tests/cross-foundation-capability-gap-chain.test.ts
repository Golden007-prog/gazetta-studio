/**
 * Cross-foundation gap #3 (per testing-plan.md punch list):
 * Capability-gap UX surfaces at all four points end-to-end for one
 * feature + one target.
 *
 * Per `feature-design-process.md` non-foundational disciplines +
 * `design-soft-delete.md` Q10 lock: when a feature needs runtime
 * help (e.g., archive needing 301/410 redirects), the gap surfaces
 * at four uniform points:
 *
 *   #1. Boot validate — `warnOnCapabilityGaps(manifest)` warns at
 *       admin boot per gapped target
 *   #2. Author modal — `/api/targets` returns `capabilities: { has,
 *       gaps }` per target so the archive modal can render badges
 *   #3. Validator scanner — `archive-not-supported-on-target` (P4)
 *       fires for archived items on gapped targets
 *   #4. Publish gate — `/api/publish/audit` includes `capabilities`
 *       in the response when the publish set includes archived items
 *
 * Each surface is tested in isolation today (boot test in
 * runtime-capabilities.test.ts; targets test in api-contract; P4 in
 * validation-archive.test.ts; publish-audit in admin-api-publish-audit
 * .test.ts). What's missing is a single chain test pinning all four
 * fire for the SAME (target, archived item) pair — a structural
 * regression that breaks the four-point contract would only be
 * caught here.
 *
 * Scenario: plain-static target (`type: 'static'` + no worker + no
 * `redirects.format`) + one archived page → assert all four surfaces
 * report the gap with consistent capability info.
 *
 * Per rule 26 (test-isolation paranoia): fresh memoryStorage + fresh
 * createAdminApp.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { warnOnCapabilityGaps } from '../src/runtime/capability-gap-warnings.js'
import { archiveNotSupportedOnTarget } from '../src/validation/validators/archive-not-supported-on-target.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import type { SiteManifest } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

let app: Hono
let storage: MemoryStorage
let manifest: SiteManifest

beforeEach(() => {
  storage = memoryStorage()
  storage.seed({
    // One archived page so surfaces #3 (validator) + #4 (publish-audit)
    // have an item to flag. aliasOf set so the page is a 301-style
    // archive — the gap is "this target can't emit 301".
    'pages/old-landing/page.json': JSON.stringify({
      template: 'page-default',
      content: { title: 'Old' },
      archived: true,
      archivedAt: '2026-05-09T14:00:00Z',
      archivedBy: 'alice@example.com',
      aliasOf: 'home',
    }),
    'pages/home/page.json': JSON.stringify({
      template: 'page-default',
      content: { title: 'Home' },
    }),
  })

  // Plain-static target: type=static, no worker, no redirects.format.
  // This is the exact shape `inspectTarget` flags for both 'redirects'
  // and 'gone-status' capability gaps.
  // We also declare an editable local target (required by
  // createAdminApp) — that one's an esi-mode target with worker
  // implied, so it has full capabilities and won't surface gaps.
  // The chain test asserts gaps on `plain-static`; the editable
  // local target is structural setup.
  const targetConfigs = {
    local: {
      storage,
      type: 'dynamic' as const, // hasWorker=true via type=dynamic → no gaps
      environment: 'local' as const,
      editable: true,
    },
    'plain-static': {
      storage,
      type: 'static' as const,
      environment: 'production' as const,
      // No `worker:` field, no `redirects:` field → both gaps fire.
    },
  }

  manifest = {
    name: 'test-site',
    targets: targetConfigs,
  }

  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest,
  })

  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', storage],
      ['plain-static', storage],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
    // Validators registry includes P4 so publish-audit runs it (surface #4).
    validators: createValidatorRegistry([archiveNotSupportedOnTarget]),
  })
})

describe('Cross-foundation gap #3 — capability-gap surfaces fire at all four points', () => {
  it('Surface #1 (boot validate) — warns once per gapped target with redirect+gone reasons', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // The fixture seeds one archived page (pages/old-landing), so the
      // boot warning fires per #1305's warn-once-archived rule.
      const count = warnOnCapabilityGaps(manifest, { anyArchived: true })
      expect(count).toBe(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const msg = warnSpy.mock.calls[0][0] as string
      // The warning carries both gaps' reasons + the target name +
      // a doc link — the four-point contract guarantees operators
      // see this at boot before content authors hit the gap.
      expect(msg).toContain('plain-static')
      expect(msg).toContain('redirects')
      expect(msg).toContain('gone-status')
      expect(msg).toContain('runtime-capabilities')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('Surface #2 (author modal data) — /api/targets reports capabilities with gaps for plain-static', async () => {
    const res = await app.request('/api/targets')
    expect(res.status).toBe(200)
    const targets = (await res.json()) as Array<{
      name: string
      capabilities: { has: string[]; gaps: Array<{ capability: string; reason: string }> }
    }>
    const gapped = targets.find(t => t.name === 'plain-static')
    expect(gapped).toBeDefined()
    // Plain-static has neither 'redirects' nor 'gone-status' — both
    // appear in `gaps` with their inspectTarget reasons. The archive
    // modal renders these as per-target capability badges (Cut 10).
    expect(gapped!.capabilities.has).not.toContain('redirects')
    expect(gapped!.capabilities.has).not.toContain('gone-status')
    const gapKinds = gapped!.capabilities.gaps.map(g => g.capability)
    expect(gapKinds).toContain('redirects')
    expect(gapKinds).toContain('gone-status')
    // Reasons are non-empty strings; the modal surfaces them inline.
    for (const g of gapped!.capabilities.gaps) {
      expect(g.reason.length).toBeGreaterThan(0)
    }
  })

  it('Surface #3 (validator scanner / background stage) — P4 fires for archived item on plain-static', async () => {
    // Run the validator directly against the archived item.
    // Background-stage invocation: scanner pre-loads the manifest and
    // dispatches per-item; validator reads `scope.manifest` rather
    // than walking the site itself.
    const archivedManifest = JSON.parse(await storage.readFile('pages/old-landing/page.json'))
    const issues = await archiveNotSupportedOnTarget.validate({
      stage: 'background',
      site: { manifest, pages: new Map(), fragments: new Map() } as never,
      contentRoot: { storage } as never,
      storage,
      scope: {
        kind: 'background',
        item: { kind: 'page', name: 'old-landing', itemPath: 'pages/old-landing/page.json' },
        manifest: archivedManifest,
      },
    })
    // P4's contract: warn-severity issue per archived item that
    // would lose its redirect on a gapped target.
    expect(issues.length).toBeGreaterThan(0)
    const ours = issues.find(i => i.itemPath?.includes('old-landing'))
    expect(ours).toBeDefined()
    expect(ours!.validator).toBe('archive-not-supported-on-target')
    expect(ours!.severity).toBe('warn')
    // The message references the gapped target so the site-health
    // drawer can group issues per target.
    expect(ours!.message).toContain('plain-static')
  })

  it('Surface #4 (publish gate) — /api/publish/audit includes capabilities when publish set has archived items', async () => {
    const res = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'plain-static',
        items: [{ kind: 'page', name: 'old-landing' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      issues: Array<{ target: string; perTarget: unknown }>
      capabilities?: { has: string[]; gaps: Array<{ capability: string; reason: string }> }
    }
    // Capabilities surfaces only when the publish set contains an
    // archived item — confirms the conditional surface, not always-on.
    expect(body.capabilities).toBeDefined()
    expect(body.capabilities!.has).not.toContain('redirects')
    const gapKinds = body.capabilities!.gaps.map(g => g.capability)
    expect(gapKinds).toContain('redirects')
    expect(gapKinds).toContain('gone-status')
  })

  it('All four surfaces report the SAME capability shape — single source of truth via inspectTarget', async () => {
    // The four-point contract requires consistency: each surface
    // reads from the same `inspectTarget` predicate so operators see
    // matching gap reasons across boot logs, modal badges, scanner
    // warnings, and publish-gate issues. A future regression that
    // forks the inspection into surface-specific branches would
    // produce divergent UX (e.g., scanner warns about 'redirects'
    // while the modal says 'all good'). This test pins consistency.
    const targetsRes = await app.request('/api/targets')
    const targets = (await targetsRes.json()) as Array<{
      name: string
      capabilities: { has: string[]; gaps: Array<{ capability: string; reason: string }> }
    }>
    const surface2 = targets.find(t => t.name === 'plain-static')!.capabilities

    const auditRes = await app.request('/api/publish/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'plain-static',
        items: [{ kind: 'page', name: 'old-landing' }],
      }),
    })
    const auditBody = (await auditRes.json()) as {
      capabilities: { has: string[]; gaps: Array<{ capability: string; reason: string }> }
    }
    const surface4 = auditBody.capabilities

    // Same gap kinds across surfaces #2 and #4 — both consume
    // `inspectTarget` directly. (Surfaces #1 and #3 surface the same
    // info via different transports — log line / Issue.message — so
    // string-equality isn't the right check there; the gap KINDS
    // matching is the load-bearing invariant.)
    expect(surface2.gaps.map(g => g.capability).sort()).toEqual(surface4.gaps.map(g => g.capability).sort())
    expect(surface2.has.sort()).toEqual(surface4.has.sort())
  })
})

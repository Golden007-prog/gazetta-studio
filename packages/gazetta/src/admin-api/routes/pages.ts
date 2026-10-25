import { Hono } from 'hono'
import { loadSiteFromSource } from '../source-context.js'
import type { SourceContextResolver } from '../source-context.js'
import { CreatePageRequestSchema, type PageSummary } from '../schemas/pages.js'
import { isValidLocale } from '../../locale.js'
import { handleArchive, handlePurge, PAGE_HANDLE } from './archive.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import { computeSaveEtag } from '../../save-etag.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import type { AuditEnv } from '../middleware/audit.js'
import { buildHookContext, dispatchAfterLoad, type HookRegistry } from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import { InvalidLocaleError, PageNotFoundError, savePage } from '../../pages/save.js'
import { createPage } from '../../pages/create.js'

export interface PageRoutesOptions {
  /**
   * Registered hooks. When omitted, dispatch is a no-op (sites
   * without hooks pay zero overhead). Construct via
   * `buildHooksRegistry({ contributions })` from
   * `manifest.admin?.hooks` in the admin-api boot path.
   */
  hooks?: HookRegistry
  /**
   * Background validation scanner. When provided, save handlers notify
   * the scanner on commit so background-stage validators re-run for the
   * affected item. When omitted, save handlers run as today (save-delta
   * only).
   */
  scanner?: import('../../validation/scanner.js').ValidationScanner | null
}

export function pageRoutes(
  resolve: SourceContextResolver,
  validators: ValidatorRegistry,
  templatesDir?: string,
  opts: PageRoutesOptions = {},
) {
  const editableTarget = requireEditableTarget(resolve)
  const app = new Hono<AuditEnv>()
  const hooks = opts.hooks

  app.get('/api/pages', requireCapability('read:pages'), async c => {
    const source = await resolve(c.req.query('target'))
    // Empty target (e.g. a publish-target that's never received any
    // content) is valid per the stateless-CMS model — return an empty
    // list rather than erroring. Callers checking item availability
    // across targets (e.g. the target-switch missing-item banner) rely
    // on this: a 404/500 would force them to choose between "fail
    // open" (wrong, reports items as present) and "fail closed" (wrong,
    // hides legitimate targets the user might want to switch to).
    try {
      // Cache the summary list. Per design-scale.md, /api/pages is a
      // load-bearing read; per design-cache.md the key includes the
      // 'pages:' reserved prefix so save handlers can blow this entry
      // (and any future per-prefix entries) with one invalidatePrefix.
      // SourceContext owns the cache, so two requests against the same
      // target reuse the same instance.
      //
      // The `:target:{name}` suffix is target-scoping per design-cache.md
      // Gap 6 ("Target is a first-class dimension in cache keys when
      // value is target-scoped"). Pages can diverge between targets
      // (per design-publishing.md "targets can diverge"), so summaries
      // must too. Without the suffix, two SourceContexts sharing one
      // backing cache (operator's `gazetta.config.ts defaults.cache`)
      // would clobber each other's summaries.
      const targetKey = source.targetName ?? '__source__'
      const cacheKey = `pages:summary:target:${targetKey}`
      const cached = await source.cache.get<PageSummary[]>(cacheKey)
      if (cached) return c.json(cached)
      const site = await loadSiteFromSource(source)
      const pages: PageSummary[] = [...site.pages.entries()].map(([name, page]) => {
        const localeEntry = site.pageLocales.get(name)
        return {
          name,
          route: page.route,
          template: page.template,
          locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
          // Archive surfacing per design-soft-delete.md Q7 J1.
          ...(page.archived === true ? { archived: true } : {}),
          ...(page.aliasOf ? { aliasOf: page.aliasOf } : {}),
        }
      })
      await source.cache.set(cacheKey, pages)
      return c.json(pages)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('loadSite:')) return c.json([])
      throw err
    }
  })

  // POST delegates to `pages/create.ts` — the create-time decision
  // tree (live conflict / archived conflict prompt / archived
  // resolution / fresh create) lives there. This handler is now a
  // protocol translator: parse + Zod-validate → call `createPage` →
  // project `CreatePageResult` to HTTP. Same response shape as before.
  app.post('/api/pages', requireCapability('edit:pages'), editableTarget, async c => {
    const source = await resolve(c.req.query('target'))
    // Schema-validate the body so drift between client and server
    // can't silently accept malformed requests. The Zod schema is the
    // single source of truth, shared with the client via
    // `gazetta/admin-api/schemas` (see testing-plan.md Priority 3.2).
    const raw = await c.req.json()
    const parsed = CreatePageRequestSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json(
        {
          error: 'Invalid request body',
          issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
        },
        400,
      )
    }
    const body = parsed.data

    const result = await createPage({
      name: body.name,
      template: body.template,
      content: body.content,
      onConflict: c.req.query('onConflict'),
      source,
      principal: c.var.principal,
      audit: c.var.audit,
    })

    if (result.ok) {
      return c.json(
        result.resolution
          ? { ok: true, name: result.name, resolution: result.resolution }
          : { ok: true, name: result.name },
      )
    }
    if (result.code === 'LIVE_CONFLICT') {
      return c.json({ error: `Page "${result.name}" already exists` }, 409)
    }
    if (result.code === 'ARCHIVED_CONFLICT') {
      return c.json({ code: 'ARCHIVED_NAME_CONFLICT' as const, archive: result.archive }, 409)
    }
    // INVALID_CONFLICT_MODE — exhaustive narrow.
    return c.json({ error: `Invalid onConflict mode "${result.mode}"` }, 400)
  })

  app.get('/api/pages/:name{.+}', requireCapability('read:pages'), async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return c.json({ error: `Invalid locale code: "${rawLocale}"` }, 400)
    const source = await resolve(c.req.query('target'))
    const site = await loadSiteFromSource(source)

    // If a locale is requested, return the locale variant
    let page = site.pages.get(name)
    if (locale) {
      const localeEntry = site.pageLocales.get(name)
      const localeVariant = localeEntry?.locales.get(locale)
      if (localeVariant) page = localeVariant
      else if (!page) return c.json({ error: `Page "${name}" locale "${locale}" not found` }, 404)
    }
    if (!page) return c.json({ error: `Page "${name}" not found` }, 404)

    const localeEntry = site.pageLocales.get(name)
    // Save-concurrency etag — see save-etag.ts. Client uses this in
    // If-Match on the next PUT to detect mid-edit drift (someone else
    // saved while the author was editing). Different from the
    // `.{8hex}.hash` publish-state hash; both run.
    const etag = await computeSaveEtag({
      template: page.template,
      content: page.content,
      components: page.components,
      metadata: page.metadata,
      route: page.route,
    })
    c.header('ETag', `"${etag}"`)
    let body: Record<string, unknown> = {
      name,
      route: page.route,
      template: page.template,
      content: page.content,
      components: page.components,
      metadata: page.metadata,
      dir: page.dir,
      locale: locale ?? undefined,
      locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
      // Archive fields (per design-soft-delete.md Q1 A1) — included
      // when present so the admin UI can surface "Archived" banner +
      // alias-target indicator. Absent fields stay absent (not undefined
      // in the JSON output) per the locked invariant: `archived: false`
      // is identical to `archived` absent.
      ...(page.archived === true ? { archived: true } : {}),
      ...(page.archivedAt ? { archivedAt: page.archivedAt } : {}),
      ...(page.archivedBy ? { archivedBy: page.archivedBy } : {}),
      ...(page.aliasOf ? { aliasOf: page.aliasOf } : {}),
    }
    // afterLoad hooks per design-hooks.md "Save flow with hooks":
    // mutating chain at read time. Hooks may transform the loaded
    // payload (e.g., resolve denormalized references, inject
    // synthetic fields). Output flows to the client.
    if (hooks) {
      const ctx = buildHookContext({
        principal: c.var.principal,
        storage: source.storage,
        target: source.targetName,
        requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
        site: { name: source.manifest?.name },
        auditEmit: makeAuditFiringEmitter(c.var.audit),
      })
      body = await dispatchAfterLoad(hooks, { kind: 'page', name, locale: locale ?? undefined }, body, ctx)
    }
    return c.json(body)
  })

  // PUT delegates to `pages/save.ts` — the Page-Save spine lives in the
  // `manifest-save.ts` orchestrator (per Cut 2). This handler is now a
  // protocol translator: parse Hono request → call `savePage` →
  // project `SaveResult` to HTTP. Same response shape as before.
  app.put('/api/pages/:name{.+}', requireCapability('edit:pages'), editableTarget, async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')

    const source = await resolve(c.req.query('target'))
    const site = await loadSiteFromSource(source, { templatesDir })

    // RFC-7232 If-Match is quoted; normalize before passing through.
    const ifMatchRaw = c.req.header('If-Match')
    const ifMatch = ifMatchRaw?.replace(/^"(.*)"$/, '$1')

    const body = await c.req.json()

    let result
    try {
      result = await savePage({
        name,
        locale: rawLocale,
        body,
        ifMatch,
        site,
        source,
        principal: c.var.principal,
        audit: c.var.audit,
        validators,
        hooks,
        hookAuditEmit: makeAuditFiringEmitter(c.var.audit),
        scanner: opts.scanner ?? undefined,
        requestId: c.req.header('x-request-id') ?? undefined,
      })
    } catch (err) {
      if (err instanceof InvalidLocaleError) return c.json({ error: err.message }, 400)
      if (err instanceof PageNotFoundError) return c.json({ error: err.message }, 404)
      throw err
    }

    if (result.ok) {
      c.header('ETag', `"${result.etag}"`)
      return c.json({ ok: true, etag: result.etag })
    }
    if (result.code === 'STALE') {
      return c.json({ code: 'STALE' as const, current: result.current, currentEtag: result.currentEtag }, 409, {
        ETag: `"${result.currentEtag}"`,
      })
    }
    if (result.code === 'EDIT_LOCKED') {
      return c.json({ code: 'EDIT_LOCKED' as const, message: result.message }, 409)
    }
    if (result.code === 'VALIDATION_FAILED') {
      return c.json({ code: 'VALIDATION_FAILED' as const, issues: result.issues }, 409)
    }
    if (result.code === 'AUDIT_FAILED') {
      // Strict audit mode refused the write before anything changed
      // (#1393). 500 per the audit error taxonomy: the failure is
      // server-side (audit storage), not the client's request.
      return c.json(
        { code: 'AUDIT_FAILED' as const, message: 'Audit recording failed; save refused (strict mode)' },
        500,
      )
    }
    // HOOK_CANCELLED — exhaustive narrow per Q1 lock.
    return c.json({ code: 'HOOK_CANCELLED' as const, hook: result.hook, reason: result.reason }, 409)
  })

  // DELETE = soft-delete by default (Cut 7 cutover per design-soft-delete.md).
  // `?permanent=true` calls the purge logic from archive.ts for explicit
  // hard-delete intent (allowLive: the /purge routes themselves refuse
  // non-archived items, #1341); `?force=true` (admin-only) bypasses purge-blocked
  // checks. The unified path keeps audit shape consistent with the explicit
  // /archive and /purge routes — DELETE without `?permanent=true` audits
  // as `action: 'archive'`, DELETE with `?permanent=true` audits as
  // `action: 'purge'`.
  app.delete('/api/pages/:name{.+}', requireCapability('delete:pages'), editableTarget, async c => {
    const permanent = c.req.query('permanent') === 'true'
    if (permanent) return handlePurge(c, resolve, PAGE_HANDLE, null, { allowLive: true })
    return handleArchive(c, resolve, PAGE_HANDLE)
  })

  return app
}

import { Hono } from 'hono'
import { loadSiteFromSource } from '../source-context.js'
import type { SourceContextResolver } from '../source-context.js'
import { CreateFragmentRequestSchema, type FragmentSummary } from '../schemas/fragments.js'
import { isValidLocale } from '../../locale.js'
import { FRAGMENT_HANDLE, handleArchive, handlePurge } from './archive.js'
import type { ValidatorRegistry } from '../../validation/registry.js'
import { computeSaveEtag } from '../../save-etag.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import type { AuditEnv } from '../middleware/audit.js'
import { buildHookContext, dispatchAfterLoad, type HookRegistry } from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import { FragmentNotFoundError, InvalidLocaleError, saveFragment } from '../../fragments/save.js'
import { createFragment } from '../../fragments/create.js'
import { REDIRECT_RESTORE_MESSAGE } from '../../archive-helpers.js'

export interface FragmentRoutesOptions {
  hooks?: HookRegistry
  /**
   * Background validation scanner. Fragment saves notify the scanner to
   * re-validate this fragment + every page/fragment that references it
   * (transitively, via `findDependentsFromSidecars`).
   */
  scanner?: import('../../validation/scanner.js').ValidationScanner | null
}

export function fragmentRoutes(
  resolve: SourceContextResolver,
  validators: ValidatorRegistry,
  templatesDir?: string,
  opts: FragmentRoutesOptions = {},
) {
  const editableTarget = requireEditableTarget(resolve)
  const app = new Hono<AuditEnv>()
  const hooks = opts.hooks

  app.get('/api/fragments', requireCapability('read:fragments'), async c => {
    const source = await resolve(c.req.query('target'))
    // Empty target → empty list. See pages.ts for rationale.
    try {
      // Cache the summary list (see pages.ts for the rationale + the
      // target-scoping invariant per design-cache.md Gap 6).
      const targetKey = source.targetName ?? '__source__'
      const cacheKey = `fragments:summary:target:${targetKey}`
      const cached = await source.cache.get<FragmentSummary[]>(cacheKey)
      if (cached) return c.json(cached)
      const site = await loadSiteFromSource(source)
      const fragments: FragmentSummary[] = [...site.fragments.entries()].map(([name, frag]) => {
        const localeEntry = site.fragmentLocales.get(name)
        return {
          name,
          template: frag.template,
          locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
          // Archive surfacing per design-soft-delete.md Q7 J1.
          ...(frag.archived === true ? { archived: true } : {}),
          ...(frag.aliasOf ? { aliasOf: frag.aliasOf } : {}),
        }
      })
      await source.cache.set(cacheKey, fragments)
      return c.json(fragments)
    } catch (err) {
      const msg = (err as Error).message
      if (msg.includes('loadSite:')) return c.json([])
      throw err
    }
  })

  // POST delegates to `fragments/create.ts` — same protocol-thin
  // shape as pages POST.
  app.post('/api/fragments', requireCapability('edit:fragments'), editableTarget, async c => {
    const source = await resolve(c.req.query('target'))
    // Schema-validate the body — same rationale as pages.ts.
    const raw = await c.req.json()
    const parsed = CreateFragmentRequestSchema.safeParse(raw)
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

    const result = await createFragment({
      name: body.name,
      template: body.template,
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
      return c.json({ error: `Fragment "${result.name}" already exists` }, 409)
    }
    if (result.code === 'ARCHIVED_CONFLICT') {
      return c.json({ code: 'ARCHIVED_NAME_CONFLICT' as const, archive: result.archive }, 409)
    }
    if (result.code === 'REDIRECT_RESTORE') {
      // Manual Redirect targeted by restore (#1343).
      return c.json({ error: REDIRECT_RESTORE_MESSAGE }, 409)
    }
    // INVALID_CONFLICT_MODE — exhaustive narrow.
    return c.json({ error: `Invalid onConflict mode "${result.mode}"` }, 400)
  })

  app.get('/api/fragments/:name', requireCapability('read:fragments'), async c => {
    const name = c.req.param('name')
    const rawLocale = c.req.query('locale')
    const locale = rawLocale && isValidLocale(rawLocale) ? rawLocale.toLowerCase() : undefined
    if (rawLocale && !locale) return c.json({ error: `Invalid locale code: "${rawLocale}"` }, 400)
    const source = await resolve(c.req.query('target'))
    const site = await loadSiteFromSource(source)

    let fragment = site.fragments.get(name)
    if (locale) {
      const localeEntry = site.fragmentLocales.get(name)
      const localeVariant = localeEntry?.locales.get(locale)
      if (localeVariant) fragment = localeVariant
      else if (!fragment) return c.json({ error: `Fragment "${name}" locale "${locale}" not found` }, 404)
    }
    if (!fragment) return c.json({ error: `Fragment "${name}" not found` }, 404)

    const localeEntry = site.fragmentLocales.get(name)
    // Save-concurrency etag — see save-etag.ts. Same shape as pages
    // (without metadata + route since fragments don't carry them).
    const etag = await computeSaveEtag({
      template: fragment.template,
      content: fragment.content,
      components: fragment.components,
    })
    c.header('ETag', `"${etag}"`)
    let body: Record<string, unknown> = {
      name,
      template: fragment.template,
      content: fragment.content,
      components: fragment.components,
      dir: fragment.dir,
      locale: locale ?? undefined,
      locales: localeEntry ? [...localeEntry.locales.keys()] : undefined,
      // Archive fields per design-soft-delete.md Q1 A1. See pages.ts.
      ...(fragment.archived === true ? { archived: true } : {}),
      ...(fragment.archivedAt ? { archivedAt: fragment.archivedAt } : {}),
      ...(fragment.archivedBy ? { archivedBy: fragment.archivedBy } : {}),
      ...(fragment.aliasOf ? { aliasOf: fragment.aliasOf } : {}),
    }
    // afterLoad hooks per design-hooks.md "Save flow with hooks":
    // mutating chain at read time. See pages.ts for rationale.
    if (hooks) {
      const ctx = buildHookContext({
        principal: c.var.principal,
        storage: source.storage,
        target: source.targetName,
        requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
        site: { name: source.manifest?.name },
        auditEmit: makeAuditFiringEmitter(c.var.audit),
      })
      body = await dispatchAfterLoad(hooks, { kind: 'fragment', name, locale: locale ?? undefined }, body, ctx)
    }
    return c.json(body)
  })

  // PUT delegates to `fragments/save.ts` — the spine lives in
  // `manifest-save.ts` (per Cut 2). This handler is now a protocol
  // translator: parse Hono request → call `saveFragment` → project
  // `SaveResult` to HTTP. Same response shape as before.
  app.put('/api/fragments/:name', requireCapability('edit:fragments'), editableTarget, async c => {
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
      result = await saveFragment({
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
    } catch (err: unknown) {
      if (err instanceof InvalidLocaleError) return c.json({ error: err.message }, 400)
      if (err instanceof FragmentNotFoundError) return c.json({ error: err.message }, 404)
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
    if (result.code === 'ARCHIVED') {
      return c.json({ code: 'ARCHIVED' as const, message: result.message }, 409)
    }
    if (result.code === 'VALIDATION_FAILED') {
      return c.json({ code: 'VALIDATION_FAILED' as const, issues: result.issues }, 409)
    }
    if (result.code === 'AUDIT_FAILED') {
      // Strict audit mode refused the write before anything changed
      // (#1393); same projection as the page save route.
      return c.json(
        { code: 'AUDIT_FAILED' as const, message: 'Audit recording failed; save refused (strict mode)' },
        500,
      )
    }
    // HOOK_CANCELLED — exhaustive narrow per Q1 lock.
    return c.json({ code: 'HOOK_CANCELLED' as const, hook: result.hook, reason: result.reason }, 409)
  })

  // DELETE = soft-delete (archive) by default per Cut 7 cutover.
  // `?permanent=true` invokes purge for explicit hard-delete intent.
  // See pages.ts for the full rationale; same shape applies here.
  app.delete('/api/fragments/:name', requireCapability('delete:fragments'), editableTarget, async c => {
    const permanent = c.req.query('permanent') === 'true'
    if (permanent) return handlePurge(c, resolve, FRAGMENT_HANDLE, null, { allowLive: true })
    return handleArchive(c, resolve, FRAGMENT_HANDLE)
  })

  return app
}

/**
 * #1393: `admin.audit.strict` was accepted by the config schema and
 * documented in docs/audit.md, but never enforced — a save, publish,
 * or asset upload with a failing audit provider still succeeded, and
 * no `AUDIT_FAILED` refusal existed anywhere in the pipeline.
 *
 * Per the issue's locked decision, strict mode is record-then-write:
 * the handler records the event BEFORE writing; if recording fails,
 * the write is refused and nothing changes; if the write itself then
 * fails, a second event records the failure. strict: false (the
 * default) keeps the fail-open behaviour.
 *
 * These tests pin the enforcement through createAdminApp (the same
 * wiring production uses) against acceptance criteria:
 *
 *   - strict + throwing provider: PUT /api/pages/:name refused with
 *     typed AUDIT_FAILED, storage unchanged
 *   - strict + throwing provider: POST /api/publish refused
 *   - strict + throwing provider: POST /api/assets refused
 *   - strict + write fails after the record: a second event with
 *     outcome 'write-failed' is recorded (manifest write AND
 *     history write - the write phase is one try/catch)
 *   - strict: false + throwing provider: the save succeeds (fail-open
 *     default pinned)
 *
 * The failing provider is simulated at the storage seam: the history
 * provider persists events under `.gazetta/audit/`, so a storage whose
 * writeFile throws for that prefix is an audit provider that always
 * fails. Harness mirrors admin-api-capability-denial-audit.test.ts
 * (forwarded-user trust, admin principal, proxy connection).
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import sharp from 'sharp'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterTemplatesDir } from './_helpers/starter.js'
import { fromConnection } from './_helpers/connection.js'

/** Requests arrive from the trusted proxy. */
const FROM_PROXY = fromConnection('10.0.0.5')

const ADMIN_HEADERS = {
  'X-Forwarded-User': 'bob',
  'X-Forwarded-Groups': 'admins',
}

const HOME_PAGE = 'pages/home/page.json'
const AUDIT_PREFIX = '.gazetta/audit/'

function seedPage(): string {
  return JSON.stringify({
    template: 'page-default',
    metadata: { title: 'Home' },
    components: [],
  })
}

/**
 * Wrap a MemoryStorage so writeFile throws for paths the predicate
 * matches. The returned storage shares the inner map, so reads and
 * dump() reflect every successful write.
 */
function wrapStorage(inner: MemoryStorage, throwOn: (path: string) => boolean): MemoryStorage {
  return {
    ...inner,
    async writeFile(path: string, content: string): Promise<void> {
      if (throwOn(path)) throw new Error(`injected storage failure: ${path}`)
      return inner.writeFile(path, content)
    },
  }
}

const HISTORY_PREFIX = '.gazetta/history/'

function buildApp(opts: {
  strict: boolean
  failAuditWrites?: boolean
  failContentWrite?: boolean
  failHistoryWrite?: boolean
}): {
  app: Hono
  sourceStorage: MemoryStorage
  targetStorage: MemoryStorage
} {
  const inner = memoryStorage()
  inner.seed({ [HOME_PAGE]: seedPage() })
  const sourceStorage = wrapStorage(inner, path => {
    if (opts.failAuditWrites && path.startsWith(AUDIT_PREFIX)) return true
    if (opts.failContentWrite && path === HOME_PAGE) return true
    if (opts.failHistoryWrite && path.startsWith(HISTORY_PREFIX)) return true
    return false
  })
  const targetStorage = memoryStorage()
  const targetConfigs = {
    local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
    staging: { storage: targetStorage, type: 'esi' as const, environment: 'staging' as const },
  }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: targetConfigs,
      admin: {
        audit: { provider: 'history', strict: opts.strict },
        auth: {
          trust: 'forwarded-user',
          trustedProxies: ['10.0.0.0/8'],
          roleMapping: {
            claim: 'groups',
            map: { admins: 'admin' },
            defaultRole: 'editor',
          },
        },
      },
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
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, sourceStorage, targetStorage }
}

async function auditLog(app: Hono): Promise<Array<Record<string, unknown>>> {
  const res = await app.request('/api/audit', { headers: ADMIN_HEADERS }, FROM_PROXY)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { events: Array<Record<string, unknown>> }
  return body.events
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
}

describe('admin.audit.strict enforcement (#1393)', { timeout: 30000 }, () => {
  it('refuses a page save with typed AUDIT_FAILED and leaves storage unchanged', async () => {
    const { app, sourceStorage } = buildApp({ strict: true, failAuditWrites: true })

    const res = await app.request(
      '/api/pages/home',
      {
        method: 'PUT',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { title: 'Changed' } }),
      },
      FROM_PROXY,
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('AUDIT_FAILED')

    // Nothing changed on disk — the refusal happens before any write.
    expect(await sourceStorage.readFile(HOME_PAGE)).toBe(seedPage())
    for (const key of sourceStorage.dump().keys()) {
      expect(key.startsWith('.gazetta/')).toBe(false)
    }
  })

  it('refuses a publish with typed AUDIT_FAILED', async () => {
    const { app, targetStorage } = buildApp({ strict: true, failAuditWrites: true })

    const res = await app.request(
      '/api/publish',
      {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
      },
      FROM_PROXY,
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('AUDIT_FAILED')

    // Nothing reached the target.
    expect(targetStorage.dump().size).toBe(0)
  })

  it('refuses an asset upload with typed AUDIT_FAILED', async () => {
    const { app, sourceStorage } = buildApp({ strict: true, failAuditWrites: true })
    const bytes = await jpegBuffer()
    const form = new FormData()
    form.set('file', new File([new Uint8Array(bytes)], 'hero.jpg', { type: 'image/jpeg' }))
    form.set('name', 'hero')
    form.set('alt', 'Hero banner')

    const res = await app.request('/api/assets', { method: 'POST', headers: ADMIN_HEADERS, body: form }, FROM_PROXY)
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('AUDIT_FAILED')

    // No asset files landed in storage.
    for (const key of sourceStorage.dump().keys()) {
      expect(key.startsWith('assets/')).toBe(false)
      expect(key.startsWith('.gazetta/')).toBe(false)
    }
  })

  it('records a second write-failed event when the write fails after the record', async () => {
    const { app, sourceStorage } = buildApp({ strict: true, failContentWrite: true })

    const res = await app.request(
      '/api/pages/home',
      {
        method: 'PUT',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { title: 'Changed' } }),
      },
      FROM_PROXY,
    )
    expect(res.status).toBe(500)

    // The content never changed...
    expect(await sourceStorage.readFile(HOME_PAGE)).toBe(seedPage())

    // ...but the log holds both the pre-write event and the failure
    // record, so it does not claim a change that never happened.
    const events = await auditLog(app)
    const saves = events.filter(e => e.action === 'save')
    expect(saves).toHaveLength(2)
    // /api/audit returns newest-first and both events can share a
    // timestamp, so compare as a set.
    expect(saves.map(e => e.outcome).sort()).toEqual(['success', 'write-failed'])
  })

  it('refuses a streaming publish with typed AUDIT_FAILED before the stream opens', async () => {
    const { app, targetStorage } = buildApp({ strict: true, failAuditWrites: true })

    const res = await app.request(
      '/api/publish/stream',
      {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['pages/home'], targets: ['staging'] }),
      },
      FROM_PROXY,
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('AUDIT_FAILED')

    // Nothing reached the target.
    expect(targetStorage.dump().size).toBe(0)
  })

  it('records write-failed when the history write fails after the record', async () => {
    const { app, sourceStorage } = buildApp({ strict: true, failHistoryWrite: true })

    const res = await app.request(
      '/api/pages/home',
      {
        method: 'PUT',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { title: 'Changed' } }),
      },
      FROM_PROXY,
    )
    expect(res.status).toBe(500)

    // The manifest never changed...
    expect(await sourceStorage.readFile(HOME_PAGE)).toBe(seedPage())

    // ...and the failure did not go unrecorded: the write phase is
    // one try/catch, so a history-write failure gets the same
    // compensating event as a manifest-write failure.
    const events = await auditLog(app)
    const saves = events.filter(e => e.action === 'save')
    expect(saves).toHaveLength(2)
    expect(saves.map(e => e.outcome).sort()).toEqual(['success', 'write-failed'])
  })

  it('keeps fail-open behaviour with strict: false — the save succeeds', async () => {
    const { app, sourceStorage } = buildApp({ strict: false, failAuditWrites: true })

    const res = await app.request(
      '/api/pages/home',
      {
        method: 'PUT',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { title: 'Changed' } }),
      },
      FROM_PROXY,
    )
    expect(res.status).toBe(200)

    const persisted = JSON.parse(await sourceStorage.readFile(HOME_PAGE)) as {
      content: { title: string }
    }
    expect(persisted.content.title).toBe('Changed')
  })
})

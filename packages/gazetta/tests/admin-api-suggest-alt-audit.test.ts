/**
 * Cross-foundation gap #4 (per testing-plan.md punch list):
 * AI alt-text refusal — audit log records the refusal with provider
 * name + reason. Forensic concern: without an audit trail for
 * refusals, "why didn't this image get alt?" is unanswerable.
 *
 * Per design-ai.md + design-audit.md: every suggest-alt invocation
 * records a `'ai-suggest-alt'` audit event (closed-enum action
 * extension). Outcome stays `'success'` for both happy-path and
 * refusal — the API call succeeded; the refusal is a domain detail
 * surfaced via `metadata.refused: true` + `metadata.refusalReason` +
 * `metadata.provider`. Adapter failures emit `outcome: 'failed-render'`
 * (deferred — out of scope for this gap; v2 ambient log).
 *
 * The route-handler today emits NO audit at all — this test fails
 * before the fix, then guards against regression.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * `memoryStorage()` + a fresh `createAdminApp` with a recording audit
 * provider via `createHistoryAuditProvider`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createHistoryAuditProvider, type AuditEvent } from '../src/audit/index.js'
import { ollamaProvider } from '../src/alt/ollama.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OLLAMA_BASE_URL'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

let app: Hono
let storage: MemoryStorage

async function jpegBytes(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

async function setup() {
  storage = memoryStorage()
  // Seed an asset so suggest-alt has something to read.
  const bytes = await jpegBytes()
  const manifest = {
    version: 1,
    name: 'hero',
    kind: 'embedded',
    source: 'internal',
    mime: 'image/jpeg',
    size: bytes.byteLength,
    hash: 'abc12345',
    width: 200,
    height: 200,
    duration: null,
    alt: null,
    focalPoint: null,
    tags: [],
    variants: [],
    variantsStatus: 'complete',
    uploadedAt: '2026-05-03T00:00:00Z',
    uploadedBy: '',
  }
  await storage.writeFile('assets/hero.asset.json', JSON.stringify(manifest))
  await storage.writeBytes('assets/hero-abc12345.jpg', bytes)

  const targetConfigs = {
    local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: {
      name: 'test-site',
      targets: targetConfigs,
      ai: { provider: ollamaProvider() },
      altText: { auto: true },
    },
  })
  app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
}

async function readAuditEvents(): Promise<AuditEvent[]> {
  const reader = createHistoryAuditProvider({ storage, instance: 'reader-only' })
  return reader.query!({})
}

describe('Cross-foundation gap #4 — suggest-alt audit recording', () => {
  beforeEach(async () => {
    await setup()
  })

  it('successful suggestion records ai-suggest-alt audit with provider + locale', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        return new Response(
          JSON.stringify({ message: { role: 'assistant', content: 'A black square.' }, done: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
      expect(res.status).toBe(200)
    } finally {
      globalThis.fetch = originalFetch
    }

    const events = await readAuditEvents()
    const matched = events.filter(
      e => e.action === 'ai-suggest-alt' && e.scope.kind === 'asset' && e.scope.name === 'hero',
    )
    expect(matched).toHaveLength(1)
    const ev = matched[0]
    expect(ev.outcome).toBe('success')
    expect(ev.metadata).toMatchObject({
      provider: 'ollama',
      locale: 'en',
      refused: false,
    })
    // A refusal reason is recorded only for refusals.
    expect(ev.metadata).not.toHaveProperty('refusalReason')
  })

  it('refused suggestion records ai-suggest-alt with refused: true + refusalReason', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        return new Response(
          JSON.stringify({ message: { role: 'assistant', content: "I can't describe this image." }, done: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { refused: boolean }
      expect(body.refused).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }

    const events = await readAuditEvents()
    const matched = events.filter(e => e.action === 'ai-suggest-alt' && e.scope.name === 'hero')
    expect(matched).toHaveLength(1)
    const ev = matched[0]
    // The API call succeeded; refusal is a domain detail in metadata.
    expect(ev.outcome).toBe('success')
    expect(ev.metadata).toMatchObject({
      provider: 'ollama',
      refused: true,
    })
    // refusalReason is the raw refusal text snippet (capped) per
    // ai/refusal.ts; assertion is non-empty rather than exact match
    // because the 200-char cap could change.
    expect(typeof ev.metadata?.refusalReason).toBe('string')
    expect((ev.metadata!.refusalReason as string).length).toBeGreaterThan(0)
  })

  it('locale parameter surfaces in audit metadata', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('localhost:11434')) {
        return new Response(
          JSON.stringify({ message: { role: 'assistant', content: 'Une image noire.' }, done: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      throw new Error(`unexpected url: ${url}`)
    }
    try {
      await app.request('/api/assets/hero/suggest-alt?locale=fr', { method: 'POST' })
    } finally {
      globalThis.fetch = originalFetch
    }

    const events = await readAuditEvents()
    const matched = events.filter(e => e.action === 'ai-suggest-alt' && e.scope.name === 'hero')
    expect(matched).toHaveLength(1)
    expect(matched[0].metadata).toMatchObject({ locale: 'fr' })
  })
})

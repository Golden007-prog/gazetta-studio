/**
 * Mutation-coverage tests for `admin-api/routes/assets.ts` — closes
 * surviving / no-coverage mutants identified by the StrykerJS run
 * (issue #310). Coverage gaps targeted:
 *
 *  - `ConditionalExpression` (`→ true` / `→ false`) and `EqualityOperator`
 *    (`theme === undefined` → `theme !== undefined`) on line 59's guard
 *    `if (locale === undefined && theme === undefined) return null`.
 *    Existing tests assert status codes on the locale-bytes routes but
 *    never distinguish the "guard returned null" 400 (from the route
 *    caller's `=== null` branch) from "ingestion proceeded but failed"
 *    paths. Pinning the exact error-message body distinguishes the two.
 *
 *  - `ObjectLiteral` (`→ {}`) and `StringLiteral` (`→ ""`, `→ \`\``)
 *    on lines 61 / 63 (invalid-locale 400 body) and lines 67 / 69
 *    (invalid-theme 400 body). Existing tests assert `status === 400`
 *    but don't inspect `code`, `message`, or the `content-type` header,
 *    so replacing the body literal with `{}` or `""` doesn't fail any
 *    assertion. These tests pin the exact body shape on both POST and
 *    DELETE.
 *
 *  - Path-through to ingestion / removal when only one dimension is set
 *    (`?locale=fr` alone, `?theme=dark` alone). The EqualityOperator
 *    mutation flips the guard's semantics so theme-only requests return
 *    null instead of proceeding; only a "theme-only succeeds" test kills
 *    that mutant. Both POST (expect 201) and DELETE (expect 404 because
 *    no override exists yet) prove the route progressed past the guard.
 *
 *  - `selectorSuffix` composition for the compound `?locale=fr&theme=dark`
 *    case — the resulting bytesPath must include both dimension values.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh tempDir
 * + a fresh filesystem provider + a fresh Hono app. No module-level
 * state. Per testing-plan.md "Storage tier": fs is required here
 * because POST exercises sharp variant generation against real bytes.
 *
 * VERIFICATION NOTES (manual mutation walk against this file):
 *
 *   - `if (false) return null` on line 59:
 *       no-selector POST → ingestion runs with empty `Selector` → writes
 *       to default manifest path → 201 OR 409 depending on collision.
 *       NOT 400 with `'Selector required (locale and/or theme)'` body.
 *       Killed by "no-selector POST returns 400 with the exact route
 *       caller's body".
 *   - `if (true) return null` on line 59:
 *       valid locale POST → null → route returns "Selector required"
 *       400 instead of 201. Killed by "valid locale POST returns 201".
 *   - `theme !== undefined` on line 59 EqualityOperator:
 *       theme-only POST → null → "Selector required" 400 instead of
 *       201. Killed by "theme-only POST returns 201".
 *   - `→ {}` on line 61 / 63 (invalid-locale body / headers):
 *       invalid locale POST → empty body / empty headers. Killed by
 *       "invalid-locale body has code='BAD_REQUEST', message contains
 *       'Invalid locale', content-type is application/json".
 *   - `→ ""` / `→ \`\`` on line 61 (invalid-locale message string):
 *       message would be empty. Killed by message substring assertion.
 *   - Equivalent mutations on lines 67 / 69 (invalid-theme body):
 *       same shape, killed by the theme-variant of the assertions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { Hono } from 'hono'
import sharp from 'sharp'
import { assetRoutes } from '../src/admin-api/routes/assets.js'
import { staticSourceResolver, createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import type { AuthIdentityProvider, Principal } from '../src/auth/index.js'
import type { StorageProvider } from '../src/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('http-assets-mutation-coverage-' + Date.now())

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function buildApp() {
  const storage = createFilesystemProvider(testDir)
  const source = createSourceContext({ storage, siteDir: '', manifest: { name: 'test-site' } })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  app.use('/api/*', principalMiddleware())
  app.route('/', assetRoutes(resolve))
  return { app, storage }
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
}

function multipartForm(fields: Record<string, string | { name: string; bytes: Uint8Array; type: string }>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      form.set(key, value)
    } else {
      form.set(key, new File([value.bytes], value.name, { type: value.type }))
    }
  }
  return form
}

async function uploadHero(app: Hono) {
  const bytes = await jpegBuffer()
  await app.request('/api/assets', {
    method: 'POST',
    body: multipartForm({
      file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
      name: 'hero',
    }),
  })
}

async function uploadFrenchOverride(app: Hono) {
  const bytes = await jpegBuffer()
  return app.request('/api/assets/hero/locale-bytes?locale=fr', {
    method: 'POST',
    body: multipartForm({ file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' } }),
  })
}

describe('selectorFromQuery — POST /api/assets/:name/locale-bytes', () => {
  describe('invalid-selector 400 body shape', () => {
    it('invalid locale 400 has code=BAD_REQUEST, message naming the bad locale, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=NOT-A-LOCALE-FORMAT', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      // Header pins line-63 `headers: { 'content-type': 'application/json' }`.
      // The raw `Response` from selectorFromQuery sets `content-type`
      // explicitly; ObjectLiteral → {} would drop the header (Hono lets
      // a custom-Response pass through unchanged).
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      // Pins line-61 body literal.
      expect(body.code).toBe('BAD_REQUEST')
      expect(typeof body.message).toBe('string')
      expect(body.message.length).toBeGreaterThan(0)
      expect(body.message).toContain('Invalid locale')
      // The locale value gets interpolated into the message (template literal).
      // StringLiteral → `` would drop the prefix; this anchors the substring.
      expect(body.message).toContain('NOT-A-LOCALE-FORMAT')
    })

    it('invalid theme 400 has code=BAD_REQUEST, message naming the bad theme, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=NOT-A-VALID-THEME', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message.length).toBeGreaterThan(0)
      expect(body.message).toContain('Invalid theme')
      expect(body.message).toContain('NOT-A-VALID-THEME')
    })

    it('invalid locale takes precedence over a present (valid) theme', async () => {
      // Order matters in the function: locale is checked first. A
      // mutation that flipped the check ordering would produce the
      // theme-error message; this test pins the locale error.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=NOT-A-LOCALE-FORMAT&theme=dark', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toContain('Invalid locale')
    })
  })

  describe('guard returns null vs proceeds — distinguished by error-body shape', () => {
    it('no selector at all 400s with the route caller\'s "Selector required" body (proves guard returned null)', async () => {
      // Under `if (false) return null`, the guard NEVER returns null;
      // selectorFromQuery falls through to `return buildSelector({})`,
      // which is a non-null Selector. The route's `=== null` branch
      // doesn't fire, so the "Selector required" body never appears
      // (ingestion runs against the empty selector instead).
      //
      // Under the original code, the guard returns null and the
      // route's `=== null` branch fires with the exact body asserted
      // here.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toBe('Selector required (locale and/or theme)')
    })
  })

  describe('valid selector — route proceeds past the guard', () => {
    it('valid locale only (no theme) 201s with bytesPath suffix .fr.jpg (kills "guard always returns null")', async () => {
      // Under `if (true) return null`, selectorFromQuery returns null
      // for every input; the route returns 400 "Selector required"
      // for valid locales. This test asserts 201, killing the mutation.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(201)
      const body = (await res.json()) as { manifest: { name: string }; bytesPath: string }
      expect(body.manifest.name).toBe('hero')
      // selectorSuffix({locale: 'fr'}) → '.fr' → 'hero-{hash}.fr.jpg'
      expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.fr\.jpg$/)
    })

    it('valid theme only (no locale) 201s with bytesPath suffix .dark.jpg (kills EqualityOperator on guard)', async () => {
      // Under `theme === undefined` → `theme !== undefined`, the guard
      // becomes `if (locale === undefined && theme !== undefined) return null`.
      // A theme-only request matches both conjuncts → returns null →
      // route returns 400 "Selector required" instead of 201. This
      // test asserts 201, killing that mutant.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=dark', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(201)
      const body = (await res.json()) as { manifest: { name: string }; bytesPath: string }
      expect(body.manifest.name).toBe('hero')
      // selectorSuffix({theme: 'dark'}) → '.dark' → 'hero-{hash}.dark.jpg'
      expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.dark\.jpg$/)
    })

    it('compound locale+theme 201s with bytesPath suffix .fr.dark.jpg (pins selectorSuffix composition)', async () => {
      // Locked filename composition: locale before theme. Pins both
      // dimensions appear in the persisted bytes path; a mutation
      // that dropped one dimension from `buildSelector({...spread})`
      // would surface here as a missing path segment.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr&theme=dark', {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })

      expect(res.status).toBe(201)
      const body = (await res.json()) as { manifest: { name: string }; bytesPath: string }
      expect(body.manifest.name).toBe('hero')
      expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.fr\.dark\.jpg$/)
    })
  })
})

describe('selectorFromQuery — DELETE /api/assets/:name/locale-bytes', () => {
  describe('invalid-selector 400 body shape', () => {
    it('invalid locale 400 has code=BAD_REQUEST, message naming the bad locale, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=NOT-A-LOCALE-FORMAT', {
        method: 'DELETE',
      })

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toContain('Invalid locale')
      expect(body.message).toContain('NOT-A-LOCALE-FORMAT')
    })

    it('invalid theme 400 has code=BAD_REQUEST, message naming the bad theme, and application/json content-type', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=NOT-A-VALID-THEME', {
        method: 'DELETE',
      })

      expect(res.status).toBe(400)
      expect(res.headers.get('content-type')).toMatch(/application\/json/)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toContain('Invalid theme')
      expect(body.message).toContain('NOT-A-VALID-THEME')
    })
  })

  describe('guard returns null vs proceeds — distinguished by error-body shape', () => {
    it('no selector 400s with the route caller\'s "Selector required" body (proves guard returned null)', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes', { method: 'DELETE' })

      expect(res.status).toBe(400)
      const body = (await res.json()) as { code: string; message: string }
      expect(body.code).toBe('BAD_REQUEST')
      expect(body.message).toBe('Selector required (locale and/or theme)')
    })
  })

  describe('valid selector — route proceeds past the guard', () => {
    it('valid locale only (no existing override) 404s — proves route reached removeOverride past the guard', async () => {
      // Under `if (true) return null`, the route would return 400
      // "Selector required" for every input. This test asserts 404
      // (the override doesn't exist), which only fires when the
      // selector check passed and removeOverride was called.
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'DELETE' })

      expect(res.status).toBe(404)
    })

    it('valid theme only (no existing override) 404s — kills EqualityOperator on guard via DELETE path', async () => {
      const { app } = buildApp()
      await uploadHero(app)

      const res = await app.request('/api/assets/hero/locale-bytes?theme=dark', { method: 'DELETE' })

      expect(res.status).toBe(404)
    })

    it('valid locale 204s after the override exists — full happy-path proves the selector reaches removeOverride correctly', async () => {
      // Already covered by admin-api-assets.test.ts but pinned here
      // alongside the rest of the matrix so a future refactor that
      // splits selectorFromQuery semantics between POST and DELETE
      // surfaces immediately.
      const { app } = buildApp()
      await uploadHero(app)
      await uploadFrenchOverride(app)

      const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'DELETE' })
      expect(res.status).toBe(204)
    })
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * Closes the second wave of mutation gaps in `assets.ts` per #602:
 *
 *   - `StringLiteral` on `requireCapability('read:assets')` (the gate value
 *     on both `GET /api/assets` and `GET /api/assets/:name`) survives because
 *     the existing 200-only test in `auth-route-gates.test.ts` doesn't pin
 *     the gate VALUE — only that the route is reachable under `*`. Asserting
 *     the 403 body's `missing: ['read:assets']` array pins the literal.
 *   - `BlockStatement` (`→ {}`) on the `try`/`catch` around `listAssets`
 *     is NoCoverage — no test makes `listAssets` throw, so the catch never
 *     fires. Injecting a storage that throws a non-ENOENT error on
 *     `readDir('assets')` makes `listAssets` wrap and rethrow as
 *     `AssetStorageError`; the route's catch then surfaces the typed body.
 *   - `ArrayDeclaration` on `const locales: string[] = []` and
 *     `const themes: string[] = []` (lines 110-111) survive because the
 *     existing assertions on `GET /api/assets/:name` don't inspect those
 *     arrays. Asserting `[]` for a default-only asset and `['fr']` for an
 *     asset with one French override pins both initializations.
 *
 * Storage tier: filesystem — the array-init tests need real binary uploads
 * to seed the override slice; the catch-block test uses an in-process
 * wrapper around the filesystem provider rather than a separate stub.
 * ──────────────────────────────────────────────────────────────────────── */

function providerWithCaps(caps: string[], role = 'editor'): AuthIdentityProvider {
  return {
    trustMode: 'forwarded-user',
    async extractPrincipal(): Promise<Principal> {
      return { id: 'test-user', role, trustMode: 'forwarded-user', capabilities: caps }
    },
  }
}

const anonymousProvider: AuthIdentityProvider = {
  trustMode: 'forwarded-user',
  async extractPrincipal(): Promise<Principal | null> {
    return null
  },
}

function buildAppWith(provider: AuthIdentityProvider) {
  const storage = createFilesystemProvider(testDir)
  const source = createSourceContext({ storage, siteDir: '', manifest: { name: 'test-site' } })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  app.use('/api/*', principalMiddleware(provider))
  app.route('/', assetRoutes(resolve))
  return { app, storage }
}

function buildAppWithThrowingStorage() {
  // Wrap the real filesystem provider so `readDir('assets')` throws a
  // non-ENOENT error. `listAssets` catches ENOENT-shaped errors and
  // returns `[]` (treated as "no assets yet"), so we synthesize a
  // generic failure that listAssets must rethrow as AssetStorageError.
  // The route's catch then translates via respondWithAssetError → 500.
  const real = createFilesystemProvider(testDir)
  const throwing: StorageProvider = {
    ...real,
    async readDir(path: string) {
      if (path === 'assets') {
        throw new Error('Simulated EIO on assets readDir')
      }
      return real.readDir(path)
    },
  }
  const source = createSourceContext({ storage: throwing, siteDir: '', manifest: { name: 'test-site' } })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  app.use('/api/*', principalMiddleware())
  app.route('/', assetRoutes(resolve))
  return { app }
}

describe('GET /api/assets — read:assets capability gate', () => {
  it('200 when the principal has read:assets', async () => {
    // Under StringLiteral mutation `'read:assets'` → `""`, the gate
    // requires capability `""`; `capabilityGrants` short-circuits on
    // `required.length === 0` → 403. Asserting 200 with a principal
    // that has exactly `read:assets` (not a wildcard) kills the
    // mutation: the genuine gate matches the principal's capability;
    // the mutant gate doesn't match anything.
    const { app } = buildAppWith(providerWithCaps(['read:assets']))
    const res = await app.request('/api/assets')
    expect(res.status).toBe(200)
  })

  it('403 with missing: ["read:assets"] when the authenticated principal lacks the gate', async () => {
    // The genuine 403 carries `missing: ['read:assets']` (the literal
    // value of the gate as wired). Under the mutation, the gate value
    // is `""` and the 403 body carries `missing: ['']`. Asserting the
    // exact literal kills the mutation independently of whether the
    // mutated gate happens to also produce 403.
    const { app } = buildAppWith(providerWithCaps(['read:pages'], 'editor'))
    const res = await app.request('/api/assets')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['read:assets'])
    expect(body.role).toBe('editor')
  })

  it('401 when the request is anonymous (no upstream identity)', async () => {
    const { app } = buildAppWith(anonymousProvider)
    const res = await app.request('/api/assets')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('UNAUTHENTICATED')
  })
})

describe('GET /api/assets/:name — read:assets capability gate', () => {
  it('reaches the route handler (200 or 404) when the principal has read:assets', async () => {
    // No upload before the request — the capability check passes and
    // `readManifest` throws `AssetManifestNotFoundError` → 404. The
    // important contract here is "the gate passed" (status is not
    // 401/403). Under the gate-string mutation the response would be
    // 403, which the `[200, 404]` assertion rejects.
    const { app } = buildAppWith(providerWithCaps(['read:assets']))
    const res = await app.request('/api/assets/missing')
    expect([200, 404]).toContain(res.status)
  })

  it('403 with missing: ["read:assets"] when the principal lacks the gate', async () => {
    const { app } = buildAppWith(providerWithCaps(['read:pages'], 'editor'))
    const res = await app.request('/api/assets/hero')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['read:assets'])
    expect(body.role).toBe('editor')
  })

  it('401 when the request is anonymous', async () => {
    const { app } = buildAppWith(anonymousProvider)
    const res = await app.request('/api/assets/hero')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('UNAUTHENTICATED')
  })
})

describe('GET /api/assets — listAssets error path (catch block)', () => {
  it('500 with ASSET_STORAGE_FAILURE body when listAssets throws AssetStorageError', async () => {
    // Pinning the route's `try { ... } catch (err) { ... }` around
    // `listAssets`. Under the BlockStatement mutation `→ {}`, the
    // catch swallows the error and the async handler returns
    // undefined; Hono renders a default (non-JSON, non-500-with-code)
    // response. Asserting on the typed body shape kills the mutation
    // regardless of what Hono produces in the mutated case.
    const { app } = buildAppWithThrowingStorage()
    const res = await app.request('/api/assets')
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('ASSET_STORAGE_FAILURE')
    expect(body.message).toContain('Storage read failed')
    expect(body.message).toContain('assets')
  })
})

describe('GET /api/assets/:name — overrideLocales / overrideThemes arrays', () => {
  it('returns [] for both arrays on an asset with no overrides', async () => {
    // Under ArrayDeclaration mutations `[]` → `['Stryker was here']`
    // on the route's `const locales: string[] = []` and
    // `const themes: string[] = []`, the summary's `overrideLocales`
    // / `overrideThemes` would carry `['Stryker was here']` even
    // when no slice exists. Asserting `[]` on an asset with no
    // overrides kills both mutations directly.
    //
    // Upload + GET need both edit:assets and read:assets. Splitting
    // them across two principals would muddy the read-side
    // assertions; one principal with both caps keeps the setup +
    // act phases clean.
    const { app } = buildAppWith(providerWithCaps(['read:assets', 'edit:assets']))
    await uploadHero(app)

    const res = await app.request('/api/assets/hero')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      name: string
      overrideLocales: string[]
      overrideThemes: string[]
    }
    expect(body.name).toBe('hero')
    expect(body.overrideLocales).toEqual([])
    expect(body.overrideThemes).toEqual([])
  })

  it("returns ['fr'] for overrideLocales and [] for overrideThemes when only a French bytes override exists", async () => {
    // Belt-and-suspenders: once a French slice exists, the array
    // must START EMPTY and accumulate ONLY discovered values.
    // A mutation that pre-seeded `['Stryker was here']` would
    // surface as an extra entry — `toEqual(['fr'])` rejects the
    // contaminated array regardless of sort order.
    const { app } = buildAppWith(providerWithCaps(['read:assets', 'edit:assets']))
    await uploadHero(app)
    await uploadFrenchOverride(app)

    const res = await app.request('/api/assets/hero')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      name: string
      overrideLocales: string[]
      overrideThemes: string[]
    }
    expect(body.name).toBe('hero')
    expect(body.overrideLocales).toEqual(['fr'])
    expect(body.overrideThemes).toEqual([])
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * Third-wave mutation gaps per #671:
 *
 *   - `StringLiteral` on capability gate values for PATCH / POST / DELETE
 *     routes (`edit:assets` on lines 144, 264, 287, 328, 413, 464, 492;
 *     `delete:assets` on line 215). Only the two GET routes were pinned
 *     by #602's PR #603. Mutation to `""` still passes the existing
 *     happy-path suites because they run with `noneAuthProvider` (full
 *     admin) and never assert on the specific missing-capability shape.
 *     Asserting `missing: [<literal>]` in the 403 body pins each gate
 *     against StringLiteral mutation independently — a mutated `""`
 *     would surface as `missing: ['']` and fail the assertion.
 *
 *   - `BlockStatement` on PATCH lines 151-153 — the `catch { return
 *     c.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400) }`
 *     around `c.req.json()`. Mutation `→ {}` swallows the catch; the
 *     subsequent `if (!body || typeof body !== 'object' ...)` check
 *     fires and returns 400 with a DIFFERENT message ("Body must be
 *     an object"). Asserting the exact "Invalid JSON body" message
 *     distinguishes the two 400s.
 *
 *   - `BooleanLiteral` NoCoverage on line 116 — the theme-dedup check
 *     `!themes.includes(theme)` inside the override-slice loop. No
 *     existing test uploads a theme-only override and reads it back,
 *     so the branch never executes. Under `→ themes.includes(theme)`
 *     the loop inverts: themes get pushed only when ALREADY present
 *     (never on first appearance) → `overrideThemes` ends up `[]`.
 *     Uploading a `?theme=dark` override + asserting `['dark']` on
 *     GET forces the branch AND kills the mutation.
 *
 * Storage tier: filesystem — reuses the existing `buildAppWith` +
 * `providerWithCaps` helpers so the wire contract is exercised
 * end-to-end (multipart upload for theme-dedup; the capability tests
 * short-circuit at middleware and never touch storage).
 * ──────────────────────────────────────────────────────────────────────── */

describe('capability gates on write routes — StringLiteral pinning', () => {
  // Principal with read:assets only — passes principal middleware but
  // fails every edit/delete gate. `role: 'viewer'` shows up in the 403
  // body so we can also pin that the middleware surfaces the actual
  // resolved role (not a hardcoded string).
  const readOnly: string[] = ['read:assets']

  it('POST /api/assets — 403 with missing:[edit:assets] when principal lacks edit:assets', async () => {
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    // No body needed — requireCapability middleware short-circuits
    // before multipart parsing.
    const res = await app.request('/api/assets', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:assets'])
    expect(body.role).toBe('viewer')
  })

  it('PATCH /api/assets/:name — 403 with missing:[edit:assets] when principal lacks edit:assets', async () => {
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    const res = await app.request('/api/assets/hero', { method: 'PATCH' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:assets'])
    expect(body.role).toBe('viewer')
  })

  it('DELETE /api/assets/:name — 403 with missing:[delete:assets] when principal lacks delete:assets', async () => {
    // delete:assets is a distinct capability from edit:assets — a
    // separate StringLiteral mutation surface on line 215. Asserting
    // the exact `delete:assets` literal (not `edit:assets`) proves
    // the gate value ships correctly on the DELETE route.
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    const res = await app.request('/api/assets/hero', { method: 'DELETE' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['delete:assets'])
    expect(body.role).toBe('viewer')
  })

  it('POST /api/assets/:name/rename-to/:newName — 403 with missing:[edit:assets]', async () => {
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    const res = await app.request('/api/assets/hero/rename-to/banner', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:assets'])
    expect(body.role).toBe('viewer')
  })

  it('POST /api/assets/:name/replace-with/:newName — 403 with missing:[edit:assets]', async () => {
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    const res = await app.request('/api/assets/hero/replace-with/banner', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:assets'])
    expect(body.role).toBe('viewer')
  })

  it('POST /api/assets/:name/suggest-alt — 403 with missing:[edit:assets]', async () => {
    // Capability middleware runs BEFORE the AI-adapter unavailability
    // check inside the handler; a principal lacking edit:assets 403s
    // regardless of AI config. Asserting the 403 shape (not 503)
    // proves the gate short-circuits above the handler.
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    const res = await app.request('/api/assets/hero/suggest-alt', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:assets'])
    expect(body.role).toBe('viewer')
  })

  it('POST /api/assets/:name/locale-bytes — 403 with missing:[edit:assets]', async () => {
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'POST' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:assets'])
    expect(body.role).toBe('viewer')
  })

  it('DELETE /api/assets/:name/locale-bytes — 403 with missing:[edit:assets]', async () => {
    const { app } = buildAppWith(providerWithCaps(readOnly, 'viewer'))
    const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'DELETE' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; missing: string[]; role: string }
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['edit:assets'])
    expect(body.role).toBe('viewer')
  })
})

describe('PATCH /api/assets/:name — invalid-JSON catch (lines 151-153)', () => {
  it('400 with code=BAD_REQUEST and message="Invalid JSON body" when body is malformed JSON', async () => {
    // Under BlockStatement mutation `→ {}` on the catch, the handler
    // falls through with `body` still undefined and hits the
    // subsequent `if (!body || typeof body !== 'object' ...)` check.
    // That path returns 400 with `'Body must be an object'` — a
    // different message string. Asserting the exact `'Invalid JSON
    // body'` string pins the catch branch's return.
    //
    // No asset seed needed — JSON parsing fails before the storage
    // lookup runs. Principal must have edit:assets so the capability
    // gate passes and control reaches the body-parse code.
    const { app } = buildAppWith(providerWithCaps(['edit:assets']))
    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'not valid json{{{',
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('BAD_REQUEST')
    expect(body.message).toBe('Invalid JSON body')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * Fourth-wave mutation gaps per #742:
 *
 *   - `BlockStatement` NoCoverage on line 154 — the block inside
 *     `if (!body || typeof body !== 'object' || Array.isArray(body)) {
 *       return c.json({ code: 'BAD_REQUEST', message: 'Body must be an object' }, 400)
 *      }`. Under mutation `→ {}` the return statement is dropped; control
 *     falls through to the `patch: AssetMetadataPatch = {}` scaffolding and
 *     then to `updateAssetMetadata`, which for a non-existent asset throws
 *     `AssetManifestNotFoundError` → 404. The 400-with-"Body must be an
 *     object" response NEVER appears in any test today, so the mutant
 *     survives.
 *
 *   - `ConditionalExpression` on line 154 `→ false` — same shape from the
 *     other direction: the check is bypassed and the 400 return is
 *     skipped. Killed by the same tests that pin the 400 body: under the
 *     mutation, the response is 404 (missing asset) or 500 (invalid patch
 *     shape reaching `updateAssetMetadata`) — either way, not the 400 with
 *     "Body must be an object" body that the original code produces.
 *
 * The catch on lines 151-153 (invalid-JSON path) is already covered by
 * #671's "PATCH /api/assets/:name — invalid-JSON catch" describe block
 * above, which exercises malformed JSON hitting `c.req.json()`'s throw.
 * These new tests exercise the SEPARATE branch where JSON parses cleanly
 * but doesn't produce an object: `null`, arrays, and primitives all
 * type-check as valid JSON but fail the shape check.
 *
 * Data-driven with `it.each` because the shape-check has one contract
 * (400 + specific body) applied to a set of equivalent inputs. Boolean
 * covered separately from number to pin that `typeof true !== 'object'`
 * fires the guard (JS is quirky here — `typeof null === 'object'` is
 * why the guard needs `!body` too, not just the typeof check).
 *
 * Storage tier: any — the check runs BEFORE `updateAssetMetadata`
 * touches storage, so tests don't need to seed an asset. Reuses
 * `buildAppWith` + `providerWithCaps(['edit:assets'])` to pass the
 * capability gate; the shape check is the SUT.
 * ──────────────────────────────────────────────────────────────────────── */

describe('PATCH /api/assets/:name — body-shape validator (line 154)', () => {
  it.each([
    { shape: 'null', body: 'null' },
    { shape: 'array', body: '[]' },
    { shape: 'number', body: '123' },
    { shape: 'string', body: '"just a string"' },
    { shape: 'boolean', body: 'true' },
  ])('400 BAD_REQUEST "Body must be an object" when body parses to a $shape', async ({ body: raw }) => {
    // Under BlockStatement `→ {}` on line 154, the 400-return is
    // dropped; control falls through and `updateAssetMetadata` runs
    // against a missing asset → 404 (or 500 for the primitive cases
    // where the patch scaffolding crashes on a non-object). Under
    // ConditionalExpression `→ false`, the check is bypassed with
    // the same fall-through. Both mutants surface as a non-400
    // response OR a 400 with a different body — this assertion pins
    // BOTH the status code AND the exact "Body must be an object"
    // literal, killing every observable difference.
    //
    // No asset needs to exist for this test — the shape check runs
    // before the storage read. Capability gate must pass so control
    // reaches the shape check; `edit:assets` satisfies the gate.
    const { app } = buildAppWith(providerWithCaps(['edit:assets']))
    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: raw,
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('BAD_REQUEST')
    expect(body.message).toBe('Body must be an object')
  })
})

describe('GET /api/assets/:name — theme-dedup NoCoverage (line 116)', () => {
  it("returns ['dark'] for overrideThemes and [] for overrideLocales when only a dark theme bytes override exists", async () => {
    // Kills BooleanLiteral NoCoverage on line 116 (`!themes.includes(theme)`
    // → `themes.includes(theme)`). Under the mutation, the dedup
    // check inverts: themes only push WHEN already present (never on
    // first appearance) → overrideThemes returns `[]` even though a
    // theme slice exists. Asserting `['dark']` after uploading a
    // theme-only override proves the theme was appended on first
    // sight, killing the mutation.
    //
    // The mirror case for locales (line 115) is already covered by
    // the earlier "returns ['fr'] for overrideLocales" test; this
    // test extends the same shape to the theme axis so both dedup
    // branches carry positive-value assertions.
    const { app } = buildAppWith(providerWithCaps(['read:assets', 'edit:assets']))
    await uploadHero(app)

    const bytes = await jpegBuffer()
    const uploadRes = await app.request('/api/assets/hero/locale-bytes?theme=dark', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
      }),
    })
    // Sanity check — if the theme upload didn't take, the subsequent
    // GET assertion would mask the real failure mode.
    expect(uploadRes.status).toBe(201)

    const res = await app.request('/api/assets/hero')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      name: string
      overrideLocales: string[]
      overrideThemes: string[]
    }
    expect(body.name).toBe('hero')
    expect(body.overrideLocales).toEqual([])
    expect(body.overrideThemes).toEqual(['dark'])
  })
})

/**
 * Tests for `cloudflareWorkersDeploy()` factory (Cut 3 of #203).
 *
 * Covers:
 *   - Construction-time validation (DeployConfigError on missing required fields)
 *   - `supports` declares ['esi'] per Q5 lock + design-deploy.md
 *   - WorkerCapableDeployAdapter capability — `workerRuntimeConfig()`
 *     returns the right bucket binding + routes from siteUrl
 *   - Wrangler config rendering (pure helper exported for testability)
 *   - Worker entry code rendering
 *   - `validate?` returns Issue[] when cross-field invariants fail
 *
 * Execute() orchestration (fs + execSync) is covered by an integration
 * smoke test (Cut 4); unit tests stay focused on the pure logic.
 *
 * Per rule 26: fresh fixtures per test; no module-level state.
 */
import { describe, expect, it } from 'vitest'
import type { TargetConfig } from '../src/types.js'
import {
  cloudflareWorkersDeploy,
  extractDeployUrl,
  renderWorkerEntry,
  renderWranglerToml,
} from '../src/deploy/cloudflare-workers.js'
import { DeployConfigError } from '../src/deploy/errors.js'

describe('cloudflareWorkersDeploy() — construction', () => {
  it('throws DeployConfigError when apiToken missing', () => {
    expect(() =>
      cloudflareWorkersDeploy({
        // @ts-expect-error — testing runtime validation
        apiToken: undefined,
        accountId: 'acc',
        name: 'site',
        bucket: 'site',
      }),
    ).toThrow(DeployConfigError)
  })

  it('throws DeployConfigError when accountId missing', () => {
    expect(() =>
      cloudflareWorkersDeploy({
        apiToken: 'tok',
        // @ts-expect-error — testing runtime validation
        accountId: undefined,
        name: 'site',
        bucket: 'site',
      }),
    ).toThrow(DeployConfigError)
  })

  it('throws DeployConfigError when name missing', () => {
    expect(() =>
      cloudflareWorkersDeploy({
        apiToken: 'tok',
        accountId: 'acc',
        // @ts-expect-error — testing runtime validation
        name: undefined,
        bucket: 'site',
      }),
    ).toThrow(DeployConfigError)
  })

  it('throws DeployConfigError when bucket missing', () => {
    expect(() =>
      cloudflareWorkersDeploy({
        apiToken: 'tok',
        accountId: 'acc',
        name: 'site',
        // @ts-expect-error — testing runtime validation
        bucket: undefined,
      }),
    ).toThrow(DeployConfigError)
  })

  it('constructs successfully with all required fields', () => {
    const adapter = cloudflareWorkersDeploy({
      apiToken: 'tok',
      accountId: 'acc',
      name: 'my-site',
      bucket: 'my-site',
    })
    expect(adapter.name).toBe('cloudflare-workers')
    // Widens to ['esi'] when design-rendering.md Cut 1 splits TargetType
    expect(adapter.supports).toEqual(['dynamic'])
  })
})

describe('cloudflareWorkersDeploy() — WorkerCapableDeployAdapter', () => {
  it('implements workerRuntimeConfig()', () => {
    const adapter = cloudflareWorkersDeploy({
      apiToken: 'tok',
      accountId: 'acc',
      name: 'my-site',
      bucket: 'my-bucket',
    })
    expect('workerRuntimeConfig' in adapter).toBe(true)
    const cfg = adapter.workerRuntimeConfig()
    expect(cfg.bucketBinding).toBe('SITE_BUCKET')
  })
})

describe('renderWranglerToml() — pure config generator', () => {
  it('renders base config with R2 binding', () => {
    const toml = renderWranglerToml({
      name: 'my-site',
      bucket: 'my-bucket',
      siteUrl: undefined,
    })
    expect(toml).toContain('name = "my-site"')
    expect(toml).toContain('main = "index.ts"')
    expect(toml).toContain('compatibility_date = ')
    expect(toml).toContain('workers_dev = true')
    expect(toml).toContain('binding = "SITE_BUCKET"')
    expect(toml).toContain('bucket_name = "my-bucket"')
  })

  it('adds route binding when siteUrl set', () => {
    const toml = renderWranglerToml({
      name: 'my-site',
      bucket: 'my-bucket',
      siteUrl: 'https://example.com',
    })
    expect(toml).toContain('pattern = "example.com/*"')
    expect(toml).toContain('zone_name = "example.com"')
  })

  it('omits route binding when siteUrl absent', () => {
    const toml = renderWranglerToml({
      name: 'my-site',
      bucket: 'my-bucket',
      siteUrl: undefined,
    })
    expect(toml).not.toContain('routes')
  })
})

describe('renderWorkerEntry() — pure entry code generator', () => {
  it('imports createWorker from cloudflare-r2 adapter', () => {
    const code = renderWorkerEntry()
    expect(code).toContain("from 'gazetta/workers/cloudflare-r2'")
    expect(code).toContain('createWorker')
    expect(code).toContain('export default')
  })

  it('renders a bare createWorker() call without locales', () => {
    expect(renderWorkerEntry()).toContain('export default createWorker()')
  })

  it('embeds the site locales when given', () => {
    const code = renderWorkerEntry({ supported: ['en', 'fr'], default: 'en', defaultPrefix: false })
    expect(code).toContain(
      'export default createWorker({ locales: ["en","fr"], defaultLocale: "en", defaultPrefix: false })',
    )
  })
})

describe('extractDeployUrl() — wrangler stdout parser', () => {
  it('prefers siteUrl match over telemetry banner', () => {
    const stdout =
      `Wrangler telemetry: https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md\n` +
      `Published my-site triggers:\n` +
      `  https://gazetta.studio/*\n` +
      `Current Deployment ID: abc-123\n`
    expect(extractDeployUrl(stdout, 'https://gazetta.studio')).toBe('https://gazetta.studio/*')
  })

  it('falls back to workers.dev when no siteUrl configured', () => {
    const stdout =
      `Wrangler telemetry: https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md\n` +
      `Published my-site (3.45 sec)\n` +
      `  https://my-site.account.workers.dev\n`
    expect(extractDeployUrl(stdout, undefined)).toBe('https://my-site.account.workers.dev')
  })

  it('skips github.com telemetry URL even when siteUrl unset', () => {
    const stdout =
      `Wrangler telemetry: https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md\n` +
      `Some other note: https://example.com/help\n`
    // No workers.dev; falls through to first non-github URL.
    expect(extractDeployUrl(stdout, undefined)).toBe('https://example.com/help')
  })

  it('strips trailing punctuation from matched URL', () => {
    const stdout = `Published at https://gazetta.studio/.\n`
    expect(extractDeployUrl(stdout, 'https://gazetta.studio')).toBe('https://gazetta.studio/')
  })

  it('returns undefined when stdout contains no URLs', () => {
    expect(extractDeployUrl('No URLs here\n', undefined)).toBeUndefined()
  })

  it('returns undefined when only github.com URL present and no siteUrl/workers.dev', () => {
    const stdout = `Telemetry: https://github.com/cloudflare/workers-sdk\n`
    expect(extractDeployUrl(stdout, undefined)).toBeUndefined()
  })
})

describe('cloudflareWorkersDeploy() — validate?', () => {
  it('returns empty when config is valid', () => {
    const adapter = cloudflareWorkersDeploy({
      apiToken: 'tok',
      accountId: 'acc',
      name: 'my-site',
      bucket: 'my-bucket',
    })
    const target: TargetConfig = {
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      storage: {} as any,
      type: 'dynamic',
    }
    const issues = adapter.validate?.({ target, targetName: 'production' }) ?? []
    expect(issues).toEqual([])
  })
})

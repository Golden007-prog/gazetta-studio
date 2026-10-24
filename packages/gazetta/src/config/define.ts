/**
 * Typed identity functions for site.config.ts and gazetta.config.ts.
 *
 * Per ADR-0005 + design-config.md: returns the input unchanged but
 * provides TS inference for IDE autocomplete via generic constraint.
 *
 * The `<const T>` modifier (TS 5.0+) preserves literal types so
 * fields like `environment: 'production'` infer as the literal
 * `'production'`, not widened to `string`. Without it, downstream
 * type narrowing (e.g., `if (target.environment === 'production')`)
 * would fail to discriminate.
 *
 * Pattern matches Sanity / Astro / Vite / Vitest's `defineConfig` —
 * familiar to operators coming from adjacent tooling.
 *
 * Constraint widened from the Zod-inferred user-input shape
 * (`SiteConfig`/`GazettaConfig`, formerly public) to the runtime
 * manifest shape (`SiteManifest`/`GazettaManifest`) per the Path X
 * migration. The user-input vs. runtime distinction collapsed when
 * provider fields became factory-call instances at config-eval time
 * — there's no longer a separate "loose" input shape worth aliasing.
 *
 * Runtime Zod validation runs separately in the loader; identity
 * functions here are zero-cost at runtime.
 */

import type { GazettaManifest, SiteManifest } from '../types.js'

/**
 * Define a site's configuration. Returns the input unchanged.
 *
 * @example
 * ```ts
 * import { defineSite, filesystemStorage, anthropicProvider } from 'gazetta'
 *
 * export default defineSite({
 *   name: 'main',
 *   locales: { default: 'en', supported: ['en', 'fr'] },
 *   ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }) },
 *   targets: {
 *     local: { storage: filesystemStorage(), editable: true },
 *   },
 * })
 * ```
 */
export function defineSite<const T extends SiteManifest>(config: T): T {
  return config
}

/**
 * Define project-level Gazetta configuration. Returns the input unchanged.
 *
 * @example
 * ```ts
 * import { defineGazetta, memoryCache } from 'gazetta'
 *
 * export default defineGazetta({
 *   logLevel: 'info',
 *   defaults: {
 *     cache: memoryCache({ maxEntries: 5000 }),
 *   },
 * })
 * ```
 */
export function defineGazetta<const T extends GazettaManifest>(config: T): T {
  return config
}

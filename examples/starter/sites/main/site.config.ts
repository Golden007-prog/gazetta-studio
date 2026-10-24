import { defineSite, filesystemStorage, azureBlobStorage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Starter',
  version: '1.0.0',
  locales: {
    default: 'en',
    supported: ['en', 'fr', 'ar', 'ja'],
  },
  systemPages: ['404'],

  // AI integration (optional). Uncomment to enable AI-powered alt-text
  // generation. Provider credentials live in `.env.local` (gitignored)
  // — never in this file. See docs/content-assets.md for setup.
  //
  // ai: {
  //   provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  //   model: 'claude-haiku-4-5',      // optional; falls back to per-provider default
  // },
  //
  // altText: {
  //   systemPrompt: 'descriptive, screen-reader-friendly',  // optional voice override
  //   maxTokens: 300,                                       // optional generation cap
  // },

  // Audit log (optional). Audit is on by default with sensible
  // privacy defaults — events stored in each target's
  // `.gazetta/audit/events-{instance}.jsonl`. See docs/audit.md for
  // the full reference: privacy modes, retention windows,
  // capability gating, deployment patterns.
  //
  // admin: {
  //   audit: {
  //     // strict: false,            // default — fail-open. true = block writes on audit failure (HIPAA / SOC 2)
  //     // actorPseudonym: 'none',   // 'none' | 'sha256' (requires GAZETTA_AUDIT_ACTOR_SALT env var)
  //     // recordSourceIp: 'none',   // 'none' | 'raw' | 'hashed' | 'truncated'
  //     // recordUserAgent: 'none',  // 'none' | 'raw' | 'truncated'
  //     // retention: { events: 10000, maxAgeMonths: 12 },  // optional caps
  //   },
  // },

  // Lifecycle hooks (optional). Hooks run code at well-defined
  // moments in the save / publish / upload lifecycle. Same shape
  // for site-local code (operator's own .ts file) and
  // npm-distributed plugins. See docs/hooks.md.
  //
  // import { autoSlugify } from '../../admin/hooks/auto-slugify'
  // import cdnPurge from '@example/cdn-purge'
  //
  // admin: {
  //   hooks: [
  //     autoSlugify(),
  //     cdnPurge({ zone: process.env.CF_ZONE!, apiToken: process.env.CF_TOKEN! }),
  //   ],
  // },

  // Plain-static targets (no worker, no `redirects.format`) can't emit
  // 301/410 for archived pages — visitors hit the host's natural 404
  // instead. To close the gap on Cloudflare Pages or Netlify, add
  // `redirects: { format: 'cloudflare' | 'netlify' }` to the target.
  // See docs/runtime-capabilities.md for the per-target matrix.
  targets: {
    local: {
      // Relative paths are anchored to this config file's directory
      // (./targets/local resolves under sites/main/targets/local).
      storage: filesystemStorage({ path: './targets/local' }),
      // The editing target: keeps history, so its storage must be private.
      publicStorage: false,
      // environment: 'local' (default)
      // editable: true (default for a private local target)
    },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      // Served by `gazetta serve`, which never serves `.gazetta/`, so history stays private.
      publicStorage: false,
      environment: 'staging',
    },
    'esi-test': {
      storage: filesystemStorage({ path: './dist/esi-test' }),
      // Served by `gazetta serve`, which never serves `.gazetta/`, so history stays private.
      publicStorage: false,
      type: 'dynamic',
      environment: 'staging',
    },
    production: {
      storage: azureBlobStorage({
        connectionString: 'UseDevelopmentStorage=true',
        container: 'gazetta-production',
      }),
      // Local Azurite emulator: visitors can't reach it, so history stays.
      publicStorage: false,
      environment: 'production',
      // Uncomment to require explicit click-to-suggest on production
      // (review-first workflow). Behavior fields live at the root of altText:
      // altText: { auto: false },
    },
  },
})

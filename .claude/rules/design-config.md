---
paths:
  - "**/site.config.ts"
  - "**/gazetta.config.ts"
  - "packages/gazetta/src/config/**"
---

# Site config — reference

Operator-facing config format for Gazetta. **Reference doc, not a foundational dimension.** Captures the patterns operators and plugin authors need; the format is set once via [`docs/adr/0005-typescript-config-format.md`](../../docs/adr/0005-typescript-config-format.md).

**Status**: design pass complete (2026-05); implementation shipped 2026-05 ([`design-config-implementation.md`](design-config-implementation.md)).

**Companion docs**:
- [`docs/adr/0005-typescript-config-format.md`](../../docs/adr/0005-typescript-config-format.md) — the load-bearing decision (TS over YAML, identity functions, global + site split)
- [`design-plugins.md`](design-plugins.md) — plugins compose with config; plugin authors export factory functions invoked inside `defineSite()`
- [`design-auth-rbac.md`](design-auth-rbac.md), [`design-audit.md`](design-audit.md), and others — every design doc with config examples will be swept to TS in the implementation PR

## Why this is reference, not foundational

Foundational dimensions are recurring concerns — every new feature design must answer how it composes with them. Config format is set once: the choice of TS over YAML doesn't recur in feature designs. Once made, it's fixed.

But there ARE ongoing config-related concerns operators and plugin authors need: file layout, evaluation timing, secrets handling, validation. Those go here.

## File layout

Two files, both optional except where noted:

```
my-project/
  gazetta.config.ts             # global, optional
  sites/
    main/
      site.config.ts            # per-site, required (sites without it don't exist)
      pages/
      fragments/
    blog/
      site.config.ts
      pages/
```

For flat (simple) projects without `sites/`:

```
my-project/
  gazetta.config.ts             # optional
  site.config.ts                # the one site
  pages/
  fragments/
```

**Discovery rules**:
- If `sites/` directory exists → walk it; each subdirectory with `site.config.ts` is a site
- Otherwise → look for `site.config.ts` at project root
- `gazetta.config.ts` discovered at project root regardless of layout

## File shape

Both configs use typed identity functions. The functions return their input unchanged but provide TS inference for IDE autocomplete:

```ts
// In gazetta package
export function defineGazetta<T extends GazettaConfig>(config: T): T {
  return config
}

export function defineSite<T extends SiteConfig>(config: T): T {
  return config
}
```

### `gazetta.config.ts` — global

Carries project-level concerns shared across sites:

```ts
import { defineGazetta } from 'gazetta'

export default defineGazetta({
  logLevel: 'info',
  telemetry: false,
  dev: {
    port: 3000,
    hostname: 'localhost',
  },
  defaults: {
    // Sites inherit unless overridden. `cache` is a factory result
    // (Path X — see ADR-0008); each gazetta process re-evaluates this
    // config and gets a fresh instance.
    cache: memoryCache({ maxEntries: 5000 }),
    audit: { provider: 'history' },
  },
  mcp: {
    enabled: true,
    port: 3100,
  },
})
```

Fields belonging to global config:
- `logLevel` — admin log verbosity
- `telemetry` — opt-in/out of usage telemetry
- `dev` — dev server port + hostname
- `defaults` — site-config defaults (cache provider, audit provider, etc.)
- `mcp` — MCP server settings (single MCP server per project)

### `site.config.ts` — per-site

Carries per-site concerns:

```ts
import { defineSite, filesystemStorage, r2Storage } from 'gazetta'
import { slackHook } from '@example/slack-notify'
import autoSlugify from './admin/hooks/auto-slugify'

export default defineSite({
  name: 'main',
  locales: { default: 'en', supported: ['en'] },
  themes: {
    supported: ['light', 'dark'],
    default: 'light',
  },
  targets: {
    local: {
      type: 'esi',
      storage: filesystemStorage({ path: './dist/local' }),
    },
    production: {
      type: 'esi',
      storage: r2Storage({ bucket: process.env.R2_BUCKET! }),
    },
  },
  admin: {
    auth: {
      trust: 'cloudflare-access',
      roleMapping: {
        claim: 'groups',
        map: { 'gazetta-admins': 'admin', 'gazetta-editors': 'editor' },
      },
    },
    // Factory contributions per surface (ADR-0009); no file discovery (design-hooks.md)
    hooks: [autoSlugify(), slackHook({ webhookUrl: process.env.SLACK_WEBHOOK_URL! })],
  },
})
```

Fields belonging to site config: see existing dimension design docs (`design-i18n.md`, `design-themes.md`, `design-auth-rbac.md`, `design-audit.md`, `design-hooks.md`, `design-rendering.md`, `design-media.md`, `design-validation.md`).

### Defaults flow

`gazetta.config.ts` `defaults` field provides values that `site.config.ts` inherits per-field. Site config overrides per-field. **No deep merge for arrays** (`admin.hooks`, `admin.validators`, `admin.routes`): arrays are explicit per site; different sites may want different contributions, so no inheritance.

Defaults are factory results (constructed instances), not raw config data — Path X applies uniformly. Per the **single-Site-per-process invariant** (locked in `CONTEXT.md`), each Gazetta process loads exactly one Site, so the gazetta-level instance is inherited by the Site directly. No per-Site-instance reconstruction is needed because each process has its own evaluation of `gazetta.config.ts` and its own runtime memory.

```ts
// gazetta.config.ts
import { defineGazetta, memoryCache } from 'gazetta'

export default defineGazetta({
  defaults: {
    cache: memoryCache({ maxEntries: 5000 }),  // factory result
    audit: { provider: 'history' },             // (audit foundation hasn't migrated to Path X yet)
  },
})

// sites/main/site.config.ts — inherits cache instance; overrides audit
export default defineSite({
  name: 'main',
  // cache is unspecified → inherits the gazetta-level memoryCache instance
  admin: {
    audit: { providers: ['history', 'cloudwatch'] },  // overrides default
  },
})
```

## Evaluation timing

| Environment | Behavior |
|---|---|
| Production (`NODE_ENV !== 'development'`) | Load once at boot; restart to apply changes |
| Dev (`NODE_ENV === 'development'`, `gazetta dev`) | File watcher on `gazetta.config.ts` + `sites/*/site.config.ts`; reload on save |

**Dev reload and plugins**: there is no plugin runtime, so nothing has an `init`/`dispose` lifecycle. A reload re-evaluates the config ([#1353](https://github.com/gazetta-studio/gazetta-studio/issues/1353)); which config-built state it rebuilds, including the `admin.hooks`/`admin.validators`/`admin.routes` contributions, is not decided here; [`design-plugins.md`](design-plugins.md) lists plugin hot-reload as out of scope (admin restart) under Future directions.

Follows from ADR-0009 (no lifecycle) and #1353, decided 2026-10-24 (reload on save).

Production never reloads; a process restart releases everything.

**Validation runs on every load** (boot OR reload):
- TS types catch shape errors at edit time
- Zod schema catches env-var-driven errors and shape errors not expressible in TS at load time
- Defense in depth

**Build-time JSON precompile** (v1.5 reserved):

```bash
gazetta build:config    # produces .gazetta/built-config.json from site.config.ts
```

Production loads JSON if present; falls back to evaluating TS if absent. Lower cold-start latency for cloud deployments. Not v1 critical.

## Secrets handling

Per Universal Provider Requirement #3 (`design-plugins.md`): credentials never appear in config files. The TS-config posture preserves this.

**Convention**: `process.env.X` directly inside `defineSite()`, passed into the factory call:

```ts
storage: r2Storage({ bucket: process.env.R2_BUCKET! }),
```

The non-null assertion (`!`) is operator's promise that the env var is defined. Missing env var → first-use error (clear failure). Operators wanting earlier failure can throw explicitly:

```ts
const requireEnv = (name: string) => {
  const v = process.env[name]
  if (!v) throw new Error(`Required env var: ${name}`)
  return v
}

storage: r2Storage({ bucket: requireEnv('R2_BUCKET') }),
```

No Gazetta-specific env wrapper. `process.env.X` is universal Node syntax with no learning curve.

**Env var naming**:
- Provider SDK conventions preserved: `AWS_REGION`, `AZURE_STORAGE_KEY`, `R2_BUCKET`, `ANTHROPIC_API_KEY`
- Gazetta-specific: `GAZETTA_AUDIT_ACTOR_SALT`, `GAZETTA_AUDIT_SOURCEIP_SALT`, `GAZETTA_AUDIT_WEBHOOK_AUTH`
- Plugin-specific: `GAZETTA_<PLUGIN_NAME>_<FIELD>` (plugin author's convention)

**`.env.local` discovery** (preserved from existing convention):

dotenv loaded at boot, before config evaluation. Precedence:

1. `.env.local` (gitignored)
2. `.env.{NODE_ENV}.local`
3. `.env.{NODE_ENV}`
4. `.env`

**Inline-secret detection deferred** to existing tools (gitleaks, git-secrets, pre-commit hooks). Gazetta doesn't add a custom scanner.

## Multi-instance discipline

- Both `gazetta.config.ts` and `site.config.ts` live in the source tree, deployed identically to every instance
- Each instance reads at boot from its local filesystem
- No coordination needed; same files = same config across all instances
- Salt env vars (per `design-audit.md`) read from env per-instance; deterministic across instances by sharing env values

## Migration from `site.yaml`

The implementation PR (Tier 3) ships:

```bash
gazetta migrate-config    # converts site.yaml → site.config.ts
```

Operator runs once per site. Generated TS preserves comments via TS comments; preserves env-var references via `process.env.X`; converts the rest 1:1.

**Hard cutover**: when implementation PR lands, YAML support is removed in the same commit. CHANGELOG entry: "Breaking: site.yaml → site.config.ts. Run `gazetta migrate-config` to convert."

## Plugin authoring

There is no plugin runtime ([ADR-0009](../../docs/adr/0009-no-plugin-runtime-factory-contributions.md)): a package exports one factory per extension surface, and the operator invokes each in the right typed array, inline in `defineSite()`:

```ts
import autoSlugify from './admin/hooks/auto-slugify'
import { slackHook, slackRoute } from '@example/slack-notify'
import linkChecker from '@example/link-checker'

export default defineSite({
  admin: {
    hooks:      [autoSlugify(), slackHook({ webhookUrl: process.env.SLACK_WEBHOOK_URL! })],
    validators: [linkChecker({ excludePatterns: [/* ... */] })],
    routes:     [slackRoute({ webhookUrl: process.env.SLACK_WEBHOOK_URL! })],
  },
})
```

Callbacks-as-config is the motivating advantage of TS over YAML. The contribution shapes (`HookContribution`, `Validator`, `RouteContribution`) are in ADR-0009 and [`design-plugins.md`](design-plugins.md).

Follows from ADR-0009.

## Future directions

- **Build-time JSON precompile** (v1.5) — reduce cold-start latency on cloud deployments
- **Config schema extraction CLI** (`gazetta config schema`) — emit JSON Schema for the config format; useful for tooling integration
- **Per-target config overrides** — e.g., production target uses different plugins than staging — currently handled via `if (target === 'production')` branches inline; explicit per-target syntax could ship if patterns recur
- **Visual config editor in admin UI** — operator edits `site.config.ts` via UI form, output is TS code (matches the visual hook editor reservation in `design-hooks.md`)

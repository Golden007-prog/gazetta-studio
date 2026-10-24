# Hooks

Hooks let you run code at well-defined moments in the save / publish / upload lifecycle: auto-slugify a page on save, send a Slack message after a publish, validate an asset against an external service before upload, copy uploaded bytes to a backup bucket. Same shape whether you write the hook yourself in your project or install one as an npm package.

Hooks are **opt-in**. Sites without `admin.hooks` configured pay zero overhead.

## How it works

You write (or import) a factory function that returns a `HookContribution`. You call the factory inside `site.config.ts`'s `admin.hooks` array. The admin reads the array at boot, registers every handler, and fires them at the matching lifecycle moments.

```ts
import { defineSite, filesystemStorage } from 'gazetta'
import { autoSlugify } from './admin/hooks/auto-slugify'

export default defineSite({
  name: 'My Site',
  targets: { local: { storage: filesystemStorage({ path: './targets/local' }), editable: true } },
  admin: {
    hooks: [autoSlugify()],
  },
})
```

That's the whole pattern. Site-local code, npm packages — both produce a `HookContribution`; both wire identically.

## Lifecycle phases

Seven content / publish / upload phases ship in v1, plus ten review-lifecycle phases reserved for the review-workflow feature. Every phase has a `before*` (mutating; can cancel) and `after*` (observational) variant.

| Phase             | Fires when                                          | Mutating? |
| ----------------- | --------------------------------------------------- | --------- |
| `beforeSave`      | A page / fragment manifest is about to be written   | Yes       |
| `afterSave`       | After the manifest landed in storage                | No        |
| `afterLoad`       | After a manifest is read back (read-time enrichment)| Yes       |
| `beforePublish`   | A publish is about to start                         | Yes       |
| `afterPublish`    | After a publish completes                           | No        |
| `beforeUpload`    | An asset is about to be written (after sanitization)| Yes       |
| `afterUpload`     | After an asset and its manifest land in storage     | No        |

`before*` hooks return the (possibly mutated) payload. Throwing from a `before*` hook **cancels** the operation — the audit log records the cancellation, and the user sees the failure. `after*` hooks return `void`; their failures log but never propagate to the caller.

## Writing a site-local hook

A hook is a function that returns a `HookContribution`. The contribution carries a `source` (used for audit / diagnostics) and one or more `hooks` entries:

```ts
// admin/hooks/auto-slugify.ts
import type { HookContribution } from 'gazetta'

export function autoSlugify(): HookContribution {
  return {
    source: 'site-local:auto-slugify',
    hooks: [
      {
        phase: 'beforeSave',
        handler: async (scope, payload, _ctx) => {
          if (scope.kind !== 'page') return payload
          const p = payload as { metadata?: { slug?: string; title?: string } }
          if (p.metadata?.slug) return payload
          const title = p.metadata?.title ?? ''
          return {
            ...p,
            metadata: { ...(p.metadata ?? {}), slug: slugify(title) },
          }
        },
        options: { name: 'auto-slugify' },
      },
    ],
  }
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
```

Wire it in:

```ts
import { defineSite } from 'gazetta'
import { autoSlugify } from './admin/hooks/auto-slugify'

export default defineSite({
  // ...
  admin: { hooks: [autoSlugify()] },
})
```

The file path is your choice — the system imports nothing automatically. `admin/hooks/` is a convention, not a requirement.

## Installing an npm-distributed hook

Same shape. The package exports a factory; you import it and invoke it:

```ts
import { defineSite } from 'gazetta'
import cdnPurge from '@example/cdn-purge'

export default defineSite({
  // ...
  admin: {
    hooks: [
      cdnPurge({
        zone: process.env.CF_ZONE!,
        apiToken: process.env.CF_TOKEN!,
      }),
    ],
  },
})
```

Plugin packages may contribute multiple handlers in one contribution — a CDN-purge plugin, for example, typically wires both `afterSave` (purge one item) and `afterPublish` (bulk-purge published items) in the same contribution so they share closure state.

## Handler context

Every handler receives a `HookContext`:

```ts
interface HookContext {
  principal: Principal              // who triggered the operation
  target: TargetName                // active target name
  requestId: string                 // correlates with audit log + logs
  now: Date                         // request timestamp (deterministic across hooks in this request)
  log: HookLogger                   // scoped logger
  site: SiteConfig                  // read-only site config
  storage: ReadOnlyStorageProvider  // read-only storage handle
}
```

Hooks can **read** from storage but cannot **write** to it. Writes happen via the operation that fired the hook — mutate the returned payload from a `before*` hook and the operation persists it.

## Composition

Multiple handlers for the same phase compose by **priority**:

| Band       | Reserved for                  |
| ---------- | ----------------------------- |
| 0–99       | Built-in Gazetta hooks        |
| 100–999    | Plugin-supplied hooks (default) |
| 1000+      | Site-local hooks (convention) |

Lower priority runs first. Same priority falls back to registration order (stable). Set explicit priority via `options.priority` on a `HookEntry`:

```ts
{
  phase: 'beforeSave',
  handler: ...,
  options: { name: 'auto-slugify', priority: 1000 },  // run last (after plugins)
}
```

`before*` hooks **chain**: the output of hook N is the input of hook N+1. The final output proceeds to the operation. `after*` hooks run independently — each receives the operation's result; one failing doesn't stop the others.

## Per-handler timeout

Each handler has a default 5-second timeout. Override per-entry:

```ts
options: { name: 'slow-enrichment', timeout: 30000 }   // 30 seconds
```

A `before*` timeout cancels the operation (same as a thrown error). An `after*` timeout logs and the operation result still returns to the caller.

## Audit metadata

Every hook firing records an audit event with `action: 'hook-fired'` and `outcome: 'success' | 'hook-cancelled' | 'failed-render' | 'timeout'`. Metadata includes `hookName`, `hookPhase`, `hookPriority`, `durationMs`, and `source` — see [audit.md](audit.md) for the audit log shape.

## Trust posture

Site-local hooks **are** your code; npm packages run with full Node access. Vet packages before installing. Hooks run with the triggering principal's capabilities by default — they don't gain elevated access.

## Two registrations of the same package

Want two CDN-purge instances pointing at different zones? Invoke the factory twice with different config:

```ts
admin: {
  hooks: [
    cdnPurge({ zone: 'cdn-us.example.com', apiToken: process.env.CF_TOKEN_US! }),
    cdnPurge({ zone: 'cdn-eu.example.com', apiToken: process.env.CF_TOKEN_EU! }),
  ],
}
```

Both register; both fire on every matching event. Audit records both events with the same `source`. Use distinct `options.name` (`'cdn-purge-us'`, `'cdn-purge-eu'`) to tell them apart in audit + diagnostics.

## What's deferred

- **`disable: [...]` block** — v1 disable = remove the contribution from the array. Future ergonomic.
- **Hot-reload of hook files** — v1 changes require admin restart.
- **Render-lifecycle hooks** (`beforeRender`, `afterRender`) — reserved per the rendering design pass.
- **Validation hooks** — permanently rejected (validators are pure functions; not hooks-in-disguise).
- **Fire-and-forget mode** — v1 hooks are sync-blocking with a per-handler timeout cap.

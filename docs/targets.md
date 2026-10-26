# Targets

A target is one place your site lives: a **storage** config (where content files go) and an optional **deploy** adapter (how the platform serves them — see [`deploy.md`](./deploy.md) for the full reference). `gazetta publish` renders content from the editing target into any other target, and each target keeps its own history.

`gazetta init` creates two filesystem targets — `local` (the editing target) and `staging` (served with `npx gazetta serve staging`) — so publishing works with no accounts. To put the site online, follow the [Cloudflare deployment guide](./cloudflare.md) or the [self-hosted deployment guide](./self-hosted.md).

## Storage factories

| Storage factory | Use case | Required config |
|------|----------|--------|
| `r2Storage()` | Cloudflare R2 | `accountId`, `bucket`, `accessKeyId`, `secretAccessKey` |
| `s3Storage()` | AWS S3, MinIO | `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey` |
| `filesystemStorage()` | Local dev, staging, backups | none — `path` defaults to `./targets/local` |
| `azureBlobStorage()` | Azure Blob Storage | `connectionString`, `container` |

`r2Storage` and `s3Storage` also take an optional `region` (R2 defaults to `auto`). For the Azurite emulator, pass `connectionString: 'UseDevelopmentStorage=true'`.

A filesystem `path` is relative to the folder that holds `site.config.ts`: `./dist/staging` resolves to `sites/main/dist/staging/`, not the project root.

R2 and S3 need `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage`; Azure needs `npm install @azure/storage-blob`. These are optional peer dependencies, so you install only what your storage needs.

## Deploy adapters

| Deploy adapter | Use case |
|-------------|----------|
| `cloudflareWorkersDeploy` | Cloudflare Workers — ESI assembly at the edge |
| (none) | No platform deploy — just publish content to storage (container hosts use platform CLIs; see [#213](https://github.com/gazetta-studio/gazetta-studio/issues/213)) |

## `type`

Each target renders in one of two modes. An explicit `type` wins; the default is `dynamic` only when the deploy adapter bundles a worker.

**`dynamic`:**

- Pages have ESI placeholders for fragments
- Fragments are stored separately: a fragment edit shows on every page at request time, and a publish re-renders the fragment itself (and only pages that nest it inside an inline component)
- Hashed CSS/JS files with immutable caching
- A worker assembles pages at request time (`gazetta serve` assembles the same ESI for a `dynamic` target without a worker)

**`static`:**

- Pages are fully assembled — fragments baked in
- One self-contained HTML file per page
- CSS/JS inline — no external files
- A publish re-renders only the pages that use a changed fragment

## `environment`

The optional `environment` field declares a target's intent — `local`, `staging`, or `production`. The admin UI uses it to:

- Give each destination in the publish dialog a red (`production`) or amber (`staging`) left border
- Require an explicit confirmation step before publishing to a `production` target

A target without `environment` counts as `local`, so set it on your staging and production targets.

## `editable`

Whether the admin edits content on this target. The editing source is the first editable target in declaration order, and the CLI refuses to start when no target is editable. Publish destinations don't need `editable` — a read-only target like the starter's `staging` still receives publishes.

Default: `false` unless the target's storage is private. A target counts as public until something marks it private (see `publicStorage` below), and a public target is never editable — the default resolves to `false`, and an explicit `editable: true` on public storage is a `gazetta validate` error. So a bare `local: { storage: filesystemStorage() }` is public and not editable, and with no other editable target the CLI refuses to start. Mark the target you edit: `editable: true` on a filesystem-storage target, or `publicStorage: false` as `gazetta init` does. On a private target the default is `true` for `environment: local` and `false` for `staging` and `production`.

An editable filesystem target's storage counts as private automatically — an editing target keeps history, and history must not be publicly reachable.

## `publicStorage`

Whether visitors can reach the target's storage directly — a host serving the bucket or folder as the site. A public target keeps no history, audit or review state in its storage.

When `publicStorage` is unset, a target counts as private only if it is an editable filesystem target or its deploy adapter copies site files to the host; every other target is assumed public, so a forgotten declaration never leaks history or audit data. Set `publicStorage: false` for storage only a worker reads, such as a private R2 bucket behind `cloudflareWorkersDeploy`.

`gazetta serve` never serves private files — `.gazetta/` and other dot-paths answer 404 — so a filesystem target it serves stays private.

## `history`

Per-target history powers undo and rollback. The default keeps the 50 most recent revisions; raise it with `history: { retention: 100 }` (values of 0 or less keep 1). Disable history entirely with `history: { enabled: false }` for targets where the storage cost isn't worth it, such as ephemeral CI previews. Public-storage targets keep no history.

## `siteUrl`

The target's public base URL, for example `https://example.com`. Publish uses it for the sitemap, robots.txt and locale alternate links; `gazetta deploy` derives a worker's route binding from it; and a Cloudflare cache purge auto-detects the zone from it.

## `cache`

Per target:

```ts
cache: {
  browser: 0,       // max-age — seconds before browser revalidates
  edge: 86400,      // s-maxage — seconds before edge refetches from storage
  purge: {          // optional — purge CDN cache after publish
    type: 'cloudflare',
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  },
}
```

Per page (overrides target):

```json
// pages/dashboard/page.json
{
  "cache": {
    "browser": 0
  }
}
```

`browser` and `edge` apply to `dynamic` targets only: the worker reads them from a comment in the published HTML. Static output carries no cache comment, and `gazetta serve` on a static target sends `max-age=0, must-revalidate` for pages, so static caching is up to the host.

Defaults: `browser: 0`, `edge: 86400`. Set `edge: 0` to skip CDN caching entirely (no purge needed).

ETags are automatic — browsers get `304 Not Modified` for unchanged pages.

When `cache.purge` is configured, `gazetta publish` automatically purges the CDN cache after uploading. The zone ID is auto-detected from `siteUrl`, and the token needs Zone / Cache Purge permission.

## Secrets and `.env`

The storage and deploy keys the example below uses. (Admin sign-in is separate; see [`auth.md`](./auth.md).)

R2 uses S3-compatible API tokens. Create one at [dash.cloudflare.com](https://dash.cloudflare.com)
→ R2 → Manage R2 API Tokens → Create API Token. Pick "Object Read & Write" scoped to
your bucket. The dashboard shows the access key ID and secret access key once — copy
both.

**Workers deploy:** Also create a Cloudflare API token at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
with these permissions:

| Permission | Access |
|-----------|--------|
| Account / Workers Scripts | Edit |
| Account / R2 | Edit |
| User / User Details | Read |
| User / Memberships | Read |
| Zone / Workers Routes | Edit |
| Zone / Cache Purge | Purge |
| Zone / Zone | Read |

**Environment variables:** Create a `.env` file in your site directory (gitignored) for secrets:

```
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
CLOUDFLARE_API_TOKEN=your-api-token
```

The CLI loads `.env` and `.env.local` from the project root and the site directory before reading `site.config.ts`; variables already set in the environment win. In CI, env vars are set directly — loading is skipped whenever `CI` is set to any non-empty value.

Values in site.config.ts reference env vars directly via `process.env.VAR_NAME!` — they're resolved at evaluation time.

## A complete example

```ts
// site.config.ts
import { cloudflareWorkersDeploy, defineSite, filesystemStorage, r2Storage } from 'gazetta'

export default defineSite({
  name: 'My Site',
  targets: {
    local: {
      storage: filesystemStorage(),
      editable: true,                      // the target you edit; its storage stays private
    },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      // Served by `gazetta serve`, which never serves `.gazetta/`, so history stays private.
      publicStorage: false,
      environment: 'staging',
    },
    production: {
      type: 'dynamic',
      environment: 'production',           // admin UI requires confirmation before publishing
      storage: r2Storage({
        accountId: 'your-cloudflare-account-id',
        bucket: 'my-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      // Bucket is private; only the worker serves it. Without this, R2 storage counts as public.
      publicStorage: false,
      deploy: cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: 'your-cloudflare-account-id',
        name: 'my-site',
        bucket: 'my-site',
      }),
      siteUrl: 'https://mysite.com',
      cache: {
        browser: 0,
        edge: 86400,
        purge: {
          type: 'cloudflare',
          apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        },
      },
    },
  },
})
```

## Related

- [`deploy.md`](./deploy.md) — the deploy adapter contract and container hosts
- [`cloudflare.md`](./cloudflare.md) — Cloudflare Workers + R2 setup end to end
- [`self-hosted.md`](./self-hosted.md) — VPS, Docker and Fly.io
- [`auth.md`](./auth.md) — admin sign-in, separate from storage and deploy keys

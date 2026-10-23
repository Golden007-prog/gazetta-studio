# Cloudflare Deployment

Deploy Gazetta sites to Cloudflare Workers + R2. Pages are pre-rendered and stored in R2, assembled at the edge by a Worker.

## How it works

```
gazetta publish → pre-render pages/fragments → upload to R2
                                              → purge CDN cache

Cloudflare Worker → fetch page from R2
                  → resolve fragment ESI placeholders
                  → assemble full HTML
                  → cache at edge
                  → serve to browser
```

## Setup

### 1. Create R2 bucket

```bash
npx wrangler r2 bucket create my-site
```

### 2. Configure site.config.ts

```ts
import { cloudflareWorkersDeploy, defineSite, r2Storage } from 'gazetta'

export default defineSite({
  name: 'My Site',
  targets: {
    production: {
      type: 'dynamic',
      environment: 'production',
      storage: r2Storage({
        accountId: 'your-cloudflare-account-id',
        bucket: 'my-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
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

Find your account ID in the Cloudflare dashboard URL: `dash.cloudflare.com/<account-id>`.

### 3. Build + Deploy (one time)

```bash
npx gazetta build                # build admin UI + custom editors/fields
npx gazetta deploy production    # deploy worker to Cloudflare
```

### 4. Publish content

```bash
npx gazetta publish production
```

## Authentication

This section covers **storage credentials** (R2 token) and **deploy credentials** (Worker deploy). For **admin user authentication** (Cloudflare Access protecting the admin panel) see [`auth.md`](auth.md) — the `cloudflare-access` trust mode handles JWT verification against your team's published JWKS automatically.

R2 uses S3-compatible API tokens — same path for local dev and CI.

### R2 API token (storage credentials)

Create the R2 API token at [dash.cloudflare.com](https://dash.cloudflare.com) → R2 →
Manage R2 API Tokens → Create API Token. Pick "Object Read & Write" and scope it to
your bucket. The dashboard shows the access key ID and secret access key once — copy
both into your `.env`:

```
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
```

These are read by `site.config.ts` at runtime. Same credentials work locally and in CI.

### Worker deploy token (for `gazetta deploy`)

Worker deploy needs a separate Cloudflare API token at
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

Set **Zone Resources** to your zone or "All zones".

Add it as a repository secret named `CLOUDFLARE_API_TOKEN`.

Example workflow:

```yaml
name: Deploy

on:
  push:
    branches: [main]
    paths:
      - 'sites/my-site/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: npm ci
      - run: npm run build

      - name: Publish to R2
        run: npx gazetta publish sites/my-site
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

      - name: Deploy worker
        run: cd sites/my-site/worker && npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

### Local .env file

Create a `.env` file in your site directory (gitignored automatically):

```
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
CLOUDFLARE_API_TOKEN=your-cloudflare-api-token
```

The CLI loads it automatically. Skipped when `CI=true`.

### Storage config

```ts
import { r2Storage } from 'gazetta'

storage: r2Storage({
  accountId: 'your-account-id',
  bucket: 'my-site',
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
})
```

## Cache

### Configuration

```ts
cache: {
  browser: 0,       // max-age in seconds (0 = always revalidate)
  edge: 86400,      // s-maxage in seconds (86400 = 24 hours)
  purge: {
    type: 'cloudflare',
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  },
}
```

- `browser`: How long the browser caches before revalidating. ETags are automatic.
- `edge`: How long the Cloudflare edge caches before refetching from R2.
- `purge`: Automatically purge the CDN cache after publish. Zone ID is auto-detected from `siteUrl`.

Set `edge: 0` to disable edge caching entirely (no purge needed). Pages are still fast — R2 reads are low-latency.

### Per-page cache

Override target-level cache in a page manifest:

```json
// pages/dashboard/page.json
{
  "cache": {
    "browser": 0,
    "edge": 0
  }
}
```

### Cache purge behavior

| Publish | Purge |
|---------|-------|
| Fragment changed | Purge all (fragments are shared across pages) |
| Page changed | Purge that page's URL only |
| CLI publish | Purge all at the end |

### Publish generation

Every publish writes a value unique to that publish to `.gazetta/publish-generation` on the target, after the content files and before the purge, whether or not `purge` is configured. The worker includes the generation in its edge cache keys and re-reads it at most every 5 seconds, so pages update within 5 seconds of a publish; the purge then frees the old cached copies.

## Audit log

Audit recording is on by default — every save / publish / delete / restore writes a structured event to the target's `.gazetta/audit/events-{instance}.jsonl`. With Cloudflare Workers admin instances, the per-instance file naming uses the worker's revision identity. See [`audit.md`](audit.md) for the full reference (privacy posture, retention, capability gating).

R2-backed admin processes work the same as filesystem-backed: per-instance JSONL files mean concurrent appenders never collide on object writes. The `read:audit-log` capability gates the admin drawer; built-in `editor` and `viewer` roles do NOT grant it (wildcard-exempt). Operators wanting non-admin audit access declare a custom role with `['read:*', 'read:audit-log']`.

## Worker

The worker is a thin Hono app that:

1. Receives a page request
2. Fetches the page HTML from R2 (with ESI placeholders)
3. Fetches all referenced fragments from R2 in parallel
4. Assembles the full HTML
5. Caches the result at the edge
6. Serves with ETag for conditional requests

### Customization

```ts
// worker/src/index.ts
import { createWorker } from 'gazetta/workers/cloudflare-r2'

const app = createWorker({
  middleware: (app) => {
    // www redirect
    app.use('*', async (c, next) => {
      const url = new URL(c.req.url)
      if (url.hostname.startsWith('www.')) {
        return c.redirect(`https://${url.hostname.slice(4)}${url.pathname}`, 301)
      }
      return next()
    })
  },
})

export default app
```

### wrangler.toml

```toml
name = "my-site"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[[routes]]
pattern = "mysite.com/*"
zone_name = "mysite.com"

[[routes]]                      # handle www → redirect in worker code
pattern = "www.mysite.com/*"
zone_name = "mysite.com"

[[r2_buckets]]
binding = "SITE_BUCKET"         # must match createWorker({ bucketBinding })
bucket_name = "my-site"
```

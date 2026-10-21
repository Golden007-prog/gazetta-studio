# Deploy

How to deploy Gazetta to edge platforms and static hosts.

## The model

Two commands; they're independent:

| Command | What it does |
|---|---|
| `gazetta publish <target>` | Writes content bytes to `target.storage`. Run on every content change. |
| `gazetta deploy <target>` | Configures the platform (deploys worker code, pushes to git branch, etc.). Run on initial setup + infrastructure upgrades. |

Neither command waits for the other. Adapters that need bytes read from `target.storage` themselves and surface a clear error when storage is empty.

## Configure a target's deploy adapter

```ts
import { defineSite, r2Storage, cloudflareWorkersDeploy } from 'gazetta'

export default defineSite({
  targets: {
    production: {
      type: 'dynamic',
      storage: r2Storage({
        accountId: process.env.R2_ACCOUNT_ID!,
        bucket: 'my-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      siteUrl: 'https://my-site.com',
      deploy: cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        name: 'my-site',
        bucket: 'my-site',
      }),
    },
  },
})
```

Run:

```bash
gazetta publish production    # writes content to R2
gazetta deploy production     # deploys the worker
```

## Available adapters

### `cloudflareWorkersDeploy()`

Cloudflare Workers + R2. Bundles a worker that reads content from R2 at request time.

```ts
cloudflareWorkersDeploy({
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,    // required
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,  // required
  name: 'my-site',                                 // worker name + workers.dev subdomain
  bucket: 'my-site',                               // R2 bucket name (binding: SITE_BUCKET)
})
```

Supports: `type: 'dynamic'` targets (ESI assembly at edge).

Env vars Wrangler reads at deploy time (passed through from `process.env`):
- `CLOUDFLARE_API_TOKEN` — API token with Workers Scripts:Edit + R2 Read permissions
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID

Get an API token: Cloudflare dashboard → My Profile → API Tokens → Create Token. Use the "Edit Cloudflare Workers" template; add R2 read permission to the bucket.

### Other adapters

These will ship as separate PRs after the contract lands:

| Adapter | Issue | Target types |
|---|---|---|
| `cloudflarePagesDeploy` | [#204](https://github.com/gazetta-studio/gazetta-studio/issues/204) | `static`, `dynamic` |
| `vercelEdgeDeploy` | [#206](https://github.com/gazetta-studio/gazetta-studio/issues/206) | `dynamic` |
| `netlifyStaticDeploy` | [#209](https://github.com/gazetta-studio/gazetta-studio/issues/209) | `static` |
| `cloudflarePagesStaticDeploy` | [#210](https://github.com/gazetta-studio/gazetta-studio/issues/210) | `static` |
| `netlifyEdgeDeploy` | [#207](https://github.com/gazetta-studio/gazetta-studio/issues/207) | `dynamic` |
| `denoDeployDeploy` | [#205](https://github.com/gazetta-studio/gazetta-studio/issues/205) | `dynamic` |
| `githubPagesDeploy` | [#208](https://github.com/gazetta-studio/gazetta-studio/issues/208) | `static` |
| `s3StaticDeploy` | [#211](https://github.com/gazetta-studio/gazetta-studio/issues/211) | `static` |
| `azureBlobStaticDeploy` | [#212](https://github.com/gazetta-studio/gazetta-studio/issues/212) | `static` |

Until the static adapters ship, you deploy a static target yourself by uploading its storage or pointing a static host at it. That makes the target's `.gazetta/` folder (audit log, page history) public unless you block or exclude it: see [Where Gazetta keeps its own files, and when they're public](audit.md#where-gazetta-keeps-its-own-files-and-when-theyre-public).

## Container hosts (Fly.io, Cloud Run, Railway, Render)

These platforms run `gazetta serve` inside a container. **No Gazetta deploy adapter** — use the platform's own CLI from CI or your local machine:

```bash
flyctl deploy        # Fly.io
gcloud run deploy    # Cloud Run
railway up           # Railway
render deploy        # Render
```

The Dockerfile's entrypoint is `gazetta serve`. The running container reads from `target.storage` at request time, just like a worker does. Your CI runs `gazetta publish` to write content, and the platform CLI to push the container image.

See [`container-deployment.md`](container-deployment.md) for per-platform Dockerfile + CI recipes (filed as [#213](https://github.com/gazetta-studio/gazetta-studio/issues/213)).

## Lazy adapter construction

Adapter factories validate at construction. If you want to write a site config that doesn't fail when secrets are missing (e.g., local dev), construct conditionally:

```ts
production: {
  type: 'dynamic',
  storage: r2Storage({...}),
  deploy: process.env.CLOUDFLARE_API_TOKEN
    ? cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        name: 'my-site',
        bucket: 'my-site',
      })
    : undefined,
}
```

Without `CLOUDFLARE_API_TOKEN`, the site loads but `gazetta deploy production` surfaces a clear "no deploy adapter configured" error.

## Validation

Two validators surface deploy-related issues at `gazetta validate`:

- **`deploy-target-type-supported`** (error severity) — flags target.type incompatible with adapter.supports. E.g., `type: 'dynamic'` paired with a `['static']`-only adapter.
- **`target-deploy-coverage`** (info severity) — reminds operators that non-local runtime-constrained targets without a `deploy:` field rely on container-host deploy tooling (linked to [`container-deployment.md`](container-deployment.md)).

## Error messages

| Error class | When | Operator action |
|---|---|---|
| `DeployConfigError` | Factory throws at config-eval (missing required fields, malformed env vars) | Fix the factory arguments |
| `DeployAuthError` | Adapter execute() rejects credentials at deploy time | Check API token + account ID |
| `DeployTransportError` | Network / platform SDK failure (timeout, 5xx, DNS) | Retry or investigate platform status |
| `DeployContentError` | Adapter expected published bytes but storage is empty | Run `gazetta publish <target>` first |

## Migrating from `target.worker`

Pre-Cut 3 Cloudflare configs used a `worker:` field. That field is **deleted** in Cut 3; configs no longer type-check.

**Before:**

```ts
production: {
  storage: r2Storage({...}),
  worker: {
    type: 'cloudflare',
    name: 'my-site',
    bucket: 'my-site',
  },
}
```

**After:**

```ts
production: {
  type: 'dynamic',
  storage: r2Storage({...}),
  deploy: cloudflareWorkersDeploy({
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    name: 'my-site',
    bucket: 'my-site',
  }),
}
```

New: `apiToken` + `accountId` are explicit factory args. Previously the deploy command read them from env directly; now they flow through the factory call.

## References

- [`design-deploy.md`](../.claude/rules/design-deploy.md) — durable design
- [`ADR-0010`](adr/0010-deploy-publish-independence.md) — load-bearing decisions
- [`feature-design-process.md`](../.claude/rules/feature-design-process.md) — Pattern 1 Provider surface model
- [`design-provider-config.md`](../.claude/rules/design-provider-config.md) — operator-facing factory pattern

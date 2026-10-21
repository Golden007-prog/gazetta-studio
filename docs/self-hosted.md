# Self-Hosted Deployment

Deploy Gazetta sites on your own infrastructure — VPS, Docker, Fly.io, or any Node.js host. Pages are pre-rendered and stored in your chosen storage, assembled at request time by a Node server.

## How it works

```
gazetta publish → pre-render pages/fragments → upload to storage

gazetta serve   → fetch page from storage
                → resolve fragment ESI placeholders
                → assemble full HTML
                → serve with ETag + Cache-Control
```

Same assembly logic as the [Cloudflare deployment](./cloudflare.md), but runs on Node instead of a Worker.

## Setup

### 1. Configure a target

```ts
// site.config.ts
import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: 'My Site',
  targets: {
    production: {
      environment: 'production',           // default is 'local'; opt this one into 'production' for admin UI confirmation
      storage: filesystemStorage({ path: './dist/production' }),
      siteUrl: 'https://mysite.com',
      cache: {
        browser: 0,
        edge: 86400,
      },
    },
  },
})
```

Any storage provider works (operators import the factory from `gazetta`):

| Storage | Factory call |
|---------|--------------|
| Filesystem | `filesystemStorage({ path: './dist/production' })` |
| S3 / MinIO | `s3Storage({ endpoint, bucket, accessKeyId, secretAccessKey })` |
| R2 | `r2Storage({ accountId, bucket, accessKeyId, secretAccessKey })` |
| Azure Blob | `azureBlobStorage({ connectionString, container })` |

### 2. Build + Publish

```bash
npx gazetta build              # build admin UI + bundle custom editors/fields
npx gazetta publish             # pre-render pages/fragments → upload to storage
```

### 3. Serve pages

```bash
npx gazetta serve -p 8080
```

Serves published pages from the target's storage.

### 4. Run admin CMS (optional)

```bash
npx gazetta admin -p 3001
```

Runs the production CMS admin for content editors. Requires `gazetta build` first.

For team deployments, configure upstream auth in `site.config.ts`. Common self-hosted choice is `forwarded-user` behind oauth2-proxy / Authelia / Caddy `forward_auth`:

```ts
admin: {
  auth: {
    trust: 'forwarded-user',
    trustedProxies: ['127.0.0.1', '10.0.0.0/8'], // your reverse proxy IPs
  },
}
```

See [`auth.md`](auth.md) for the full trust-mode reference (cloudflare-access, azure-easy-auth, aws-cognito, tailscale, etc.) and the role / capability vocabulary.

## Options

```bash
gazetta serve                      # first target, port 3000
gazetta serve production           # specific target
gazetta serve -p 8080              # custom port
gazetta serve staging -p 3001     # combine
```

## Cache headers

The server sets response headers based on your cache config:

```ts
cache: {
  browser: 0,       // Cache-Control: max-age=0 (browser always revalidates)
  edge: 86400,      // Cache-Control: s-maxage=86400 (CDN caches for 24h)
}
```

- **ETag** — computed from assembled HTML. Browsers get `304 Not Modified` for unchanged pages.
- **max-age** — how long the browser caches before revalidating.
- **s-maxage** — how long a reverse proxy (Nginx, Varnish, CDN) caches.

Per-page cache overrides work:

```json
// pages/dashboard/page.json
{
  "cache": {
    "browser": 0,
    "edge": 0
  }
}
```

## Audit log

Audit recording is on by default — every save / publish / delete / restore writes a structured event to the target's `.gazetta/audit/events-{instance}.jsonl`. With self-hosted admin processes, the per-instance file naming uses `os.hostname()` (Kubernetes pod name on K8s; machine hostname elsewhere). See [`audit.md`](audit.md) for the full reference.

For multi-instance self-hosted deployments (Kubernetes, multi-replica VMs), per-instance JSONL files mean concurrent appenders never collide. Make sure `os.hostname()` returns a unique value per pod / VM — most platforms do this by default.

Audit events live in the same target storage as content; they're picked up by your existing target backup. The `.gazetta/audit/` directory is gitignored — runtime state, not source.

If a web server or static host serves the target's storage folder directly, or you run `gazetta serve` on a `type: 'static'` target, the audit log and page history under `.gazetta/` are downloadable. Block `/.gazetta/` at the proxy (see [Nginx](#nginx)) or leave it out of the upload. Details: [Where Gazetta keeps its own files, and when they're public](audit.md#where-gazetta-keeps-its-own-files-and-when-theyre-public).

## Docker

```dockerfile
FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npx gazetta publish

EXPOSE 8080
CMD ["npx", "gazetta", "serve", "-p", "8080"]
```

Or with a remote storage target (S3/R2):

```dockerfile
FROM node:22-slim
WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .

EXPOSE 8080
CMD ["npx", "gazetta", "serve", "-p", "8080"]
```

Pass storage credentials as environment variables:

```bash
docker run -p 8080:8080 \
  -e R2_ACCESS_KEY_ID=... \
  -e R2_SECRET_ACCESS_KEY=... \
  my-site
```

## Reverse proxy

### Nginx

```nginx
server {
    listen 80;
    server_name mysite.com;

    # Gazetta's own files (audit log, history) are never for visitors
    location ^~ /.gazetta/ {
        return 404;
    }

    location / {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Nginx respects `s-maxage` from the response headers — it will cache pages at the proxy level.

### Behind a CDN

Place any CDN (CloudFront, Fastly, Bunny) in front of your server. The `s-maxage` header tells the CDN how long to cache. The `ETag` header enables conditional requests.

No special configuration needed — standard HTTP caching.

## Fly.io

```toml
# fly.toml
app = "my-site"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true

[[services.ports]]
  port = 443
  handlers = ["tls", "http"]
```

```bash
fly deploy
```

## Compared to Cloudflare Workers

| | Self-hosted | Cloudflare Workers |
|---|---|---|
| Runtime | Node.js / Bun | V8 isolate |
| Storage | Any (filesystem, S3, R2, Azure) | R2 only |
| Cache | Reverse proxy / CDN | Cloudflare Cache API |
| Deploy | Docker / systemd / PM2 | `wrangler deploy` |
| Cold start | None (long-running process) | ~1ms (isolate) |
| Cost | Your server | Workers free tier / paid |

Both use the same assembly logic and serve identical HTML.

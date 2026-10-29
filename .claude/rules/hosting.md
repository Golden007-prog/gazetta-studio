---
paths:
  - "packages/gazetta/src/serve.ts"
  - "packages/gazetta/src/workers/**"
  - "docs/cloudflare.md"
  - "docs/self-hosted.md"
  - ".github/workflows/**"
---

# Hosting and Deployment

Serve modes, hosting platforms, deployment workflows, and production operations.

## Serve Modes

> **Current code (2026-10-22):** `gazetta serve` serves the site only (`runServe` in `cli/index.ts` creates just the site server). The admin runs with `gazetta admin`. Sections below that describe admin, auth and `/admin` under `gazetta serve` are the planned shape, not today's behaviour. `gazetta dev` listens on `127.0.0.1`, and so does `gazetta admin` while `admin.auth` is `trust: 'none'`; with real auth configured, `gazetta admin` listens on every interface. `--host` overrides the default on all three ([#1074](https://github.com/gazetta-studio/gazetta-studio/issues/1074)).

| Mode | Command | Runtime | What it does |
|------|---------|---------|-------------|
| **Dev server** | `gazetta dev` | Node (Hono) | Renders on-the-fly from source, hot reload via SSE, admin UI at /admin |
| **Node production** | `gazetta serve` | Node/Bun (Hono) | ESI assembly from storage, ETag/304, Cache-Control headers |
| **Cloudflare Worker** | `gazetta build && gazetta deploy production` | Cloudflare Workers (Hono) | ESI assembly from R2, Cache API, edge distribution |
| **Static file server** | Any web server (nginx, Caddy, etc.) | None | Serves pre-baked HTML files directly |

`gazetta dev` and `gazetta serve` are different code paths:
- `dev` uses the renderer directly, watches files, supports admin UI
- `serve` reads pre-rendered HTML from storage and assembles ESI

## Publish Sources

| Source | Command / action | Runs where | Typical use |
|--------|-----------------|------------|-------------|
| **CLI** | `gazetta publish [target]` | Developer machine or CI | Full site publish |
| **Admin UI** | Publish button → `POST /api/publish` | Browser → dev server API | Per-page/fragment publish during editing |
| **CI/CD** | `gazetta publish production` in GitHub Actions | CI runner | Automated publish on push |

CLI, CI and the admin all publish through the same shared function (`publishToTarget`).
The target's `type` decides how pages are published (`getType` in `packages/gazetta/src/types.ts`):
`static` pages are fully assembled at publish time; `dynamic` pages keep ESI placeholders
that a worker or `gazetta serve` assembles per request. Default: `dynamic` when the target's
deploy adapter bundles a worker, `static` otherwise. The admin API also resolves dependencies
(on static targets, the pages that use a published fragment are republished) and handles
per-item cache purge.

### CI/CD Pattern (GitHub Actions)

```yaml
- npm ci
- gazetta publish production
  env: { CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY }
# If deploying worker (rare — on Gazetta upgrade or first setup):
- gazetta build
- gazetta deploy production
```

## Deploy Credentials

`gazetta deploy production` needs platform credentials separate from storage credentials:

| Platform | Credential source | How |
|----------|------------------|-----|
| Cloudflare | `wrangler login` (interactive) or `CLOUDFLARE_API_TOKEN` env var | wrangler handles auth |
| Deno Deploy (future) | `DENO_DEPLOY_TOKEN` env var | — |
| Vercel (future) | `VERCEL_TOKEN` env var | — |

Deploy credentials go in `.env` or CI secrets. They are NOT in `site.config.ts` (which holds
storage credentials via `process.env.X!`). Deploy is a one-time setup — credentials are rarely
needed after initial deploy.

## Self-hosting Deployment Workflow

```
# On VPS or container:
git clone <repo> && cd my-project
npm install
gazetta build                    # build admin + worker
gazetta publish production       # render + push content to storage
gazetta serve production -p 3000   # start server
```

Or with Docker — `gazetta init` creates a `Dockerfile` that runs `build` + `serve`.

## `gazetta serve` Without `gazetta build`

If `dist/admin/` doesn't exist, `serve` runs the site without the admin UI. The site
works (ESI assembly from storage). `/admin` returns a message: "Run `gazetta build` to
enable the admin UI."

## `gazetta serve` Target Selection

`serve` auto-detects the first target in `site.config.ts`. For sites with multiple targets
(staging + production), the developer should specify: `gazetta serve production`.
Default is the first target — usually staging/filesystem for local development.

## `gazetta serve` — Editing vs Published Content

`gazetta serve` shows published content from storage — not local filesystem edits. The admin
UI in `serve` mode publishes directly to the target storage. Edits are immediately live
(after publish). This is different from `dev` mode where edits are local and preview is
on-the-fly. In `serve` mode, there is no local draft state — publish = live.

## Process Management

For production self-hosting, use a process manager:

```
# PM2 (recommended)
pm2 start "gazetta serve production" --name my-site

# systemd
[Service]
ExecStart=/usr/bin/node ./node_modules/.bin/gazetta serve production
Restart=always

# Docker
CMD ["node", "./node_modules/.bin/gazetta", "serve", "production"]
```

Process managers handle auto-restart on crash, log rotation, and zero-downtime restarts.

## Graceful Shutdown

`gazetta serve` handles SIGTERM gracefully:
1. Stop accepting new connections
2. Wait for in-flight requests to complete (up to 10s timeout)
3. Close storage connections
4. Exit with code 0

Important for zero-downtime deploys on container platforms (rolling restarts).

## Health Check and Monitoring

`gazetta serve` exposes:

```
/health              # returns 200 OK — for container health checks
/admin/api/health    # returns 200 + { status: "ok", version: "1.0.0" }
```

No built-in metrics or tracing. For production monitoring, use:
- Reverse proxy access logs for request metrics
- Process manager (PM2, systemd) for uptime
- External monitoring (UptimeRobot, Pingdom) for availability
- Future: OpenTelemetry integration for traces/metrics

## HTTPS in Dev Mode

`gazetta dev` serves over HTTP. For browser APIs requiring HTTPS (clipboard, geolocation),
use a reverse proxy (e.g. `caddy reverse-proxy --from https://localhost:3443 --to localhost:3000`).
Future: `--https` flag using a self-signed cert.

## Auth for Production Admin

`gazetta serve` protects `/admin/*` routes via auth middleware. Auth method configured
in `site.config.ts`:

```ts
defineSite({
  admin: {
    auth: 'basic', // HTTP Basic Auth
    users: [{ username: 'admin', password: process.env.ADMIN_PASSWORD! }],
  },
})
```

Future: OAuth, API key, custom middleware. For now, Basic Auth behind HTTPS (reverse proxy).

## Admin UI URL Structure

The admin UI is a Vue SPA with client-side routing:

```
/admin              # main editor view (site tree + editor + preview)
/admin/dev          # custom editor/field development playground
```

All routes are handled client-side — the server returns `index.html` for any `/admin/*` URL.
Browser back/forward works. Bookmarkable state (selected page, component) is future work.

## Content Editor Onboarding (Non-developer)

Content editors don't use the CLI. They access the admin UI via URL:
- Dev mode: `http://localhost:3000/admin` (someone runs `gazetta dev`)
- Production: `https://admin.mysite.com` (via `gazetta serve` or cloud deploy)

Access is controlled by auth (see above). The content editor opens the URL, logs in,
and edits content. No terminal, no git, no npm.

For team setups: a developer runs `gazetta dev` on a shared machine or deploys `gazetta serve`
to a VPS. Content editors access it remotely. Or each content editor clones the repo and
runs `gazetta dev` locally — but this requires Node.js and npm knowledge.

## Future Hosting Platforms

Gazetta is built on Hono, which runs on WinterTC edge runtimes, Node.js, and Bun. This opens
many deployment targets beyond what's currently implemented.

### Edge/Worker Platforms (ESI page assembly at the edge)

| Platform | Hono adapter | WinterTC | CDN | Free tier | Status |
|----------|-------------|----------|-----|-----------|--------|
| **Cloudflare Workers** | `hono/cloudflare-workers` | Yes | Global | 100K req/day | Implemented |
| **Cloudflare Pages + Functions** | `hono/cloudflare-pages` | Yes | Global | Unlimited static, 100K fn/day | Future — static + functions in one |
| **Deno Deploy** | `hono/deno` | Yes | 35+ regions | 1M req/mo | Future |
| **Vercel Edge Functions** | `hono/vercel` | Yes | Global | 100 GB/mo | Future |
| **Netlify Edge Functions** | `hono/netlify` | Yes (Deno-based) | Global | 100 GB/mo | Future |
| **Fastly Compute** | `@fastly/hono-fastly-compute` | Yes (WASM) | Global | Trial only | Future — niche |
| **AWS Lambda@Edge** | `hono/lambda-edge` | No (Node.js) | CloudFront | 1M req/mo | Future |

### Server Platforms (dynamic SSR, preview, admin hosting)

| Platform | Hono adapter | Containers | Scale-to-zero | Free tier | Notes |
|----------|-------------|-----------|---------------|-----------|-------|
| **Node/Bun (self-hosted)** | `@hono/node-server` / `hono/bun` | N/A | N/A | N/A | Current (`gazetta serve`) |
| **Fly.io** | Via Node/Bun | Docker | No (min 1 machine) | Pay-as-you-go | Good for always-on servers |
| **Google Cloud Run** | Via Node/Bun | Docker | Yes | 2M req/mo | Best serverless container option |
| **Railway** | Via Node/Bun | Docker | No | $5 trial credit | Simple DX, no free tier |
| **Render** | Via Node/Bun | Docker | Yes (free spins down) | 512 MB / 0.1 CPU | Free tier spins down after 15 min |
| **Azure Container Apps** | Via Node/Bun | Docker | Yes | 180K vCPU-sec/mo | Good Azure integration |
| **AWS Lambda** | `hono/aws-lambda` | Serverless | Yes | 1M req/mo | Cold starts, not ideal for admin |

### Static Hosting (pre-built admin SPA or static target output)

| Platform | CDN | Free tier | Notes |
|----------|-----|-----------|-------|
| **GitHub Pages** | Yes | Unlimited (public) | Good for docs, simple sites |
| **Netlify** | Yes | 100 GB/mo | Popular, good DX |
| **Vercel** | Yes | 100 GB/mo | Popular, good DX |
| **Cloudflare Pages** | Yes | Unlimited | Best free tier |
| **Azure Blob static website** | Via Azure CDN | 5 GB storage | Implemented as storage provider |
| **AWS S3 + CloudFront** | Yes | 1 TB/mo (12 mo trial) | Implemented as storage provider |
| **Firebase Hosting** | Yes | 10 GB storage | Google ecosystem |

### Admin UI Hosting (future)

The admin UI currently only runs in dev mode (`gazetta dev`). For production admin hosting,
the admin needs three things: static SPA assets, the Hono API (server-side, needs storage + template access),
and custom editor/field bundles (site-specific browser code).

**All-in-one (SPA + API in single process) — recommended:**

| Platform | How | Custom editors | Preview SSR | Auth | Notes |
|----------|-----|---------------|-------------|------|-------|
| **`gazetta serve` + admin** | Node/Bun process serves SPA + API on one port | Full — filesystem access to editor bundles | Full — Node SSR | Middleware | WordPress model. Simplest. Add behind reverse proxy (Caddy/nginx) for HTTPS |
| **Docker** | Containerized Node/Bun. Same as above | Full | Full | Middleware | Deploy to Fly.io, Railway, Render, Cloud Run, Azure Container Apps, any VPS |
| **Fly.io** | Docker container, global edge network | Full | Full | Middleware | Good for always-on admin. ~$2/mo min |
| **Google Cloud Run** | Docker container, scale-to-zero | Full | Full | IAM or middleware | Best serverless container. Cold start ~1s |
| **Railway** | Docker container, no scale-to-zero | Full | Full | Middleware | Simple DX. $5/mo min |
| **Render** | Docker container, free tier spins down | Full | Full | Middleware | Free tier has 15-min spin-down — bad for admin UX |

**Split deployment (SPA separate from API):**

| SPA host | API host | Custom editors | Notes |
|----------|----------|---------------|-------|
| **Vercel/Netlify/CF Pages** (static) | **Serverless function** (same platform) | Pre-bundled — editors built into SPA or served from API | SPA at `admin.mysite.com`, API as serverless. CORS needed if different origins |
| **Vercel** (static + Edge) | **Vercel Serverless** | Pre-bundled | One platform, two runtimes. Edge for SPA, serverless for API |
| **Cloudflare Pages** (static + Workers) | **Cloudflare Workers** | Pre-bundled | Pages for SPA, Worker for API. R2 for storage. All Cloudflare |
| **Netlify** (static + Edge) | **Netlify Functions** | Pre-bundled | Pages for SPA, Functions for API |

Split deployments require:
- CORS configuration (SPA and API on different origins/subdomains)
- Custom editors must be pre-bundled during `gazetta build` (no on-the-fly serving)
- Two deploys to coordinate on every admin change
- Auth on both SPA (protect routes) and API (validate tokens)

**Not viable for admin:**

| Platform | Why not |
|----------|---------|
| **Pure edge (Workers/Deno Deploy)** | Admin API needs Node.js for template loading (jiti), preview SSR, and storage provider SDKs. WinterTC runtimes lack these |
| **GitHub Pages** | Static only — no API |
| **S3/Azure Blob static** | Static only — no API |
| **AWS Lambda@Edge** | 5s timeout, 1MB response limit, Node.js only (no Bun). Too constrained for preview rendering |

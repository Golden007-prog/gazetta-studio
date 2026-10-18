import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// Anchor PWA plugin's `srcDir` to this config file's location, not
// the runner's cwd. The gazetta package's `build:admin` script runs
// vite from `packages/gazetta` with this config file as
// `-c ../../apps/admin/vite.config.ts`; without an absolute path,
// `srcDir: 'src/client'` resolves to packages/gazetta/src/client
// and the SW source isn't found.
//
// We anchor ONLY the PWA srcDir, not Vite's `root` — overriding root
// would also redirect `--outDir admin-dist` (relative to root) to
// `apps/admin/admin-dist/` instead of the packaged location
// `packages/gazetta/admin-dist/`.
const configDir = dirname(fileURLToPath(import.meta.url))
const swSrcDir = resolve(configDir, 'src/client')
// Gazetta version, part of the persisted query cache's reset key: a new
// admin build must not read query results cached by an older one.
const gazettaVersion = JSON.parse(
  readFileSync(resolve(configDir, '../../packages/gazetta/package.json'), 'utf8'),
).version

export default defineConfig({
  define: { 'import.meta.env.GAZETTA_VERSION': JSON.stringify(gazettaVersion) },
  plugins: [
    vue(),
    // Service worker for app-shell precache per design-offline.md Cut 11.
    // Scoped to "open admin offline → blank screen" — without the SW, a
    // cold load offline can't fetch /admin/index.html. With the SW, the
    // precached shell loads, the L6 IndexedDB cache hydrates state, and
    // the app renders. The IDB cache (Cuts 2-4) handles data; this SW
    // handles the app bundle.
    //
    // injectManifest strategy because v2 background sync (deferred) wants
    // a custom SW source to drop into. generateSW would work for v1
    // alone but would require a strategy migration when v2 lands;
    // shipping injectManifest now means v2 adds handlers without
    // touching the build wiring.
    VitePWA({
      strategies: 'injectManifest',
      srcDir: swSrcDir,
      filename: 'sw.ts',
      // No PWA install prompt in v1 — `registerType: 'prompt'` ships the
      // update-available toast (per design-offline.md "update detection
      // UX"), but skips the install prompt + manifest.webmanifest.
      registerType: 'prompt',
      injectRegister: false, // we register manually from main.ts via virtual:pwa-register/vue
      // Manifest stays minimal — we're not a PWA (yet); just precaching
      // for offline reload reliability. The web manifest landing page
      // and install prompt flow is a v2 feature.
      manifest: false,
      injectManifest: {
        // Bumped from default 2 MB so the admin bundle (PrimeVue + rjsf
        // + Tiptap clocks in around ~3 MB minified) precaches without
        // warnings. Each chunk ships independently; this is the per-file
        // cap, not total.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Default is js/css/html only. woff2 adds the bundled primeicons
        // font so icons render on an offline cold load; browsers that read
        // woff2 never fetch the other font formats.
        globPatterns: ['**/*.{js,css,html,woff2}'],
      },
      // Don't enable in dev — Vite HMR + SW caching fight each other.
      // SW only runs in production builds.
      devOptions: { enabled: false },
    }),
  ],
  root: '.',
  build: {
    rolldownOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) return
        warn(warning)
      },
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/vue/') ||
            id.includes('node_modules/vue-router/') ||
            id.includes('node_modules/pinia/')
          )
            return 'vendor-vue'
          if (id.includes('node_modules/primevue/') || id.includes('node_modules/@primevue/')) return 'vendor-primevue'
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'vendor-react'
          if (id.includes('node_modules/@rjsf/') || id.includes('node_modules/ajv')) return 'vendor-rjsf'
          if (
            id.includes('node_modules/@tiptap/') ||
            id.includes('node_modules/prosemirror') ||
            id.includes('node_modules/@prosemirror/')
          )
            return 'vendor-tiptap'
        },
      },
    },
  },
  server: {
    hmr: {
      // When proxied through gazetta dev, tell the browser to connect HMR websocket to Vite's actual port
      clientPort: parseInt(process.env.VITE_HMR_PORT ?? '0', 10) || undefined,
    },
    proxy: {
      '/api': `http://localhost:${process.env.API_PORT ?? '4000'}`,
      '/preview': `http://localhost:${process.env.API_PORT ?? '4000'}`,
    },
  },
})

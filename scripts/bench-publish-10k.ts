#!/usr/bin/env npx tsx
/**
 * Benchmark: full publish pipeline at 10k pages.
 *
 * Measures per-phase timings to identify bottlenecks in the publish
 * workflow at scale. Runs against both Azurite (Azure Blob) and
 * MinIO (S3) via the existing docker-compose.yml.
 *
 * Usage:
 *   npx tsx scripts/bench-publish-10k.ts [--pages=10000] [--provider=azurite|minio|filesystem]
 *
 * Requires Docker running for azurite/minio providers.
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PAGE_COUNT = Number(process.argv.find(a => a.startsWith('--pages='))?.split('=')[1] ?? 10_000)
const PROVIDER = process.argv.find(a => a.startsWith('--provider='))?.split('=')[1] ?? 'filesystem'

// --- Timing helpers ---
function timer() {
  const start = performance.now()
  return () => ((performance.now() - start) / 1000).toFixed(2) + 's'
}

function log(label: string, elapsed: string, detail?: string) {
  const pad = label.padEnd(20)
  console.log(`  ${pad} ${elapsed}${detail ? `  (${detail})` : ''}`)
}

// --- Seed page manifests ---
async function seedPages(dir: string, count: number): Promise<void> {
  const t = timer()
  const pagesDir = join(dir, 'pages')

  // Write in parallel batches to avoid fd exhaustion
  const batchSize = 500
  for (let i = 0; i < count; i += batchSize) {
    const batch = []
    for (let j = i; j < Math.min(i + batchSize, count); j++) {
      const name = `page-${String(j).padStart(5, '0')}`
      const pageDir = join(pagesDir, name)
      batch.push(
        mkdir(pageDir, { recursive: true }).then(() =>
          writeFile(
            join(pageDir, 'page.json'),
            JSON.stringify({
              template: 'bench',
              content: { title: `Page ${j}`, description: `Description for page ${j}` },
              metadata:
                j % 100 === 0 ? { robots: 'noindex' } : { title: `SEO Title ${j}`, description: `SEO desc ${j}` },
            }),
          ),
        ),
      )
    }
    await Promise.all(batch)
  }

  // Site config
  await writeFile(
    join(dir, 'site.config.ts'),
    `import { defineSite } from 'gazetta'

export default defineSite({
  name: 'Bench Site',
  siteUrl: 'https://bench.example.com',
  locale: 'en',
  systemPages: [],
  targets: {
    bench: {
      storage: { type: 'filesystem', path: './dist/bench' },
    },
  },
})
`,
  )

  // Stub template
  const tplDir = join(dir, 'templates', 'bench')
  await mkdir(tplDir, { recursive: true })
  await writeFile(
    join(tplDir, 'index.ts'),
    `export const schema = { _def: { typeName: 'ZodObject' }, shape: { title: {}, description: {} } }
export default ({ content }) => ({
  html: '<h1>' + (content?.title ?? '') + '</h1><p>' + (content?.description ?? '') + '</p>',
  css: 'h1 { color: navy; }',
  js: '',
})
`,
  )

  // package.json for templates workspace
  await writeFile(join(dir, 'templates', 'package.json'), JSON.stringify({ name: 'templates', private: true }))

  log('Seed', t(), `${count} pages`)
}

// --- Create storage provider ---
async function createProvider(
  provider: string,
  projectDir: string,
): Promise<{ storage: import('../packages/gazetta/src/types.js').StorageProvider; cleanup: () => Promise<void> }> {
  if (provider === 'filesystem') {
    const { createFilesystemProvider } = await import('../packages/gazetta/src/providers/filesystem.js')
    const distDir = join(projectDir, 'dist', 'bench')
    await mkdir(distDir, { recursive: true })
    return { storage: createFilesystemProvider(distDir), cleanup: async () => {} }
  }

  if (provider === 'azurite') {
    const { DockerComposeEnvironment } = await import('testcontainers')
    const env = await new DockerComposeEnvironment('.', 'docker-compose.yml').withStartupTimeout(60_000).up(['azurite'])
    const container = env.getContainer('azurite-1')
    const port = container.getMappedPort(10000)
    const connStr = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`
    const { createAzureBlobProvider } = await import('../packages/gazetta/src/providers/azure-blob.js')
    const storage = await createAzureBlobProvider({ connectionString: connStr, container: 'bench-10k' })
    return { storage, cleanup: () => env.down() }
  }

  if (provider === 'minio') {
    const { DockerComposeEnvironment } = await import('testcontainers')
    const env = await new DockerComposeEnvironment('.', 'docker-compose.yml').withStartupTimeout(60_000).up(['minio'])
    const container = env.getContainer('minio-1')
    const port = container.getMappedPort(9000)
    const { createS3Provider } = await import('../packages/gazetta/src/providers/s3.js')
    const storage = await createS3Provider({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: 'bench-10k',
      region: 'us-east-1',
      accessKeyId: 'minioadmin',
      secretAccessKey: 'minioadmin',
      forcePathStyle: true,
    })
    return { storage, cleanup: () => env.down() }
  }

  throw new Error(`Unknown provider: ${provider}`)
}

// --- Main ---
async function main() {
  console.log(`\n=== Publish benchmark: ${PAGE_COUNT} pages on ${PROVIDER} ===\n`)

  // 1. Seed
  const projectDir = await mkdtemp(join(tmpdir(), 'gazetta-bench-'))
  try {
    await seedPages(projectDir, PAGE_COUNT)

    // 2. Create provider
    const tSetup = timer()
    const { storage: targetStorage, cleanup } = await createProvider(PROVIDER, projectDir)
    log('Provider setup', tSetup())

    try {
      // 3. Load site
      const tLoad = timer()
      const { loadSite } = await import('../packages/gazetta/src/site-loader.js')
      const { createContentRoot } = await import('../packages/gazetta/src/content-root.js')
      const { createFilesystemProvider } = await import('../packages/gazetta/src/providers/filesystem.js')
      const sourceStorage = createFilesystemProvider(projectDir)
      const contentRoot = createContentRoot(sourceStorage)
      const site = await loadSite({
        contentRoot,
        templatesDir: join(projectDir, 'templates'),
        manifest: { name: '(bench)' },
      })
      log('Load site', tLoad(), `${site.pages.size} pages`)

      // 4. Template scan
      const tScan = timer()
      const { scanTemplates, templateHashesFrom } = await import('../packages/gazetta/src/templates-scan.js')
      const templateInfos = await scanTemplates(join(projectDir, 'templates'), projectDir)
      const templateHashes = templateHashesFrom(templateInfos)
      log('Template scan', tScan(), `${templateInfos.length} templates`)

      // 5. Compare (first publish — empty target)
      const tCompare = timer()
      const { compareTargets } = await import('../packages/gazetta/src/compare.js')
      const cmp = await compareTargets({
        sourceRoot: contentRoot,
        target: targetStorage,
        templatesDir: join(projectDir, 'templates'),
        projectRoot: projectDir,
        type: 'static',
        manifest: { name: '(bench)' },
        scanTemplates: async () => templateInfos,
      })
      log('Compare', tCompare(), `${cmp.added.length} added, ${cmp.unchanged.length} unchanged`)

      // 6. Render + upload
      const tPublish = timer()
      const { publishPageStatic } = await import('../packages/gazetta/src/publish-compat.js')
      const { hashManifest } = await import('../packages/gazetta/src/hash.js')
      let published = 0
      // Batch to avoid memory pressure
      const pageNames = [...site.pages.keys()]
      const batchSize = 100
      for (let i = 0; i < pageNames.length; i += batchSize) {
        const batch = pageNames.slice(i, i + batchSize)
        await Promise.all(
          batch.map(async name => {
            const page = site.pages.get(name)!
            const hash = hashManifest(page, { templateHashes })
            await publishPageStatic(name, contentRoot, targetStorage, join(projectDir, 'templates'), hash, site)
            published++
          }),
        )
        if (published % 1000 === 0) process.stdout.write(`    ${published}/${PAGE_COUNT}\r`)
      }
      log('Render + upload', tPublish(), `${published} pages`)

      // 7. Sitemap
      const tSitemap = timer()
      const { listSidecars } = await import('../packages/gazetta/src/sidecars.js')
      const { generateSitemap } = await import('../packages/gazetta/src/sitemap.js')
      const targetSidecars = await listSidecars(targetStorage, 'pages')
      const sitemapXml = generateSitemap({
        siteUrl: 'https://bench.example.com',
        pages: targetSidecars,
        systemPages: [],
      })
      if (sitemapXml) {
        await targetStorage.writeFile('sitemap.xml', sitemapXml)
      }
      log(
        'Sitemap',
        tSitemap(),
        `${targetSidecars.size} entries, ${sitemapXml ? Math.round(sitemapXml.length / 1024) + 'KB' : 'null'}`,
      )

      // 8. Robots
      const tRobots = timer()
      const { generateRobotsTxt } = await import('../packages/gazetta/src/robots.js')
      await targetStorage.writeFile('robots.txt', generateRobotsTxt({ siteUrl: 'https://bench.example.com' }))
      log('robots.txt', tRobots())

      // 9. Total
      console.log()

      // === Incremental publish (0 changes) ===
      console.log(`=== Incremental publish (0 changes) ===\n`)

      const tIncCompare = timer()
      const cmp2 = await compareTargets({
        sourceRoot: contentRoot,
        target: targetStorage,
        templatesDir: join(projectDir, 'templates'),
        projectRoot: projectDir,
        type: 'static',
        manifest: { name: '(bench)' },
        scanTemplates: async () => templateInfos,
      })
      log('Compare', tIncCompare(), `${cmp2.added.length} added, ${cmp2.unchanged.length} unchanged`)

      const tIncSitemap = timer()
      const sidecars2 = await listSidecars(targetStorage, 'pages')
      generateSitemap({ siteUrl: 'https://bench.example.com', pages: sidecars2 })
      log('Sitemap', tIncSitemap(), `${sidecars2.size} entries`)

      console.log()
    } finally {
      await cleanup()
    }
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

import { describe, it, expect, afterEach } from 'vitest'
import { resolve, join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile, readdir } from 'node:fs/promises'
import { REQUIRED_NODE_RANGE } from '../src/node-floor.js'
import { tempDir } from './_helpers/temp.js'
import { parseArgs } from '../src/cli/args.js'

// Test the helper functions from the CLI by extracting the logic
// Since the CLI is a script with side effects, we test the pure functions

describe('parseArgs', () => {
  it('defaults to empty positional', () => {
    const { positional, port } = parseArgs([])
    expect(positional).toEqual([])
    expect(port).toBeUndefined()
  })

  it('collects positional args', () => {
    const { positional } = parseArgs(['production', 'my-site'])
    expect(positional).toEqual(['production', 'my-site'])
  })

  it('parses --port flag', () => {
    const { port } = parseArgs(['--port', '8080'])
    expect(port).toBe(8080)
  })

  it('parses -p shorthand', () => {
    const { port } = parseArgs(['-p', '4000'])
    expect(port).toBe(4000)
  })

  it('mixes positional and flags', () => {
    const { positional, port } = parseArgs(['production', '-p', '9000', 'my-site'])
    expect(positional).toEqual(['production', 'my-site'])
    expect(port).toBe(9000)
  })

  it.each([
    [['--host', '0.0.0.0'], '0.0.0.0'],
    [['--host=192.168.1.20'], '192.168.1.20'],
    [['dev', '--host', '127.0.0.1', '-p', '4000'], '127.0.0.1'],
    [['dev'], undefined],
  ])('parses --host in %j', (input, expected) => {
    const parsed = parseArgs(input)
    expect(parsed.host).toBe(expected)
    expect(parsed.positional).not.toContain(expected)
  })
})

describe('detectProjectRoot', () => {
  function detectProjectRoot(siteDir: string): string {
    if (existsSync(join(siteDir, 'templates'))) return siteDir
    let dir = resolve(siteDir)
    const root = resolve('/')
    while (dir !== root) {
      const parent = dirname(dir)
      if (existsSync(join(parent, 'templates'))) return parent
      dir = parent
    }
    return siteDir
  }

  it('returns siteDir when templates/ is inside it (flat project)', () => {
    const starterDir = resolve(import.meta.dirname, '../../../examples/starter')
    // Starter has templates/ at root — flat detection
    expect(detectProjectRoot(starterDir)).toBe(starterDir)
  })

  it('finds project root from sites/main/ (restructured project)', () => {
    const starterDir = resolve(import.meta.dirname, '../../../examples/starter')
    const siteDir = join(starterDir, 'sites/main')
    // Should walk up to find templates/ in the parent
    expect(detectProjectRoot(siteDir)).toBe(starterDir)
  })

  it('falls back to siteDir when no templates/ found', () => {
    const tmpDir = tempDir('no-templates-' + Date.now())
    // Doesn't exist, so no templates/ anywhere
    expect(detectProjectRoot(tmpDir)).toBe(tmpDir)
  })
})

describe('runInit', () => {
  const testDir = tempDir('init-test-' + Date.now())

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('scaffolds the correct project structure', { timeout: 60000 }, async () => {
    // Run init via the compiled CLI
    const { execSync } = await import('node:child_process')
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir}`, { stdio: 'pipe' })

    // Verify structure
    expect(existsSync(join(testDir, 'package.json'))).toBe(true)
    expect(existsSync(join(testDir, 'templates/hero/index.ts'))).toBe(true)
    expect(existsSync(join(testDir, 'templates/page-layout/index.ts'))).toBe(true)
    expect(existsSync(join(testDir, 'templates/nav/index.ts'))).toBe(true)
    expect(existsSync(join(testDir, 'templates/text-block/index.ts'))).toBe(true)
    expect(existsSync(join(testDir, 'admin/.gitkeep'))).toBe(true)
    expect(existsSync(join(testDir, 'sites/main/site.config.ts'))).toBe(true)
    // No target-level site.config.ts — project-level site.config.ts is the single source of truth.
    expect(existsSync(join(testDir, 'sites/main/targets/local/site.config.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'sites/main/targets/local/pages/home/page.json'))).toBe(true)
    expect(existsSync(join(testDir, 'sites/main/targets/local/fragments/header/fragment.json'))).toBe(true)
    expect(existsSync(join(testDir, 'sites/main/targets/local/pages/404/page.json'))).toBe(true)

    // No component subdirectories (components are inline in page.json)
    expect(existsSync(join(testDir, 'sites/main/targets/local/pages/home/hero'))).toBe(false)

    // site.config.ts has a default local target
    const siteConfig = await import('node:fs').then(fs =>
      fs.readFileSync(join(testDir, 'sites/main/site.config.ts'), 'utf-8'),
    )
    expect(siteConfig).toContain("import { defineSite, filesystemStorage } from 'gazetta'")
    expect(siteConfig).toContain('targets:')
    expect(siteConfig).toContain('local:')
    expect(siteConfig).toContain('filesystemStorage()')
    expect(siteConfig).toContain('systemPages:')

    // No legacy YAML or old flat structure
    expect(existsSync(join(testDir, 'sites/main/site.yaml'))).toBe(false)
    expect(existsSync(join(testDir, 'site.yaml'))).toBe(false)
    expect(existsSync(join(testDir, 'site.config.ts'))).toBe(false)
    expect(existsSync(join(testDir, 'pages'))).toBe(false)
    expect(existsSync(join(testDir, 'fragments'))).toBe(false)
  })

  it('scaffold passes its own broken-links check (#1183)', { timeout: 120000 }, async () => {
    const { execFileSync, spawnSync } = await import('node:child_process')
    execFileSync('node', [resolve(import.meta.dirname, '../dist/cli/index.js'), 'init', testDir], { stdio: 'pipe' })

    // The scaffold still tells the user where the CMS is, without linking to it.
    const home = await import('node:fs').then(fs =>
      fs.readFileSync(join(testDir, 'sites/main/targets/local/pages/home/page.json'), 'utf-8'),
    )
    expect(home).toContain('npx gazetta dev')
    expect(home).toContain('/admin')
    expect(home).not.toContain('href="/admin"')

    const validate = (extra: string[] = []) =>
      spawnSync(
        'node',
        [
          resolve(import.meta.dirname, '../dist/cli/index.js'),
          'validate',
          'sites/main',
          '--include-quality',
          '--severity=warn',
          ...extra,
        ],
        { cwd: testDir, env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf-8' },
      )

    // An untouched site has no broken links: /admin exists only while
    // `gazetta dev`/`gazetta admin` runs, so the scaffold must not link to it.
    const clean = validate()
    expect(clean.status).toBe(0)

    // broken-links still flags a link to a route that does not exist.
    const homePath = join(testDir, 'sites/main/targets/local/pages/home/page.json')
    const parsed = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(homePath, 'utf-8')))
    parsed.components[2].content.body = '<p><a href="/no-such-page">missing</a></p>'
    await import('node:fs').then(fs => fs.writeFileSync(homePath, JSON.stringify(parsed, null, 2) + '\n'))

    // Verbose prints the offending link; the default summary only counts it.
    const broken = validate(['--verbose'])
    expect(broken.status).toBe(1)
    expect(broken.stdout + broken.stderr).toContain('/no-such-page: link does not match any page route or asset path')
  })

  it('package.json has correct fields', { timeout: 60000 }, async () => {
    const { execSync } = await import('node:child_process')
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir}`, { stdio: 'pipe' })

    const pkg = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(join(testDir, 'package.json'), 'utf-8')))
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
    // Must match the repo's root engines floor (single source: src/node-floor.ts).
    // New sites created via `gazetta init` install write-file-atomic transitively;
    // a looser range here would surface as a confusing EBADENGINE pointing at
    // a transitive dep on Node 22.0–22.22.1, 23.x, 24.0–24.14, or 25.x.
    expect(pkg.engines.node).toBe(REQUIRED_NODE_RANGE)
    expect(pkg.scripts.dev).toBe('gazetta dev')
    expect(pkg.dependencies.react).toBeDefined()
    expect(pkg.dependencies.zod).toBeDefined()
  })

  it('gitignores .env files and .gazetta/ state', { timeout: 60000 }, async () => {
    const { execSync } = await import('node:child_process')
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir}`, { stdio: 'pipe' })

    execSync('git init -q .', { cwd: testDir, stdio: 'pipe' })
    // Real git verdicts, not text comparison: the pattern must cover nested
    // target state, not only a top-level .gazetta/. Global excludes are
    // disabled so a match can only come from the generated .gitignore.
    const ignored = (path: string) => {
      try {
        execSync(`git -c core.excludesFile=/dev/null check-ignore -q "${path}"`, { cwd: testDir, stdio: 'pipe' })
        return true
      } catch {
        return false
      }
    }
    expect(ignored('.env')).toBe(true)
    expect(ignored('.env.local')).toBe(true)
    expect(ignored('sites/main/targets/local/.gazetta/history/index.json')).toBe(true)
    expect(ignored('package.json')).toBe(false)

    // Publish output lands next to the content in the local target and must
    // not be committed (#1181): rendered HTML, the publish-time site
    // manifest, per-item .hash sidecars and .pub-* markers.
    expect(ignored('sites/main/targets/local/index.html')).toBe(true)
    expect(ignored('sites/main/targets/local/404/index.html')).toBe(true)
    expect(ignored('sites/main/targets/local/404.html')).toBe(true)
    expect(ignored('sites/main/targets/local/site.json')).toBe(true)
    expect(ignored('sites/main/targets/local/index/fragments.json')).toBe(true)
    // Aggregate indices live at the target root; a page or fragment named
    // "index" is editable source and stays tracked.
    expect(ignored('sites/main/targets/local/pages/index/page.json')).toBe(false)
    expect(ignored('sites/main/targets/local/pages/blog/index/page.json')).toBe(false)
    expect(ignored('sites/main/targets/local/fragments/index/fragment.json')).toBe(false)
    expect(ignored('sites/main/targets/local/pages/home/.41af7f01.hash')).toBe(true)
    expect(ignored('sites/main/targets/local/pages/home/.41af7f01.hash.1')).toBe(true)
    expect(ignored('sites/main/targets/local/pages/home/.pub-20261023T174905Z')).toBe(true)
    // The editable sources and an author's own robots.txt stay tracked.
    expect(ignored('sites/main/targets/local/robots.txt')).toBe(false)
    expect(ignored('sites/main/targets/local/pages/home/page.json')).toBe(false)
    expect(ignored('sites/main/targets/local/fragments/nav/fragment.json')).toBe(false)
  })

  it('refuses to init in existing project', { timeout: 60000 }, async () => {
    const { execSync } = await import('node:child_process')
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir}`, { stdio: 'pipe' })

    // Try again — should fail
    expect(() => {
      execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir}`, { stdio: 'pipe' })
    }).toThrow()
  })
})

describe('runBuild', () => {
  const starterDir = resolve(import.meta.dirname, '../../../examples/starter')
  const outDir = join(starterDir, 'dist', 'admin')

  it('builds admin SPA + bundles custom editors and fields', { timeout: 60000 }, async () => {
    const { execSync } = await import('node:child_process')
    // Clean and rebuild
    await rm(outDir, { recursive: true, force: true })
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} build sites/main`, {
      cwd: starterDir,
      stdio: 'pipe',
    })

    // Admin SPA built
    expect(existsSync(join(outDir, 'index.html'))).toBe(true)
    const assets = await import('node:fs').then(fs => fs.readdirSync(join(outDir, 'assets')))
    expect(assets.some(f => f.endsWith('.js'))).toBe(true)
    expect(assets.some(f => f.endsWith('.css'))).toBe(true)

    // Custom editor bundled — small because deps are externalized
    expect(existsSync(join(outDir, 'editors', 'hero.js'))).toBe(true)
    const heroJs = await import('node:fs').then(fs => fs.readFileSync(join(outDir, 'editors', 'hero.js'), 'utf-8'))
    expect(heroJs.length).toBeGreaterThan(100)
    expect(heroJs.length).toBeLessThan(10000) // should be tiny — deps externalized
    expect(heroJs).toContain('from"react"') // bare specifier, resolved by import map

    // Custom field bundled
    expect(existsSync(join(outDir, 'fields', 'brand-color.js'))).toBe(true)
    const fieldJs = await import('node:fs').then(fs =>
      fs.readFileSync(join(outDir, 'fields', 'brand-color.js'), 'utf-8'),
    )
    expect(fieldJs.length).toBeGreaterThan(100)
    expect(fieldJs.length).toBeLessThan(10000)

    // Shared deps built
    expect(existsSync(join(outDir, '_shared', 'react.js'))).toBe(true)
    expect(existsSync(join(outDir, '_shared', 'react-dom_client.js'))).toBe(true)
    expect(existsSync(join(outDir, '_shared', 'gazetta_editor.js'))).toBe(true)

    // Import map injected into index.html
    const indexHtml = await import('node:fs').then(fs => fs.readFileSync(join(outDir, 'index.html'), 'utf-8'))
    expect(indexHtml).toContain('"importmap"')
    expect(indexHtml).toContain('"react"')
    expect(indexHtml).toContain('/admin/_shared/react.js')
  })
})

describe('runValidate', () => {
  const starterDir = resolve(import.meta.dirname, '../../../examples/starter')

  it('passes on valid project', { timeout: 30000 }, async () => {
    const { execSync } = await import('node:child_process')
    const output = execSync(`npx tsx ${resolve(import.meta.dirname, '../src/cli/index.ts')} validate sites/main`, {
      cwd: starterDir,
      stdio: 'pipe',
    }).toString()
    expect(output).toContain('All good')
    expect(output).toContain('site.config.ts')
    expect(output).toContain('@header')
    expect(output).toContain('@footer')
    expect(output).toContain('home')
  })

  it('detects orphaned editors', { timeout: 30000 }, async () => {
    const { execSync } = await import('node:child_process')
    const { writeFile, rm } = await import('node:fs/promises')
    const orphanPath = join(starterDir, 'admin/editors/nonexistent.tsx')
    await writeFile(orphanPath, 'export default {}')
    try {
      const output = execSync(`npx tsx ${resolve(import.meta.dirname, '../src/cli/index.ts')} validate sites/main`, {
        cwd: starterDir,
        stdio: 'pipe',
      }).toString()
      expect(output).toContain('orphaned editor')
      expect(output).toContain('nonexistent.tsx')
    } finally {
      await rm(orphanPath, { force: true })
    }
  })

  it('detects missing custom fields', { timeout: 30000 }, async () => {
    const { execSync } = await import('node:child_process')
    const { rename } = await import('node:fs/promises')
    const fieldPath = join(starterDir, 'admin/fields/brand-color.tsx')
    const backupPath = fieldPath + '.bak'
    await rename(fieldPath, backupPath)
    try {
      execSync(`npx tsx ${resolve(import.meta.dirname, '../src/cli/index.ts')} validate sites/main`, {
        cwd: starterDir,
        stdio: 'pipe',
      })
      // Should not reach here — validate exits with code 1
      expect.unreachable()
    } catch (err: unknown) {
      const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? ''
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
      const output = stdout + stderr
      expect(output).toContain('brand-color')
      expect(output).toContain('not found')
      expect(output).toContain('1 error')
    } finally {
      await rename(backupPath, fieldPath)
    }
  })
})

describe('translate', () => {
  const starterDir = resolve(import.meta.dirname, '../../../examples/starter')
  const targetDir = join(starterDir, 'sites/main/targets/local')

  it('copies page.json to page.de.json', { timeout: 60000 }, async () => {
    const destFile = join(targetDir, 'pages/home/page.de.json')
    if (existsSync(destFile)) await rm(destFile)

    const { execSync } = await import('node:child_process')
    const output = execSync(
      `node ${resolve(import.meta.dirname, '../dist/cli/index.js')} translate pages/home --to de`,
      { cwd: starterDir, stdio: 'pipe' },
    ).toString()
    expect(output).toContain('page.de.json')

    expect(existsSync(destFile)).toBe(true)
    const content = JSON.parse(await import('node:fs').then(fs => fs.readFileSync(destFile, 'utf-8')))
    expect(content.template).toBeDefined()

    await rm(destFile)
  })

  it('refuses to overwrite existing locale file', { timeout: 60000 }, async () => {
    const { execSync } = await import('node:child_process')
    expect(() => {
      execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} translate pages/home --to fr`, {
        cwd: starterDir,
        stdio: 'pipe',
      })
    }).toThrow()
  })

  it('errors on missing source file', { timeout: 60000 }, async () => {
    const { execSync } = await import('node:child_process')
    expect(() => {
      execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} translate pages/nonexistent --to fr`, {
        cwd: starterDir,
        stdio: 'pipe',
      })
    }).toThrow()
  })
})

describe('findCmsDir (dev mode detection)', () => {
  function findCmsDir(): string | null {
    const candidates = [
      resolve('apps/admin'),
      resolve(import.meta.dirname, '../../../../apps/admin'),
      resolve(import.meta.dirname, '../../../apps/admin'),
    ]
    for (const dir of candidates) {
      if (existsSync(join(dir, 'src/server/dev.ts'))) return dir
    }
    return null
  }

  it('finds admin dir in monorepo', () => {
    const dir = findCmsDir()
    expect(dir).not.toBeNull()
    expect(dir).toContain('apps/admin')
  })
})

describe('renderErrorOverlay', () => {
  function renderErrorOverlay(err: Error): string {
    const message = err.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const stack = (err.stack ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const fileMatch = stack.match(/\(?(\/[^\s:)]+):(\d+)/)
    const filePath = fileMatch ? fileMatch[1] : ''
    const lineNum = fileMatch ? fileMatch[2] : ''
    const location = filePath ? `${filePath}${lineNum ? `:${lineNum}` : ''}` : ''
    return `<!DOCTYPE html><html><head><title>Error — Gazetta</title></head><body>${location ? `<div class="location">${location}</div>` : ''}<div class="message">${message}</div><script>new EventSource('/__reload').onmessage = () => location.reload()</script></body></html>`
  }

  it('renders error message with HTML escaping', () => {
    const html = renderErrorOverlay(new Error('Missing <template> export'))
    expect(html).toContain('Missing &lt;template&gt; export')
    expect(html).not.toContain('<template>')
  })

  it('includes live reload script', () => {
    const html = renderErrorOverlay(new Error('test'))
    expect(html).toContain('/__reload')
  })

  it('extracts file location from stack', () => {
    const err = new Error('bad')
    err.stack = `Error: bad\n    at Object.<anonymous> (/Users/dev/templates/hero/index.ts:5:10)`
    const html = renderErrorOverlay(err)
    expect(html).toContain('/Users/dev/templates/hero/index.ts:5')
  })
})

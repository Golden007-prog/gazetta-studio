/**
 * `gazetta init` scaffolds templates that type-check in strict mode, and
 * content is the schema's type: a field the schema does not declare is a
 * type error (#1490). init writes no tsconfig, so this test supplies the
 * compiler options and resolves `gazetta` and `zod` from this repo.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')
const gazettaTypes = resolve(repoRoot, 'packages/gazetta/dist/index.d.ts')
const zodTypes = resolve(repoRoot, 'node_modules/zod/index.d.cts')

const compilerOptions: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  esModuleInterop: true,
  skipLibCheck: true,
  types: [],
}

let children: ChildProcess[] = []
let workDir: string | null = null

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null) continue
    child.kill('SIGTERM')
    await Promise.race([new Promise(r => child.once('close', r)), new Promise(r => setTimeout(r, 5000))])
  }
  children = []
  if (workDir) {
    await rm(workDir, { recursive: true, force: true })
    workDir = null
  }
})

/** npm that exits 0. The scaffold is what this test checks, not the install. */
async function stubNpm(): Promise<string> {
  const binDir = join(workDir!, 'stub-bin')
  await mkdir(binDir, { recursive: true })
  const npmPath = join(binDir, 'npm')
  await writeFile(npmPath, '#!/bin/sh\nexit 0\n')
  await chmod(npmPath, 0o755)
  return binDir
}

function runInit(dir: string, binDir: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    const child = spawn(tsxBin, [cliPath, 'init', dir], {
      cwd: workDir!,
      env: { ...process.env, CI: 'true', PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stdout?.on('data', d => (output += d.toString()))
    child.stderr?.on('data', d => (output += d.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out waiting for init to exit\n${output}`))
    }, 60000)
    child.once('close', code => {
      clearTimeout(timer)
      resolvePromise({ code, output })
    })
  })
}

function templateFiles(siteDir: string): string[] {
  const templatesDir = join(siteDir, 'templates')
  return readdirSync(templatesDir).map(entry => join(templatesDir, entry, 'index.ts'))
}

function repoModule(moduleName: string): ts.ResolvedModuleFull | undefined {
  if (moduleName === 'gazetta') {
    return { resolvedFileName: gazettaTypes, extension: ts.Extension.Dts, isExternalLibraryImport: true }
  }
  if (moduleName === 'zod') {
    return { resolvedFileName: zodTypes, extension: ts.Extension.Dcts, isExternalLibraryImport: true }
  }
  return undefined
}

/** Strict-mode errors in the scaffolded templates. `gazetta` and `zod` come from this repo. */
function diagnose(rootNames: string[]): string[] {
  const host = ts.createCompilerHost(compilerOptions, true)
  host.resolveModuleNameLiterals = (moduleLiterals, containingFile) =>
    moduleLiterals.map(literal => {
      const pinned = repoModule(literal.text)
      if (pinned) return { resolvedModule: pinned }
      const resolved = ts.resolveModuleName(literal.text, containingFile, compilerOptions, host)
      return { resolvedModule: resolved.resolvedModule }
    })

  const program = ts.createProgram({ rootNames, options: compilerOptions, host })
  return ts
    .getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(diagnostic => {
      const file = diagnostic.file ? diagnostic.file.fileName : ''
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      return file ? `${file}: ${message}` : message
    })
}

describe('gazetta init template types (#1490)', () => {
  it('type-checks the scaffold, and a schema-unknown field is an error', async () => {
    workDir = tempDir(`init-template-types-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await mkdir(workDir, { recursive: true })
    const binDir = await stubNpm()
    const result = await runInit('my-site', binDir)
    expect(result.code, result.output).toBe(0)

    const siteDir = join(workDir, 'my-site')
    const files = templateFiles(siteDir)
    expect(files.map(file => file.slice(siteDir.length + 1)).sort()).toEqual([
      'templates/hero/index.ts',
      'templates/nav/index.ts',
      'templates/page-layout/index.ts',
      'templates/text-block/index.ts',
    ])

    expect(diagnose(files)).toEqual([])

    const heroPath = join(siteDir, 'templates/hero/index.ts')
    const hero = await readFile(heroPath, 'utf-8')
    expect(hero).toContain('content?.title')
    await writeFile(heroPath, hero.replace('content?.title', 'content?.titel'))

    expect(diagnose(files).some(message => message.includes('titel'))).toBe(true)
  }, 90000)
})

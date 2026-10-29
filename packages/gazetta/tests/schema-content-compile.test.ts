import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { tempDir } from './_helpers/temp.js'

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  types: [],
}
function errors(file: string) {
  const host = ts.createCompilerHost(options, true)
  const root = resolve(import.meta.dirname, '..')
  host.resolveModuleNameLiterals = (literals, containingFile) =>
    literals.map(literal => {
      const pinned =
        literal.text === 'gazetta'
          ? join(root, 'dist/index.d.ts')
          : literal.text === 'gazetta/schema'
            ? join(root, 'dist/schema/index.d.ts')
            : undefined
      return {
        resolvedModule: pinned
          ? { resolvedFileName: pinned, extension: ts.Extension.Dts, isExternalLibraryImport: true }
          : ts.resolveModuleName(literal.text, containingFile, options, host).resolvedModule,
      }
    })
  return ts
    .getPreEmitDiagnostics(ts.createProgram({ rootNames: [file], options, host }))
    .filter(d => d.category === ts.DiagnosticCategory.Error)
    .map(d => `${d.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
}
it('compiles schema inputs and optional, nullable, array and union asset shapes (#1348)', () => {
  expect(errors(resolve(import.meta.dirname, 'fixtures/content-types-1348.ts'))).toEqual([])
}, 30000)
it('compiles the actual migration guide optional-asset sample in strict mode', async () => {
  const doc = await readFile(resolve(import.meta.dirname, '../../../docs/migration.md'), 'utf8')
  const section = doc.split('### Optional asset')[1].split('### Required-alt enforcement')[0]
  const sample = section.match(/```ts\n([\s\S]*?)```/)![1]
  const dir = tempDir(`migration-optional-${Date.now()}`)
  await mkdir(dir, { recursive: true })
  try {
    const file = join(dir, 'sample.ts')
    await writeFile(file, sample)
    expect(errors(file)).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)

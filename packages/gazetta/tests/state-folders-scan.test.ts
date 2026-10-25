/**
 * Scan guard for the state-folder registry: no string or template
 * literal may name `.gazetta` as a path segment anywhere under
 * packages/gazetta/src except in state-folders.ts itself. Literals are
 * extracted with the TypeScript compiler API, so comments that mention
 * `.gazetta/` are allowed, and the segment boundary keeps
 * `.gazetta-deploy` (a temp-directory name, not the namespace) out.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '..', 'src')
const ALLOWLIST = new Set(['state-folders.ts'])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (entry.endsWith('.ts')) yield full
  }
}

function containsStateRootSegment(text: string): boolean {
  return /(^|\/)\.gazetta(\/|$)/.test(text)
}

function findStateRootLiterals(file: string, sourceText: string): Array<{ line: number; text: string }> {
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)
  const hits: Array<{ line: number; text: string }> = []
  const check = (text: string, pos: number) => {
    if (containsStateRootSegment(text)) {
      const { line } = source.getLineAndCharacterOfPosition(pos)
      hits.push({ line: line + 1, text })
    }
  }
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      check(node.text, node.getStart(source))
    } else if (ts.isTemplateExpression(node)) {
      check(node.head.text, node.getStart(source))
      for (const span of node.templateSpans) check(span.literal.text, span.literal.getStart(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe('state-folder registry scan', () => {
  it('flags no `.gazetta` path literal outside state-folders.ts', { timeout: 30000 }, () => {
    const offenders: string[] = []
    for (const file of walk(SRC_ROOT)) {
      if (ALLOWLIST.has(file.slice(SRC_ROOT.length + 1))) continue
      for (const hit of findStateRootLiterals(file, ts.sys.readFile(file) ?? '')) {
        offenders.push(
          `${relative(SRC_ROOT, file)}:${hit.line} names a .gazetta path - add an entry to the registry in state-folders.ts and build the path with stateFolderPath()`,
        )
      }
    }
    expect(offenders).toEqual([])
  })

  it('catches a literal in a sample file but not comments or .gazetta-deploy', () => {
    const sample = [
      `const a = '.gazetta/audit'`,
      `// writes under .gazetta/audit for real`,
      `const b = join(process.cwd(), '.gazetta-deploy')`,
      'const c = `.gazetta/${kind}`',
    ].join('\n')
    const hits = findStateRootLiterals('sample.ts', sample)
    expect(hits.map(h => h.line)).toEqual([1, 4])
  })
})

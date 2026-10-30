/**
 * The repository README is the first thing a visitor from GitHub reads
 * (docs/audits/website-and-channels.md, Stage 0 "GitHub README").
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf-8')
const REPO_BLOB = 'https://github.com/gazetta-studio/gazetta-studio/blob/main/'

/** Repo paths the README points at: Markdown link targets plus `docs/…` paths in prose and code blocks. */
function referencedRepoPaths(text: string): string[] {
  const paths = new Set<string>()
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const path = target.startsWith(REPO_BLOB) ? target.slice(REPO_BLOB.length) : target
    if (/^[a-z]+:/i.test(path) || path.startsWith('#')) continue
    paths.add(path.split('#')[0])
  }
  for (const [path] of text.matchAll(/\bdocs\/[\w./-]+\.md\b/g)) paths.add(path)
  return [...paths]
}

/** Paths in the "Project Structure" tree: `dir/` lines, and entries indented under them. */
function projectTreePaths(text: string): string[] {
  const section = text.split(/^## Project Structure$/m)[1]?.split(/^## /m)[0] ?? ''
  const block = section.match(/```\n([\s\S]*?)```/)?.[1] ?? ''
  const paths: string[] = []
  let dir = ''
  for (const line of block.split('\n')) {
    const name = line.trim().split(/\s+/)[0]
    if (!name) continue
    if (/^\S/.test(line)) dir = name
    else paths.push(dir + name)
  }
  return paths
}

describe('README', () => {
  it('points only at files that exist', () => {
    const missing = referencedRepoPaths(readme).filter(p => !existsSync(resolve(repoRoot, p)))
    expect(missing).toEqual([])
  })

  it('lists only folders and files that exist in its project structure', () => {
    const paths = projectTreePaths(readme)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter(p => !existsSync(resolve(repoRoot, p)))).toEqual([])
  })

  it('shows Contribute and "Try it" before the rest of the page', () => {
    const firstSection = readme.search(/^## /m)
    const tryIt = readme.indexOf('## Try it')
    expect(tryIt).toBe(firstSection)
    const contribute = readme.indexOf('CONTRIBUTING.md')
    expect(contribute).toBeGreaterThan(-1)
    expect(contribute).toBeLessThan(tryIt)
  })
})

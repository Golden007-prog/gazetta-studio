#!/usr/bin/env node
// Print a markdown coverage summary for a CI job summary:
//   node scripts/coverage-summary.mjs <coverage-summary.json> <title> >> "$GITHUB_STEP_SUMMARY"
// Report only; it never fails the job. Unit coverage misses code that runs
// in subprocesses, the browser (e2e) or Docker, so a low file can still be
// tested elsewhere.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

const [file, title = 'Coverage'] = process.argv.slice(2)
let summary
try {
  summary = JSON.parse(readFileSync(file, 'utf8'))
} catch {
  console.log(`### ${title}\n\nNo coverage report at \`${file}\`.\n`)
  process.exit(0)
}

const pct = n => `${n.pct}%`
const { total } = summary
const files = Object.entries(summary)
  .filter(([name]) => name !== 'total')
  .map(([name, s]) => ({ name: relative(process.cwd(), name), ...s, uncovered: s.lines.total - s.lines.covered }))
  .filter(f => f.uncovered > 0)
  .sort((a, b) => b.uncovered - a.uncovered)
  .slice(0, 15)

const lines = [
  `### ${title}`,
  '',
  `Lines **${pct(total.lines)}** · branches **${pct(total.branches)}** · functions **${pct(total.functions)}** (${total.lines.total} lines)`,
  '',
  'Unit tests only: code run in subprocesses, the browser (e2e) or Docker is not counted.',
  '',
  '| Uncovered lines | Lines | Branches | File |',
  '|---:|---:|---:|---|',
  ...files.map(f => `| ${f.uncovered} | ${pct(f.lines)} | ${pct(f.branches)} | \`${f.name}\` |`),
  '',
]
console.log(lines.join('\n'))

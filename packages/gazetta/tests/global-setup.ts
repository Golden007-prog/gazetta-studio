import { existsSync, readFileSync } from 'node:fs'

// The suite needs the built package: templates-scan.ts loads its worker from
// ../dist, and test site configs import `gazetta` by name, which resolves
// through package.json's exports to dist/*.js. Without a build those surface
// as unrelated stack traces, so stop at once with the fix instead. See #1361.
export default function setup() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const builtFiles = ['dist/templates-scan-worker.js']
  for (const entry of Object.values(pkg.exports ?? {})) {
    if (entry && typeof entry === 'object' && typeof entry.import === 'string') {
      builtFiles.push(entry.import.replace(/^\.\//, ''))
    }
  }
  const missing = builtFiles.filter(file => !existsSync(new URL(`../${file}`, import.meta.url)))
  if (missing.length > 0) {
    throw new Error(
      `The gazetta tests need the built package (missing: ${missing.join(', ')}). Run \`npm run build\` before the tests; rebuild after changing src.`,
    )
  }
}

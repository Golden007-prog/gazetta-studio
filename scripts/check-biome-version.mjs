#!/usr/bin/env node
// Fails when package.json's Biome version and biome.json's $schema disagree,
// so a version bump updates both, and rejects a version range that would let
// a contributor's newer Biome format differently from CI. See #1360.
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const biomeConfig = JSON.parse(readFileSync(new URL('../biome.json', import.meta.url), 'utf8'))

const dep = pkg.devDependencies?.['@biomejs/biome']
if (!dep) {
  console.error("@biomejs/biome is missing from package.json's devDependencies.")
  process.exit(1)
}
if (/^[^0-9]/.test(dep)) {
  console.error(
    `@biomejs/biome must be pinned to an exact version, found "${dep}". A range lets a newer Biome format differently from CI.`,
  )
  process.exit(1)
}

const match = /\/schemas\/(\d+\.\d+\.\d+)\/schema\.json$/.exec(biomeConfig.$schema ?? '')
if (!match) {
  console.error(`biome.json's $schema does not name a version: "${biomeConfig.$schema}".`)
  process.exit(1)
}
if (match[1] !== dep) {
  console.error(
    `Biome version mismatch: package.json pins ${dep}, but biome.json's $schema names ${match[1]}. Update both together.`,
  )
  process.exit(1)
}

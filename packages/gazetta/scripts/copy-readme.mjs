// prepack: copy the repo's README.md next to this package.json so the npm
// package page shows it. The root README stays the single source; the copy
// is gitignored. Runs on `npm pack` / `npm publish` with cwd = this package.
import { copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
copyFileSync(resolve(here, '../../../README.md'), resolve(here, '../README.md'))

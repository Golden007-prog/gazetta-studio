#!/usr/bin/env bash
# Lint .github/workflows/*.yml with actionlint. Used by the actionlint
# workflow and by `npm run lint:actions` locally, so both run the same
# pinned version. The binary is cached under node_modules/.cache.
#
# actionlint runs shellcheck on `run:` blocks when shellcheck is on PATH
# (preinstalled on GitHub's Ubuntu runners). Without it locally, those
# checks are skipped and CI still covers them.
set -euo pipefail

VERSION=1.7.12
DIR="node_modules/.cache/actionlint/$VERSION"

if [ ! -x "$DIR/actionlint" ]; then
  mkdir -p "$DIR"
  curl -sSfL "https://raw.githubusercontent.com/rhysd/actionlint/v$VERSION/scripts/download-actionlint.bash" \
    | bash -s -- "$VERSION" "$DIR" >"$DIR/download.log" 2>&1 \
    || { cat "$DIR/download.log" >&2; echo "actionlint download failed" >&2; exit 1; }
fi

exec "$DIR/actionlint" "$@"

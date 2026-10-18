#!/usr/bin/env bash
# Security-lint .github/workflows with zizmor. Used by the zizmor
# workflow and by `npm run lint:actions:security`, so both run the same
# pinned version. Config: .github/zizmor.yml.
#
# Online audits (impostor commits, known-vulnerable actions) need a token:
# CI passes GH_TOKEN; locally `GH_TOKEN=$(gh auth token)` enables them.
set -euo pipefail

VERSION=1.31.1

if command -v uvx >/dev/null; then
  exec uvx "zizmor@$VERSION" "$@" .github/workflows
fi
exec pipx run "zizmor==$VERSION" "$@" .github/workflows

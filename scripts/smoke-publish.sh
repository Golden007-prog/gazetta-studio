#!/usr/bin/env bash
#
# Smoke test for the gazetta npm package.
#
# Verifies the publish path end-to-end:
#   1. Install the gazetta tarball into a fresh temp project (via `gazetta init`)
#   2. Start `gazetta dev`
#   3. HTTP-check site root + admin + admin API
#
# Usage:
#   npm run smoke                    # build + pack locally, then test
#   GAZETTA_TARBALL=/path/to/*.tgz npm run smoke   # test against prebuilt tarball
#   SMOKE_PORT=4444 npm run smoke    # override port
#
# CI: pack once on linux, upload the tarball as an artifact, then let matrix
# jobs download the artifact and run `GAZETTA_TARBALL=... npm run smoke` on
# ubuntu/macos/windows. See .github/workflows/ci.yml.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-3999}"
SMOKE_DIR="$(mktemp -d -t gazetta-smoke-XXXXXX 2>/dev/null || mktemp -d)"

DEV_PID=""
BUILT_TARBALL=""

cleanup() {
  local exit_code=$?
  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -rf "$SMOKE_DIR"
  # Only delete the tarball we built ourselves — not one passed in via env
  [ -n "$BUILT_TARBALL" ] && rm -f "$BUILT_TARBALL"
  if [ "$exit_code" -ne 0 ]; then
    echo "✗ smoke failed (exit $exit_code)"
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ── 1. Obtain tarball ────────────────────────────────────────────
if [ -n "${GAZETTA_TARBALL:-}" ]; then
  step "Using provided tarball: $GAZETTA_TARBALL"
  TARBALL_ABS="$GAZETTA_TARBALL"
  [ -f "$TARBALL_ABS" ] || { echo "✗ tarball not found: $TARBALL_ABS"; exit 1; }
else
  step "Build gazetta package"
  cd "$REPO_ROOT"
  npm run build -w packages/gazetta
  npm run build:admin -w packages/gazetta

  step "npm pack"
  cd "$REPO_ROOT/packages/gazetta"
  TARBALL_NAME="$(npm pack --silent | tail -1)"
  TARBALL_ABS="$REPO_ROOT/packages/gazetta/$TARBALL_NAME"
  BUILT_TARBALL="$TARBALL_ABS"
  echo "tarball: $TARBALL_ABS"
fi

# ── 2. Init a fresh project using the tarball ────────────────────
step "gazetta init from tarball"
cd "$SMOKE_DIR"
npx --package="$TARBALL_ABS" -y gazetta init my-site

step "Install local tarball into generated project"
cd "$SMOKE_DIR/my-site"
# Overwrite admin/ and templates/ gazetta deps to use the tarball
for ws in admin templates; do
  if [ -d "$ws" ]; then
    (cd "$ws" && npm install "$TARBALL_ABS" --no-save --silent)
  fi
done

# ── 3. Start dev server ──────────────────────────────────────────
step "Start gazetta dev on port $PORT"
LOG="$SMOKE_DIR/dev.log"

# On Windows the bin is .cmd; elsewhere it's a symlink to the JS entry.
if [ -f "./node_modules/.bin/gazetta.cmd" ]; then
  GAZETTA_BIN="./node_modules/.bin/gazetta.cmd"
else
  GAZETTA_BIN="./node_modules/.bin/gazetta"
fi

"$GAZETTA_BIN" dev --port "$PORT" > "$LOG" 2>&1 &
DEV_PID=$!

# ── 4. Wait for ready (up to 30s) ───────────────────────────────
step "Waiting for server ready..."
for i in $(seq 1 60); do
  if curl -fs "http://localhost:$PORT/admin" > /dev/null 2>&1; then
    echo "ready after ${i} tries"
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "✗ dev server died — log:"
    cat "$LOG"
    exit 1
  fi
  sleep 0.5
done

# ── 4b. Start banner assertion (#1317) ──────────────────────────
# The packed install runs outside the monorepo, so `gazetta dev` serves the
# pre-built admin and its start banner must print the /admin URL. On code
# that prints the line only in monorepo dev mode this assertion fails.
step "Start banner assertion"
if ! grep -q "http://localhost:$PORT/admin" "$LOG"; then
  echo "✗ start banner does not print the /admin URL outside the monorepo"
  echo "--- dev log ---"
  cat "$LOG"
  exit 1
fi
echo "✓ start banner prints the /admin URL"

# ── 5. Assertions ────────────────────────────────────────────────
step "HTTP assertions"

body="$(curl -fsS "http://localhost:$PORT/" || true)"
if ! echo "$body" | grep -qi "<html"; then
  echo "✗ GET / did not return HTML"
  echo "body: ${body:0:200}"
  exit 1
fi
echo "✓ GET /"

body="$(curl -fsS "http://localhost:$PORT/admin" || true)"
if ! echo "$body" | grep -qi "<html"; then
  echo "✗ GET /admin did not return HTML"
  exit 1
fi
echo "✓ GET /admin"

body="$(curl -fsS "http://localhost:$PORT/admin/api/site" || true)"
if ! echo "$body" | grep -q "\"name\""; then
  echo "✗ GET /admin/api/site did not return site manifest"
  echo "body: $body"
  exit 1
fi
echo "✓ GET /admin/api/site"

body="$(curl -fsS "http://localhost:$PORT/admin/api/pages" || true)"
if ! echo "$body" | grep -q "home"; then
  echo "✗ GET /admin/api/pages did not list the home page"
  echo "body: $body"
  exit 1
fi
echo "✓ GET /admin/api/pages"

echo ""
echo "✓ smoke passed — tarball produces a working package"

/**
 * Pins the reviewer-log cache strategy across all four memoryful-bot
 * workflows. `actions/cache@v4`/`@v5` skips its post-step save on a
 * cache HIT against the primary key — by design, but it breaks the
 * append-write-back pattern the bots rely on (every run after the
 * first reads N entries, appends 1, but never persists the new entry
 * because the primary key already exists). See issue #581.
 *
 * The fix is the standard `restore` + `save` split with a per-run
 * unique save key, so every run produces its own immutable cache
 * entry and the restore step finds the latest via `restore-keys`
 * prefix match.
 *
 * These tests fail before the fix (every workflow uses the single
 * combined `actions/cache@v4` shape) and pass after.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')

const BOTS = [
  { name: 'fix-bot', logPath: 'bots/fix-bot/reviewer-log.jsonl' },
  { name: 'feature-bot', logPath: 'bots/feature-bot/reviewer-log.jsonl' },
  { name: 'dead-code-watcher', logPath: 'bots/dead-code-watcher/reviewer-log.jsonl' },
  { name: 'review-bot', logPath: 'bots/review-bot/reviewer-log.jsonl' },
  { name: 'mutation-area-picker', logPath: 'bots/mutation-area-picker/reviewer-log.jsonl' },
] as const

describe('memoryful bots — reviewer-log cache strategy', () => {
  for (const bot of BOTS) {
    describe(bot.name, () => {
      const yaml = readFileSync(resolve(REPO, '.github', 'workflows', `${bot.name}.yml`), 'utf-8')

      it('uses actions/cache/restore (not combined actions/cache) for the reviewer-log', () => {
        // The combined `actions/cache@vN` step skips save on cache-hit.
        // Issue #581 — using the split restore/save pair is the fix.
        const restoresLog = /uses:\s*actions\/cache\/restore@\S+[\s\S]{0,200}reviewer-log\.jsonl/.test(yaml)
        expect(restoresLog, `${bot.name}.yml must restore the reviewer-log via actions/cache/restore@vN`).toBe(true)
      })

      it('has an always-running actions/cache/save step for the reviewer-log', () => {
        // The save step must use `if: always()` so it runs even when
        // the bot run itself fails — losing the log on bot-failure
        // would silently lose Agent B verdicts that informed the
        // failure path.
        const savesLog =
          /uses:\s*actions\/cache\/save@\S+[\s\S]{0,400}reviewer-log\.jsonl/.test(yaml) && /if:\s*always\(\)/.test(yaml)
        expect(savesLog, `${bot.name}.yml must save the reviewer-log via actions/cache/save@vN with if: always()`).toBe(
          true,
        )
      })

      it('uses a per-run save key (run-id or run-attempt suffix)', () => {
        // Per-run keys make every save succeed (the primary key is
        // unique). The restore step finds the latest via restore-keys
        // prefix match. Without a per-run suffix, the same cache-hit-
        // skip-save trap returns.
        const savesWithPerRunKey =
          /uses:\s*actions\/cache\/save@\S+[\s\S]{0,400}key:\s*[^\n]*\$\{\{\s*github\.run_id\s*\}\}/.test(yaml)
        expect(
          savesWithPerRunKey,
          `${bot.name}.yml save step must use a per-run key (e.g. {bot}-reviewer-log-v1-\${{ github.run_id }})`,
        ).toBe(true)
      })

      it('declares restore-keys prefix-match for cross-run lookup', () => {
        // Restore must match against the static prefix so a run can
        // find the most-recently-written entry from any prior run.
        // Without restore-keys, every run starts with an empty log.
        expect(yaml, `${bot.name}.yml restore step must declare restore-keys for prefix match`).toMatch(
          /restore-keys:\s*\|?[\s\S]{0,200}reviewer-log-v1/,
        )
      })

      it('primary restore key is per-run (not the stale static key) — issue #582 follow-up', () => {
        // Original fix used `key: {bot}-reviewer-log-v1` (static). That
        // triggers actions/cache's exact-key match against the old
        // pre-fix cache blob (written before we split restore+save),
        // which still lives in the cache. Exact-key match wins over
        // restore-keys prefix match, so the per-run save entries are
        // never read.
        //
        // The fix: rotate the primary `key` to a per-run value that
        // NEVER exists at restore time, forcing fall-through to
        // restore-keys. The restore-keys prefix then finds the latest
        // per-run save entry.
        //
        // Verified live: 06-14, 06-21, 06-28 mutation-area-picker
        // runs all restored 467-byte 1-entry blob from the old key.
        const restoreKeyIsPerRun =
          /uses:\s*actions\/cache\/restore@\S+[\s\S]{0,400}key:\s*[^\n]*\$\{\{\s*github\.run_id\s*\}\}/.test(yaml)
        expect(
          restoreKeyIsPerRun,
          `${bot.name}.yml restore step's primary key must be per-run (contains \${{ github.run_id }}) so it always falls through to restore-keys`,
        ).toBe(true)
      })

      it('restore-keys prefix ends with a hyphen (so it matches -${run_id} suffix)', () => {
        // restore-keys prefix `{bot}-reviewer-log-v1` (no trailing
        // hyphen) is ambiguous — it would match both the old static
        // `{bot}-reviewer-log-v1` blob AND the per-run
        // `{bot}-reviewer-log-v1-{run_id}` entries. GitHub returns the
        // most-recent match, but the old blob interference is real
        // (see 06-14 through 06-28 mutation-area-picker runs).
        //
        // Adding the trailing hyphen (`{bot}-reviewer-log-v1-`) makes
        // the intent explicit: match only per-run entries.
        const bulletMatch = yaml.match(/restore-keys:\s*\|([\s\S]*?)\n\n/)
        expect(bulletMatch, `${bot.name}.yml restore-keys block missing`).toBeTruthy()
        const restoreKeys = bulletMatch![1]
        expect(
          restoreKeys,
          `${bot.name}.yml restore-keys prefix must end with '-' to disambiguate old static key`,
        ).toMatch(/reviewer-log-v1-\s*$/m)
      })

      it('does NOT use the combined actions/cache@vN for the reviewer-log', () => {
        // Belt-and-suspenders: the combined `actions/cache@vN` shape
        // is the broken pattern. Even if restore+save are also
        // declared, leaving the combined step would still hit the
        // cache-hit-skip-save trap on its own save invocation.
        const combinedShape = new RegExp(`uses:\\s*actions/cache@\\S+[\\s\\S]{0,200}reviewer-log\\.jsonl`)
        expect(combinedShape.test(yaml), `${bot.name}.yml must not use combined actions/cache@vN`).toBe(false)
      })
    })
  }
})

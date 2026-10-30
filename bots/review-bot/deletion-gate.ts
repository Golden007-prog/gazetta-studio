/**
 * Deletion-only gate for the mechanical-cleanup recipe.
 *
 * That recipe has no counterfactual, so its safety rests on the diff
 * being pure deletion. The orchestrator checks this mechanically on
 * Agent A's branch before Agent B runs, rather than trusting Agent A's
 * own claim.
 */

export type DeletionGateResult = { ok: true } | { ok: false; reason: string }

/**
 * Judge `git diff --numstat` output. Any added line, binary change or
 * empty diff fails: an added line means the change did more than
 * delete, and an empty diff deletes nothing.
 */
export function checkDeletionOnly(numstat: string): DeletionGateResult {
  const rows = numstat
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  if (rows.length === 0) return { ok: false, reason: 'the branch changes no files' }

  const offending: string[] = []
  for (const row of rows) {
    const [added, , ...pathParts] = row.split('\t')
    const path = pathParts.join('\t')
    if (added === '-') offending.push(`${path} (binary change)`)
    else if (Number(added) !== 0) offending.push(`${path} (+${added})`)
  }
  if (offending.length > 0) {
    return {
      ok: false,
      reason: `mechanical-cleanup diffs may only delete lines, but these files add lines: ${offending.join(', ')}`,
    }
  }
  return { ok: true }
}

/**
 * Compose a planning prompt from the mode template + shared fragments.
 *
 * Pure: the templates are passed in, so tests run without touching disk.
 *
 * Substitution is a SINGLE pass over the assembled template. Sequential
 * `replaceAll` calls would re-scan text that was already inserted, so an
 * issue body that happens to contain `$FEATURE` (or `$CUT_BODY`) would be
 * rewritten. Inserted values are never scanned again here.
 */
import type { PlanContext } from './execute.js'
import type { Mode } from './plan-output.js'

export interface PromptTemplates {
  context: string
  contract: string
  /** `lessons-learned.md` (Q7a's distilled tier), loaded into every prompt. */
  lessons: string
  modes: Record<Mode, string>
}

const NONE = '_(none)_'

export function composePrompt(t: PromptTemplates, mode: Mode, c: PlanContext): string {
  const assembled = t.modes[mode].replace('$CONTEXT', () => t.context).replace('$CONTRACT', () => t.contract)
  const vars: Record<string, string> = {
    PLANNER_ISSUE: String(c.plannerIssueNumber),
    FEATURE: c.planner.feature,
    DESIGN_PATH: c.planner.designPath,
    SUGGESTED_PLAN: c.planner.suggestedPlan.trim() || NONE,
    STATE: c.planner.state.trim() || '_(nothing has landed yet)_',
    LOCKS: c.locks.length > 0 ? c.locks.map((l, i) => `${i}. ${l}`).join('\n') : NONE,
    CUT_NUMBER: c.cut ? String(c.cut.number) : '',
    CUT_TITLE: c.cut?.title ?? '',
    CUT_BODY: c.cut?.body ?? '',
    LESSONS: t.lessons.trim() || NONE,
    REVIEWER_NOTE: c.cut?.reviewerNote?.trim() || '_(no reviewer verdict was found on the cut)_',
  }
  return assembled.replace(/\$([A-Z_]+)/g, (m, name: string) => (name in vars ? vars[name] : m))
}

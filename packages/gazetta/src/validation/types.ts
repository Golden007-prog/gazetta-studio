import type { ComponentEntry, PageManifest, FragmentManifest, StorageProvider } from '../types.js'
import type { Site } from '../site-loader.js'
import type { ContentRoot } from '../content-root.js'

/**
 * Lifecycle stages a validator can run at. Per design-validation.md,
 * these correspond to the four-phase model.
 */
export type ValidationStage = 'save-delta' | 'background' | 'pre-publish' | 'cli'

/**
 * Severity of a single issue. Per stage, validators declare a default;
 * operators can promote/demote at the publish gate (Cut 4).
 */
type Severity = 'error' | 'warn' | 'info'

/**
 * One validation finding. Stable shape across all validators and stages.
 */
export interface Issue {
  /** Stable identifier of the validator that produced this issue. */
  validator: string
  severity: Severity
  /** Human-readable message. Author-facing. */
  message: string
  /** Item path like `pages/home/page.json`. */
  itemPath: string
  /** Content-tree path within the manifest, when applicable. */
  contentPath?: string
  /**
   * Optional structured suppression hint — `Issue.suppressible: true`
   * means a future "ignore this issue" mechanism would apply.
   */
  suppressible?: boolean
}

/**
 * Stage-specific scope. Validators dispatch on `scope.kind` to read the right input.
 *
 * - `save-delta`: a single item (page or fragment) being saved, with before+after.
 * - `background`: a single item being scanned (after the scanner has detected change).
 * - `pre-publish`: the set of items being published, all together.
 * - `cli`: site-wide; validator iterates everything.
 */
type ValidatorScope =
  | {
      kind: 'save-delta'
      item: SavedItem
      /** The on-disk manifest before this save (null when creating a new item). */
      before: PageManifest | FragmentManifest | null
      /** The incoming manifest being saved. */
      after: PageManifest | FragmentManifest
    }
  | {
      kind: 'background'
      item: SavedItem
      /**
       * The current manifest read by the scanner. Pre-loaded so validators
       * stay pure functions over (manifest, site) — no per-validator storage
       * reads.
       */
      manifest: PageManifest | FragmentManifest
    }
  | { kind: 'pre-publish'; items: readonly SavedItem[] }
  | { kind: 'cli' }

/**
 * Identifies a page or fragment item. The validator framework treats them
 * uniformly for stage dispatch; validators that only apply to one or the other
 * branch on `kind`.
 */
export interface SavedItem {
  kind: 'page' | 'fragment'
  /** Logical name, e.g. `home`, `blog/[slug]`, `header`. */
  name: string
  /** Requested rendering locale; its manifest may use the publisher's fallback. */
  locale?: string
  /** Filesystem path to the manifest, e.g. `pages/home/page.json`. */
  itemPath: string
}

/**
 * Hook for cached rendered HTML output. Populated by Cut 3 (render-for-analysis);
 * absent in Cut 1 (save-delta), so validators must guard against undefined.
 */
export interface RenderedOutputAccess {
  htmlFor(item: SavedItem): Promise<string | null>
}

/**
 * Inputs every validator receives. Stage-specific data lives in `scope`;
 * validators that don't care about a stage simply don't include it in `stages`
 * and won't be invoked.
 */
export interface ValidatorInput {
  stage: ValidationStage
  site: Site
  contentRoot: ContentRoot
  storage: StorageProvider
  scope: ValidatorScope
  renderedOutput?: RenderedOutputAccess
}

/**
 * The validator contract. One implementation per validation rule.
 *
 * - `source` — package identity for diagnostics + audit + plugin-promotion.
 *   In-tree validators use `'gazetta'`; npm-distributed validators use their
 *   package name (`'@example/link-checker'`); site-local factories use
 *   `'site-local:{name}'`. Per design-plugins.md "source convention" + ADR-0009.
 * - `name` — stable identifier referenced from issues and registry lookup.
 * - `stages` — which lifecycle stages this validator runs at. Save-delta-only
 *   validators (most ref-existence checks) declare `['save-delta', 'background', 'pre-publish', 'cli']`
 *   so the same rule fires uniformly at every gate.
 * - `defaultSeverity(stage)` — what severity issues from this validator have
 *   at the given stage. The same rule may be `error` at save-delta but `warn`
 *   in background to avoid false-positive blocks on accumulated debt.
 * - `validate(input)` — run the rule. Never throws on validation failure;
 *   throws are reserved for infrastructure errors (storage failure, etc).
 */
export interface Validator {
  readonly source: string
  readonly name: string
  readonly stages: readonly ValidationStage[]
  defaultSeverity(stage: ValidationStage): Severity
  validate(input: ValidatorInput): Promise<Issue[]>
}

/**
 * Helper — extract the components array from a manifest, defaulting to empty.
 */
export function manifestComponents(manifest: PageManifest | FragmentManifest | null): readonly ComponentEntry[] {
  return manifest?.components ?? []
}

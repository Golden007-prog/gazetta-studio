/**
 * Audit types — the durable forensic record shape consumed by every
 * `AuditProvider` implementation.
 *
 * # Why these types live here
 *
 * Per `design-audit.md`'s "history-recorder is the foundation"
 * invariant, the audit log extends the existing `Revision` shape
 * with `actor` + `outcome` fields. The types here are the wire
 * shape every provider speaks; in-tree `HistoryAuditProvider`
 * (Cut 2) and external-sink providers (v2 webhook, file, OTel,
 * CloudWatch, Azure Monitor, syslog) all consume `AuditEvent`.
 *
 * # Outcome is required
 *
 * Per the locked invariant: "no implicit 'default to success' —
 * recording sites supply outcome explicitly. Cuts a class of 'I
 * forgot to record the failure' bugs." The closed enum stays
 * closed (future additions like `'rate-limited'`, `'session-expired'`
 * extend the enum, not the wire shape).
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the event vocabulary. Doesn't read
 *     storage; pure data shapes.
 *   - DIP: providers, recorder, drawer all depend on these types
 *     — never on which specific provider produced an event.
 *   - LSP: every `AuditProvider` returns events shaped by these
 *     types; consumers branch only on `outcome` / `action` for
 *     behavior, never on which provider produced the data.
 */

/**
 * Closed enum of action verbs Gazetta records. Per `design-audit.md`
 * "Recording scope (v1)": save / publish / delete / restore at the
 * content level + configure-roles for role-mapping changes in
 * site.config.ts. `hook-fired` extends per design-hooks.md Cut 7.
 *
 * Soft-delete (per design-soft-delete.md Q8) extends with
 * `archive` / `unarchive` / `purge` / `rename` — each maps to one
 * user action; `rename` is recorded as a single composite event with
 * `metadata.fromName` for forensic reconstruction (per Q8 M4 lock).
 *
 * Redirect UI (per design-redirect-ui.md Q7) extends with
 * `create-redirect` — Manual Redirect creation (standalone, not
 * composed during a rename). The closed-enum discriminator over
 * `metadata.manual: true` keeps `AuditQuery.action` forensic queries
 * reliable ("show all manual redirects last week").
 *
 * Review workflow (per design-review-workflow.md "Audit event shape")
 * extends with `review-submit` / `review-approve` / `review-reject` —
 * each maps to one user-driven content-review transition. The fourth
 * transition `review-withdraw` was added earlier by soft-delete Cut 14
 * (synthetic auto-withdraw on archive); it's the same forensic shape
 * (one action verb per transition) and review-workflow reuses it for
 * the submitter's manual withdraw. `metadata.comment` carries the
 * rejection reason on `review-reject` (mandatory per the locked
 * single-reject-with-comment invariant).
 */
export type AuditAction =
  | 'save'
  | 'publish'
  | 'delete'
  | 'restore'
  | 'configure-roles'
  | 'hook-fired'
  | 'archive'
  | 'unarchive'
  | 'purge'
  | 'rename'
  | 'review-submit'
  | 'review-approve'
  | 'review-reject'
  | 'review-withdraw'
  | 'ai-suggest-alt'
  | 'create-redirect'
  | 'upload'

/**
 * Closed enum of outcomes. Locked: every recording site supplies
 * outcome explicitly. The four listed cover write attempts;
 * v2 ambient-log expansion ('read', 'hook-cancelled') stays
 * closed-enum.
 */
export type AuditOutcome =
  | 'success'
  | 'forbidden'
  | 'validation-failed'
  | 'unauthenticated'
  | 'hook-cancelled'
  | 'timeout'
  | 'write-failed'

/**
 * Snapshot of the principal at decision time — never a live
 * reference. Subsequent role changes don't rewrite history.
 */
export interface AuditActor {
  /**
   * Upstream stable subject (OIDC `sub`, Cloudflare Access
   * `identity_nonce`, etc.) — NOT email. Email rotates; sub is
   * stable. When `admin.audit.actorPseudonym: 'sha256'` is
   * configured (Cut 4), this field is the salted hash prefix.
   * `'unknown'` for pre-RBAC revisions or `none`-mode deployments.
   */
  id: string
  /**
   * Optional human-readable identifier. Redacted to undefined when
   * pseudonymization is enabled (low-entropy email gives weak
   * pseudonymization).
   */
  email?: string
  /** Resolved Gazetta role at decision time. */
  role: string
  /**
   * Trust mode that produced this principal. Open string (not the
   * `TrustMode` enum) so plugin-supplied modes can carry their own
   * names without widening this type.
   */
  trustMode: string
}

/**
 * What was acted on. Keeps the audit query layer simple — consumers
 * filter by `kind` + optional `name`.
 */
export interface AuditScope {
  kind: 'page' | 'fragment' | 'asset' | 'site'
  /** Item name when applicable (page name, fragment name, etc.). */
  name?: string
}

/**
 * The wire shape every provider speaks. Every event records actor
 * identity + action + outcome + scope; optional sourceIp / userAgent
 * are operator-opt-in per Cut 4's privacy posture.
 */
export interface AuditEvent {
  /** ISO 8601 with Z suffix. Matches the existing history-recorder convention. */
  timestamp: string
  /** Snapshot of the actor at decision time. */
  actor: AuditActor
  /** Closed-enum action verb. */
  action: AuditAction
  /** Closed-enum outcome. Required — no implicit default. */
  outcome: AuditOutcome
  /** What was acted on. */
  scope: AuditScope
  /**
   * Source IP when `admin.audit.recordSourceIp` is configured.
   * Truncation / pseudonymization happens at recording time per
   * the operator's mode setting (Cut 4).
   */
  sourceIp?: string
  /**
   * User agent when `admin.audit.recordUserAgent` is configured.
   * Cut 4 supports raw / truncated modes; default is none.
   */
  userAgent?: string
  /**
   * Provider-specific extras. Examples: publish source target +
   * destination, restore revision id, `missingCapabilities` for
   * forbidden outcomes, `comment` for failure-mode events.
   */
  metadata?: Record<string, unknown>
}

/**
 * Filter shape consumed by `AuditProvider.query()`. Open enums
 * because filter values come from URL query params; the server
 * validates each field against the audit-event closed enums.
 */
export interface AuditQuery {
  /** Match against `actor.id` or `actor.email` (case-insensitive substring). */
  actor?: string
  action?: AuditAction
  outcome?: AuditOutcome
  scope?: { kind?: AuditScope['kind']; name?: string }
  /** ISO 8601 timestamp lower bound (inclusive). */
  since?: string
  /** ISO 8601 timestamp upper bound (exclusive). */
  until?: string
  /** Max events returned. Default 100; provider may cap further. */
  limit?: number
}

/**
 * Cut #516 tests: review-workflow capability vocabulary wired
 * into RBAC. Pins the four design-review-workflow.md
 * "Capability additions" entries (`review:submit`, `review:approve`,
 * `publish:request`, `publish:approve`) at the vocabulary, the
 * config-load validation layer, the built-in `editor` role, and
 * the resolver — verifying operators can define `reviewer`
 * (and `publisher`) as CUSTOM roles without re-litigating
 * `BUILT_IN_ROLES`.
 *
 * Why the regression guards on `BUILT_IN_ROLES` keys: per
 * design-auth-rbac.md's foundational lock, the built-in set is
 * exactly `{ admin, editor, viewer }`. `reviewer` / `publisher`
 * are operator-facing archetype names (per
 * design-review-workflow.md "Workflow archetypes"); they're
 * EXAMPLES of custom roles, not additions to the closed
 * built-in set.
 */
import { describe, expect, it } from 'vitest'
import {
  AuthConfigSchema,
  BUILT_IN_ROLES,
  capabilityGrants,
  expandRole,
  KNOWN_CAPABILITIES,
  resolveRole,
  validateCustomRoles,
} from '../src/auth/index.js'

describe('Cut #516 — review-workflow capability vocabulary', () => {
  describe('config-load validation accepts the four new capabilities', () => {
    it.each([['review:submit'], ['review:approve'], ['publish:request'], ['publish:approve']])(
      'AuthConfigSchema accepts a custom role declaring %s',
      cap => {
        const parsed = AuthConfigSchema.safeParse({
          trust: 'none',
          roles: {
            opCustom: { capabilities: [cap] },
          },
        })
        expect(parsed.success).toBe(true)
      },
    )

    it('validateCustomRoles passes with all four capabilities declared together', () => {
      const issues = validateCustomRoles({
        omnirole: ['review:submit', 'review:approve', 'publish:request', 'publish:approve'],
      })
      expect(issues).toEqual([])
    })

    // The symmetric rejection: if the four new known ones land
    // without locking the vocabulary's closure, `review:foo`
    // would sneak through and silently grant nothing while the
    // operator believes it does. Same for every other reserved
    // prefix (`publish:foo`, `edit:nonsense`, etc.).
    it.each([['review:foo'], ['publish:foo'], ['review:bar'], ['edit:nonsense'], ['read:made-up']])(
      'rejects %s as unknown via validateCustomRoles',
      cap => {
        const issues = validateCustomRoles({ broken: [cap] })
        expect(issues).toHaveLength(1)
        expect(issues[0]).toContain(cap)
        expect(issues[0]).toContain('unknown capability')
      },
    )

    it('reports one issue per unknown capability when a role declares several', () => {
      // Each bad cap surfaces separately so operators see every
      // problem in one pass rather than fixing one and re-running.
      const issues = validateCustomRoles({
        broken: ['review:foo', 'publish:bar', 'read:nonsense'],
      })
      expect(issues).toHaveLength(3)
      expect(issues.join(' ')).toContain('review:foo')
      expect(issues.join(' ')).toContain('publish:bar')
      expect(issues.join(' ')).toContain('read:nonsense')
    })

    it('reports BOTH name-conflict and unknown-cap when they coexist on the same role', () => {
      // A custom role that re-declares `admin` AND uses
      // `review:foo` should surface both issues — the name
      // conflict isn't a short-circuit that skips capability
      // validation.
      const issues = validateCustomRoles({ admin: ['review:foo'] })
      expect(issues).toHaveLength(2)
      expect(issues.some(i => i.includes('built-in'))).toBe(true)
      expect(issues.some(i => i.includes('unknown capability'))).toBe(true)
    })

    it('mixes known + unknown caps: only the unknown is flagged', () => {
      const issues = validateCustomRoles({ partial: ['review:approve', 'review:foo'] })
      expect(issues).toHaveLength(1)
      expect(issues[0]).toContain('review:foo')
    })

    it('plugin-scoped capabilities are NOT validated against KNOWN_CAPABILITIES', () => {
      // Plugin-scoped (`@scope/name:action`) lives outside Gazetta's
      // reserved prefixes — operators bring their own vocabulary.
      const issues = validateCustomRoles({
        searcher: ['@my-org/search:rebuild-index', '@my-org/search:*'],
      })
      expect(issues).toEqual([])
    })

    it('KNOWN_CAPABILITIES contains the four new capabilities', () => {
      // Regression guard: future refactors that move the vocabulary
      // around (e.g., split per-domain) must keep these four entries
      // findable via the public Set, since `validateCustomRoles`
      // gates on it.
      expect(KNOWN_CAPABILITIES.has('review:submit')).toBe(true)
      expect(KNOWN_CAPABILITIES.has('review:approve')).toBe(true)
      expect(KNOWN_CAPABILITIES.has('publish:request')).toBe(true)
      expect(KNOWN_CAPABILITIES.has('publish:approve')).toBe(true)
    })
  })

  describe('editor built-in role gains review:submit', () => {
    it('expandRole("editor") includes review:submit', () => {
      const caps = expandRole('editor')
      expect(caps).toContain('review:submit')
    })

    it('editor does NOT carry review:approve (custom-role concern)', () => {
      // Per design-review-workflow.md: `review:approve` lives on a
      // custom `reviewer` role, not on the editor built-in. The
      // editor archetype submits; a separate reviewer archetype
      // approves.
      const caps = expandRole('editor') ?? []
      expect(caps).not.toContain('review:approve')
    })

    it('editor does NOT carry publish:request / publish:approve', () => {
      // These pair with `requiresPublishApproval` workflows — a
      // distinct archetype (publisher) per design-review-workflow.md.
      const caps = expandRole('editor') ?? []
      expect(caps).not.toContain('publish:request')
      expect(caps).not.toContain('publish:approve')
    })

    it('capabilityGrants resolves review:submit for the editor capability set', () => {
      // The intended consumption surface — middleware calls
      // `capabilityGrants(principal.capabilities, 'review:submit')`
      // against the editor role's expanded set.
      expect(capabilityGrants(BUILT_IN_ROLES.editor, 'review:submit')).toBe(true)
    })

    it('editor still cannot approve, request, or publish-approve via existing wildcards', () => {
      expect(capabilityGrants(BUILT_IN_ROLES.editor, 'review:approve')).toBe(false)
      expect(capabilityGrants(BUILT_IN_ROLES.editor, 'publish:request')).toBe(false)
      expect(capabilityGrants(BUILT_IN_ROLES.editor, 'publish:approve')).toBe(false)
    })
  })

  describe('BUILT_IN_ROLES regression guard', () => {
    // The foundational lock from design-auth-rbac.md line 136:
    // built-in roles are EXACTLY admin / editor / viewer. The
    // archetypes B–E in design-review-workflow.md name `reviewer`
    // and `publisher` — but those are CUSTOM roles operators
    // declare in `site.config.ts admin.auth.roles`, not built-ins.
    // Re-adding them here would break the lock + downstream
    // assumptions (the resolver's "custom roles can't shadow
    // built-ins" guard would silently bind operator-declared
    // `reviewer` to the built-in, and audit consumers querying by
    // role would see a closed-set value where they expected open).
    it('keys are exactly {admin, editor, viewer}', () => {
      expect(Object.keys(BUILT_IN_ROLES).sort()).toEqual(['admin', 'editor', 'viewer'])
    })

    it('reviewer is NOT a built-in role', () => {
      expect(Object.keys(BUILT_IN_ROLES)).not.toContain('reviewer')
      expect(expandRole('reviewer')).toBeNull()
    })

    it('publisher is NOT a built-in role', () => {
      expect(Object.keys(BUILT_IN_ROLES)).not.toContain('publisher')
      expect(expandRole('publisher')).toBeNull()
    })
  })

  describe('custom-role definitions for reviewer / publisher archetypes', () => {
    // Per design-review-workflow.md "Workflow archetypes": each
    // archetype is realized by operator-declared custom roles
    // carrying the matching capabilities. The vocabulary
    // additions in this cut are what makes those archetypes
    // expressible WITHOUT extending BUILT_IN_ROLES.

    it('custom reviewer role with review:approve validates without issues', () => {
      const issues = validateCustomRoles({
        reviewer: ['read:pages', 'read:fragments', 'review:approve'],
      })
      expect(issues).toEqual([])
    })

    it('custom publisher role with publish:request + publish:approve validates without issues', () => {
      const issues = validateCustomRoles({
        publisher: ['read:pages', 'publish:request', 'publish:approve'],
      })
      expect(issues).toEqual([])
    })

    it('resolveRole binds an operator-declared reviewer role to its capabilities', () => {
      const result = resolveRole({
        groups: ['gazetta-reviewers'],
        mapping: {
          claim: 'groups',
          map: { 'gazetta-reviewers': 'reviewer' },
        },
        customRoles: {
          reviewer: ['read:pages', 'read:fragments', 'review:approve'],
        },
      })
      expect(result?.name).toBe('reviewer')
      expect(result?.capabilities).toContain('review:approve')
    })

    it('resolveRole binds an operator-declared publisher role to its capabilities', () => {
      const result = resolveRole({
        groups: ['gazetta-publishers'],
        mapping: {
          claim: 'groups',
          map: { 'gazetta-publishers': 'publisher' },
        },
        customRoles: {
          publisher: ['read:pages', 'publish:request', 'publish:approve'],
        },
      })
      expect(result?.name).toBe('publisher')
      expect(result?.capabilities).toContain('publish:request')
      expect(result?.capabilities).toContain('publish:approve')
    })

    it('a resolved reviewer principal can approve and submit but not edit', () => {
      // Compose the full picture: the operator-defined reviewer
      // archetype's effective capability set behaves as
      // design-review-workflow.md describes when consumed via
      // capabilityGrants (the same call middleware makes for
      // every gate).
      const result = resolveRole({
        groups: ['gazetta-reviewers'],
        mapping: { claim: 'groups', map: { 'gazetta-reviewers': 'reviewer' } },
        customRoles: {
          reviewer: ['read:pages', 'read:fragments', 'review:submit', 'review:approve'],
        },
      })
      expect(result).not.toBeNull()
      const caps = result!.capabilities
      expect(capabilityGrants(caps, 'review:submit')).toBe(true)
      expect(capabilityGrants(caps, 'review:approve')).toBe(true)
      expect(capabilityGrants(caps, 'read:pages')).toBe(true)
      expect(capabilityGrants(caps, 'edit:pages')).toBe(false)
    })
  })

  describe('capabilityGrants over built-in + custom mappings', () => {
    it('admin (root wildcard) grants every new capability', () => {
      expect(capabilityGrants(BUILT_IN_ROLES.admin, 'review:submit')).toBe(true)
      expect(capabilityGrants(BUILT_IN_ROLES.admin, 'review:approve')).toBe(true)
      expect(capabilityGrants(BUILT_IN_ROLES.admin, 'publish:request')).toBe(true)
      expect(capabilityGrants(BUILT_IN_ROLES.admin, 'publish:approve')).toBe(true)
    })

    it('viewer grants none of the new capabilities', () => {
      expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'review:submit')).toBe(false)
      expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'review:approve')).toBe(false)
      expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'publish:request')).toBe(false)
      expect(capabilityGrants(BUILT_IN_ROLES.viewer, 'publish:approve')).toBe(false)
    })

    it('review:* prefix wildcard grants every review capability', () => {
      // Pins the wildcard semantic for `review:*` — operators who
      // grant a custom role `review:*` (full reviewer + submitter)
      // get both transitions.
      expect(capabilityGrants(['review:*'], 'review:submit')).toBe(true)
      expect(capabilityGrants(['review:*'], 'review:approve')).toBe(true)
      expect(capabilityGrants(['review:*'], 'edit:pages')).toBe(false)
    })

    it('publish:* prefix wildcard grants publish:request and publish:approve', () => {
      expect(capabilityGrants(['publish:*'], 'publish:request')).toBe(true)
      expect(capabilityGrants(['publish:*'], 'publish:approve')).toBe(true)
      expect(capabilityGrants(['publish:*'], 'publish:non-production')).toBe(true)
      expect(capabilityGrants(['publish:*'], 'publish:production')).toBe(true)
    })
  })
})

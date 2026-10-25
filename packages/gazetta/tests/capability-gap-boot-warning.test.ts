/**
 * #1305: the boot capability-gap warning fires only once the site has at
 * least one archived page. On a fresh `gazetta init` site nothing is
 * archived, so `gazetta dev` must boot without the warning; the gap still
 * shows in the archive dialog, site health and the publish check.
 *
 * The no-archived-pages test fails on code that warns per gapped target
 * regardless of archive state.
 */
import { describe, expect, it, vi } from 'vitest'
import { warnOnCapabilityGaps } from '../src/runtime/capability-gap-warnings.js'
import type { SiteManifest, TargetConfig } from '../src/types.js'

// Plain-static target (type=static, no worker, no redirects.format):
// inspectTarget flags it for both 'redirects' and 'gone-status' gaps.
const targets: Record<string, TargetConfig> = {
  'plain-static': {
    type: 'static',
    environment: 'production',
  } as TargetConfig,
}
const manifest = { name: 'test-site', targets } as SiteManifest

describe('boot capability-gap warning (#1305)', () => {
  it('stays silent on a site with no archived pages', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const count = warnOnCapabilityGaps(manifest, { anyArchived: false })
      expect(count).toBe(0)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('warns per gapped target once the site has an archived page', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const count = warnOnCapabilityGaps(manifest, { anyArchived: true })
      expect(count).toBe(1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const msg = warnSpy.mock.calls[0][0] as string
      expect(msg).toContain('plain-static')
      expect(msg).toContain('redirects')
      expect(msg).toContain('gone-status')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('keeps the previous warn-always behavior for callers without archive state', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(warnOnCapabilityGaps(manifest)).toBe(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

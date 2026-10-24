import { describe, it, expect } from 'vitest'
import {
  composeFragmentHashes,
  hashManifest,
  parseSidecarName,
  RENDER_FORMAT_VERSION,
  sidecarNameFor,
} from '../src/hash.js'
import type { FragmentManifest, PageManifest } from '../src/types.js'

describe('sidecarNameFor / parseSidecarName', () => {
  it('roundtrips a hash', () => {
    expect(parseSidecarName(sidecarNameFor('abc12345'))).toBe('abc12345')
  })

  it('rejects non-sidecar names', () => {
    expect(parseSidecarName('index.html')).toBeNull()
    expect(parseSidecarName('.notahash.hash')).toBeNull()
    expect(parseSidecarName('.abc12345.txt')).toBeNull()
    expect(parseSidecarName('.ABC12345.hash')).toBeNull() // hex must be lowercase
    expect(parseSidecarName('')).toBeNull()
  })
})

describe('hashManifest', () => {
  const baseManifest: PageManifest = {
    route: '/home',
    template: 'page-default',
    content: { title: 'Hello' },
    components: [{ name: 'hero', template: 'hero', content: { title: 'A' } }, '@header'],
  }

  describe('page metadata', () => {
    const t = new Map([
      ['hero', 'h1'],
      ['page-default', 'p1'],
    ])

    it('a page without metadata hashes the same as one with empty metadata', () => {
      // Pinned at render format 1; a different value at the same format
      // would show every published page without metadata as changed.
      expect(hashManifest(baseManifest, { templateHashes: t })).toBe('8b66546b')
      expect(hashManifest({ ...baseManifest, metadata: {} }, { templateHashes: t })).toBe('8b66546b')
    })

    it('changes when metadata changes, whatever its key order', () => {
      const withTitle = hashManifest({ ...baseManifest, metadata: { title: 'A' } }, { templateHashes: t })
      expect(withTitle).not.toBe('8b66546b')
      expect(hashManifest({ ...baseManifest, metadata: { title: 'B' } }, { templateHashes: t })).not.toBe(withTitle)
      expect(hashManifest({ ...baseManifest, metadata: { title: 'A', description: 'D' } }, { templateHashes: t })).toBe(
        hashManifest({ ...baseManifest, metadata: { description: 'D', title: 'A' } }, { templateHashes: t }),
      )
    })
  })

  it('is stable for the same input', () => {
    const t = new Map([
      ['hero', 'h1'],
      ['page-default', 'p1'],
    ])
    const a = hashManifest(baseManifest, { templateHashes: t })
    const b = hashManifest(baseManifest, { templateHashes: t })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes when content changes', () => {
    const t = new Map([
      ['hero', 'h1'],
      ['page-default', 'p1'],
    ])
    const a = hashManifest(baseManifest, { templateHashes: t })
    const modified: PageManifest = {
      ...baseManifest,
      content: { title: 'Hello World' },
    }
    expect(hashManifest(modified, { templateHashes: t })).not.toBe(a)
  })

  it('changes when a template hash changes', () => {
    const t1 = new Map([
      ['hero', 'h1'],
      ['page-default', 'p1'],
    ])
    const t2 = new Map([
      ['hero', 'h2'],
      ['page-default', 'p1'],
    ])
    expect(hashManifest(baseManifest, { templateHashes: t1 })).not.toBe(
      hashManifest(baseManifest, { templateHashes: t2 }),
    )
  })

  it('is invariant to JSON key order', () => {
    const t = new Map([
      ['hero', 'h1'],
      ['page-default', 'p1'],
    ])
    const reordered: PageManifest = {
      template: 'page-default',
      content: { title: 'Hello' },
      route: '/home',
      components: [{ template: 'hero', name: 'hero', content: { title: 'A' } }, '@header'],
    }
    expect(hashManifest(baseManifest, { templateHashes: t })).toBe(hashManifest(reordered, { templateHashes: t }))
  })

  it('handles missing template hashes gracefully', () => {
    // No template hashes provided — should still produce a stable hash
    const empty = new Map<string, string>()
    const h = hashManifest(baseManifest, { templateHashes: empty })
    expect(h).toMatch(/^[0-9a-f]{8}$/)
  })

  it('changes when nested inline component template hash changes', () => {
    const nested: PageManifest = {
      route: '/home',
      template: 'page-default',
      components: [
        {
          name: 'features',
          template: 'features-grid',
          components: [{ name: 'fast', template: 'feature-card', content: { title: 'Fast' } }],
        },
      ],
    }
    const t1 = new Map([
      ['feature-card', 'fc1'],
      ['features-grid', 'fg1'],
      ['page-default', 'p1'],
    ])
    const t2 = new Map([
      ['feature-card', 'fc2'],
      ['features-grid', 'fg1'],
      ['page-default', 'p1'],
    ])
    expect(hashManifest(nested, { templateHashes: t1 })).not.toBe(hashManifest(nested, { templateHashes: t2 }))
  })
})

describe('composeFragmentHashes (#1090)', () => {
  const compose = (frags: Map<string, FragmentManifest>, th: Map<string, string>) =>
    composeFragmentHashes(frags.keys(), n => frags.get(n), th)
  const templateHashes = new Map([
    ['p', 't1'],
    ['h', 't2'],
    ['l', 't3'],
    ['section', 't4'],
  ])
  const fragments = (logo: string) =>
    new Map<string, FragmentManifest>([
      ['header', { template: 'h', components: ['@logo'] }],
      ['logo', { template: 'l', content: { text: logo } }],
    ])
  const page: PageManifest = { route: '/', template: 'p', components: ['@header'] }

  it('a nested fragment change changes the outer fragment and every static page that bakes it', () => {
    const a = compose(fragments('v1'), templateHashes)
    const b = compose(fragments('v2'), templateHashes)
    expect(b.get('header')).not.toBe(a.get('header'))
    expect(hashManifest(page, { templateHashes, fragmentHashes: b })).not.toBe(
      hashManifest(page, { templateHashes, fragmentHashes: a }),
    )
  })

  it('is stable when nothing changes', () => {
    const a = compose(fragments('v1'), templateHashes)
    const b = compose(fragments('v1'), templateHashes)
    expect([...b]).toEqual([...a])
  })

  it('follows three levels of nesting', () => {
    const chain = (deep: string) =>
      new Map<string, FragmentManifest>([
        ['a', { template: 'h', components: ['@b'] }],
        ['b', { template: 'h', components: ['@c'] }],
        ['c', { template: 'l', content: { text: deep } }],
      ])
    expect(compose(chain('x'), templateHashes).get('a')).not.toBe(compose(chain('y'), templateHashes).get('a'))
  })

  it('follows references nested inside inline components', () => {
    const frags = (logo: string) =>
      new Map<string, FragmentManifest>([
        ['header', { template: 'h', components: [{ name: 'wrap', template: 'section', components: ['@logo'] }] }],
        ['logo', { template: 'l', content: { text: logo } }],
      ])
    expect(compose(frags('v1'), templateHashes).get('header')).not.toBe(
      compose(frags('v2'), templateHashes).get('header'),
    )
  })

  it('terminates on a reference cycle', () => {
    const cyclic = new Map<string, FragmentManifest>([
      ['a', { template: 'h', components: ['@b'] }],
      ['b', { template: 'h', components: ['@a'] }],
    ])
    const out = compose(cyclic, templateHashes)
    expect(out.get('a')).toMatch(/^[0-9a-f]{8}$/)
    expect(out.get('b')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('an ESI page ignores its top-level fragments but not ones nested in inline components', () => {
    const a = compose(fragments('v1'), templateHashes)
    const b = compose(fragments('v2'), templateHashes)
    const esi = { templateHashes, topLevelFragmentsComposedAtRequest: true }
    expect(hashManifest(page, { ...esi, fragmentHashes: b })).toBe(hashManifest(page, { ...esi, fragmentHashes: a }))
    const inlinePage: PageManifest = {
      route: '/x',
      template: 'p',
      components: [{ name: 'promo', template: 'section', components: ['@header'] }],
    }
    expect(hashManifest(inlinePage, { ...esi, fragmentHashes: b })).not.toBe(
      hashManifest(inlinePage, { ...esi, fragmentHashes: a }),
    )
  })
})

describe('hashManifest — archived items (#1090)', () => {
  const templateHashes = new Map([['h', 't1']])
  it("retargeting an alias changes the archived item's hash", () => {
    const a = hashManifest({ template: 'h', archived: true, aliasOf: 'footer' } as FragmentManifest, { templateHashes })
    const b = hashManifest({ template: 'h', archived: true, aliasOf: 'footer-v2' } as FragmentManifest, {
      templateHashes,
    })
    expect(b).not.toBe(a)
  })
  it('a live item hashes as before', () => {
    expect(hashManifest({ template: 'h' } as FragmentManifest, { templateHashes })).toBe(
      hashManifest({ template: 'h', archived: false } as FragmentManifest, { templateHashes }),
    )
  })
})

describe('hashManifest — render format version', () => {
  const templateHashes = new Map([
    ['page-default', 'p1'],
    ['hero', 'h1'],
  ])
  const cases: [string, PageManifest | FragmentManifest][] = [
    ['page', { route: '/', template: 'page-default', components: ['@header'] }],
    ['page with metadata', { route: '/', template: 'page-default', metadata: { title: 'T' } }],
    ['fragment', { template: 'hero', content: { title: 'A' } } as FragmentManifest],
    ['archived', { template: 'hero', archived: true, aliasOf: 'home' } as FragmentManifest],
  ]

  it.each(cases)('%s: raising the version changes the hash', (_label, manifest) => {
    const current = hashManifest(manifest, { templateHashes })
    expect(hashManifest(manifest, { templateHashes, renderFormatVersion: RENDER_FORMAT_VERSION })).toBe(current)
    expect(hashManifest(manifest, { templateHashes, renderFormatVersion: RENDER_FORMAT_VERSION + 1 })).not.toBe(current)
  })
})

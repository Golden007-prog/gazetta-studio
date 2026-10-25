/**
 * #1394: unknown capabilities in custom roles were accepted silently
 * at boot, and `admin.auth.strict` was read nowhere. `buildAuthProvider`
 * now flags unknown reserved-prefix capabilities once at boot — a
 * warning naming the role and capability by default, an
 * `AuthConfigurationError` with the same message under `strict: true`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAuthProvider, resolveAuthProviderFromManifest } from '../src/auth/factory.js'
import { AuthConfigurationError } from '../src/auth/errors.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('unknown custom-role capabilities at boot (#1394)', () => {
  it("roles: { x: { capabilities: ['read:pagez'] } } boots with one warning naming x and read:pagez", () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = buildAuthProvider({ trust: 'none', roles: { x: { capabilities: ['read:pagez'] } } })
    expect(provider).toBeDefined()
    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0][0] as string
    expect(message).toContain('"x"')
    expect(message).toContain('"read:pagez"')
  })

  it('the same with strict: true stops boot with that message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() =>
      buildAuthProvider({ trust: 'none', strict: true, roles: { x: { capabilities: ['read:pagez'] } } }),
    ).toThrow(AuthConfigurationError)
    expect(() =>
      buildAuthProvider({ trust: 'none', strict: true, roles: { x: { capabilities: ['read:pagez'] } } }),
    ).toThrow(/"x" declares unknown capability "read:pagez"/)
    expect(warn).not.toHaveBeenCalled()
  })

  it('known capabilities and * give no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildAuthProvider({ trust: 'none', roles: { x: { capabilities: ['read:pages', '*'] } } })
    expect(warn).not.toHaveBeenCalled()
  })

  it('plugin-scoped capabilities pass through without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildAuthProvider({ trust: 'none', roles: { x: { capabilities: ['@my-org/search:rebuild-index'] } } })
    expect(warn).not.toHaveBeenCalled()
  })

  it('the shared manifest resolution path runs the same check', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    resolveAuthProviderFromManifest({ trust: 'none', roles: { x: { capabilities: ['edit:pagez'] } } })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('warns once per distinct issue across repeated constructions in one process', () => {
    // The CLI resolves the provider twice per boot (validation SSE
    // gate + createAdminApp); boot must still show one warning.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = { trust: 'none', roles: { x: { capabilities: ['delete:pagez'] } } } as const
    buildAuthProvider(config)
    buildAuthProvider(config)
    resolveAuthProviderFromManifest(config)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0] as string).toContain('"delete:pagez"')
    // A different unknown capability is a new issue and still warns.
    buildAuthProvider({ trust: 'none', roles: { x: { capabilities: ['publish:pagez'] } } })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[1][0] as string).toContain('"publish:pagez"')
  })
})

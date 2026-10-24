import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  createTargetRegistry,
  createTargetRegistryView,
  listEditableTargets,
  UnknownTargetError,
  NoEditableTargetError,
  resolveEnvVars,
} from '../src/targets.js'
import { filesystemStorage, r2Storage, s3Storage, azureBlobStorage } from '../src/providers/factories.js'
import type { StorageProvider, TargetConfig } from '../src/types.js'
import { tempDir } from './_helpers/temp.js'

function mockProvider(): StorageProvider {
  return {
    readFile: async () => {
      throw new Error('not impl')
    },
    writeFile: async () => {},
    readDir: async () => [],
    exists: async () => false,
    mkdir: async () => {},
    rm: async () => {},
    readBytes: async () => new Uint8Array(),
    writeBytes: async () => {},
    readStream: async () => new ReadableStream(),
    writeStream: async () => {},
  }
}

const testDir = tempDir('targets-test-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('storage provider factories', () => {
  describe('filesystemStorage', () => {
    it('returns a constructed StorageProvider', () => {
      const provider = filesystemStorage({ path: './output' })
      expect(provider).toBeDefined()
      expect(typeof provider.readFile).toBe('function')
      expect(typeof provider.writeFile).toBe('function')
    })

    it('uses the supplied path for file operations', async () => {
      await mkdir(testDir, { recursive: true })
      const provider = filesystemStorage({ path: resolve(testDir, 'dist') })
      await provider.mkdir('.')
      await provider.writeFile('test.txt', 'hello')
      const content = await provider.readFile('test.txt')
      expect(content).toBe('hello')
    })

    it('defaults path to ./targets/local when no opts given', () => {
      const provider = filesystemStorage()
      expect(provider).toBeDefined()
      // No throw — provider returns; path defaults to ./targets/local relative to CWD.
    })
  })

  describe('r2Storage', () => {
    it('throws when accountId missing', () => {
      expect(() => r2Storage({ accountId: '', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })).toThrow(
        /accountId/,
      )
    })
    it('throws when bucket missing', () => {
      expect(() => r2Storage({ accountId: 'a', bucket: '', accessKeyId: 'k', secretAccessKey: 's' })).toThrow(/bucket/)
    })
    it('throws when accessKeyId missing', () => {
      expect(() => r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: '', secretAccessKey: 's' })).toThrow(
        /accessKeyId/,
      )
    })
    it('throws when secretAccessKey missing', () => {
      expect(() => r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: '' })).toThrow(
        /secretAccessKey/,
      )
    })
    it('returns a provider on valid options (lazy SDK load)', () => {
      const provider = r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
      expect(provider).toBeDefined()
      // Construction succeeds without touching the SDK; auth/connectivity errors
      // surface on first method call per Path X's construction-timing convention.
    })
  })

  describe('s3Storage', () => {
    it('throws when endpoint missing', () => {
      expect(() => s3Storage({ endpoint: '', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })).toThrow(/endpoint/)
    })
    it('throws when bucket missing', () => {
      expect(() => s3Storage({ endpoint: 'http://x', bucket: '', accessKeyId: 'k', secretAccessKey: 's' })).toThrow(
        /bucket/,
      )
    })
    it('returns a provider on valid options', () => {
      const provider = s3Storage({
        endpoint: 'http://localhost:9000',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: 's',
      })
      expect(provider).toBeDefined()
    })
  })

  describe('azureBlobStorage', () => {
    it('throws when connectionString missing', () => {
      expect(() => azureBlobStorage({ connectionString: '', container: 'c' })).toThrow(/connectionString/)
    })
    it('throws when container missing', () => {
      expect(() => azureBlobStorage({ connectionString: 'conn', container: '' })).toThrow(/container/)
    })
    it('returns a provider on valid options', () => {
      const provider = azureBlobStorage({ connectionString: 'UseDevelopmentStorage=true', container: 'c' })
      expect(provider).toBeDefined()
    })
  })
})

describe('resolveEnvVars', () => {
  it('expands ${VAR} sentinels from process.env', () => {
    process.env.TEST_VAR = 'value'
    expect(resolveEnvVars('foo-${TEST_VAR}-bar')).toBe('foo-value-bar')
    delete process.env.TEST_VAR
  })
  it('replaces missing vars with empty string', () => {
    expect(resolveEnvVars('foo-${MISSING_VAR}-bar')).toBe('foo--bar')
  })
  it('passes empty input through unchanged', () => {
    expect(resolveEnvVars(undefined)).toBe(undefined)
    expect(resolveEnvVars('')).toBe('')
  })
})

describe('createTargetRegistry', () => {
  it('creates registry from multiple targets', async () => {
    await mkdir(testDir, { recursive: true })
    const targets: Record<string, TargetConfig> = {
      local: { storage: filesystemStorage({ path: resolve(testDir, 'output') }) },
    }
    const registry = await createTargetRegistry(targets)
    expect(registry.size).toBe(1)
    expect(registry.has('local')).toBe(true)
  })

  it('returns empty registry for empty config', async () => {
    const registry = await createTargetRegistry({})
    expect(registry.size).toBe(0)
  })

  it('skips targets that fail to initialize', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const targets: Record<string, TargetConfig> = {
      bad: {
        storage: s3Storage({
          endpoint: 'http://nonexistent:9999',
          bucket: 'test',
          accessKeyId: 'k',
          secretAccessKey: 's',
        }),
      },
      good: { storage: filesystemStorage({ path: resolve(testDir, 'output') }) },
    }
    await mkdir(testDir, { recursive: true })
    const registry = await createTargetRegistry(targets)
    expect(registry.has('good')).toBe(true)
    spy.mockRestore()
  })
})

describe('createTargetRegistryView', () => {
  it('resolves known target names to their providers', () => {
    const localP = mockProvider(),
      prodP = mockProvider()
    const providers = new Map<string, StorageProvider>([
      ['local', localP],
      ['prod', prodP],
    ])
    const configs: Record<string, TargetConfig> = {
      local: { storage: localP },
      prod: { storage: prodP, environment: 'production' },
    }
    const registry = createTargetRegistryView(providers, configs)
    expect(registry.get('local')).toBe(localP)
    expect(registry.get('prod')).toBe(prodP)
  })

  it('throws UnknownTargetError for unknown names', () => {
    const registry = createTargetRegistryView(new Map(), {})
    expect(() => registry.get('missing')).toThrow(UnknownTargetError)
    expect(() => registry.get('missing')).toThrow(/missing/)
  })

  it('getConfig returns the config or undefined', () => {
    const configs: Record<string, TargetConfig> = {
      local: { storage: mockProvider() },
    }
    const registry = createTargetRegistryView(new Map([['local', mockProvider()]]), configs)
    expect(registry.getConfig('local')).toBe(configs.local)
    expect(registry.getConfig('nope')).toBeUndefined()
  })

  it('list() returns target names in declaration order', () => {
    const configs: Record<string, TargetConfig> = {
      local: { storage: mockProvider() },
      staging: { storage: mockProvider(), environment: 'staging' },
      prod: { storage: mockProvider(), environment: 'production' },
    }
    const registry = createTargetRegistryView(new Map(), configs)
    expect(registry.list()).toEqual(['local', 'staging', 'prod'])
  })

  describe('defaultEditable', () => {
    it('returns the first editable target in declaration order', () => {
      const configs: Record<string, TargetConfig> = {
        prod: { storage: mockProvider(), environment: 'production' },
        dev: { storage: mockProvider(), publicStorage: false },
        staging: { storage: mockProvider(), environment: 'staging', editable: true, publicStorage: false },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(registry.defaultEditable()).toBe('dev')
    })

    it('respects explicit editable: true on non-local environments', () => {
      const configs: Record<string, TargetConfig> = {
        prod: { storage: mockProvider(), environment: 'production', editable: true },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(registry.defaultEditable()).toBe('prod')
    })

    it('throws NoEditableTargetError when no target is editable', () => {
      const configs: Record<string, TargetConfig> = {
        staging: { storage: mockProvider(), environment: 'staging' },
        prod: { storage: mockProvider(), environment: 'production' },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(() => registry.defaultEditable()).toThrow(NoEditableTargetError)
    })

    it('skips a target whose storage defaults to public', () => {
      const configs: Record<string, TargetConfig> = {
        bucket: { storage: mockProvider() },
        local: { storage: mockProvider(), publicStorage: false },
      }
      const registry = createTargetRegistryView(new Map(), configs)
      expect(registry.defaultEditable()).toBe('local')
    })

    it('throws when no targets at all', () => {
      const registry = createTargetRegistryView(new Map(), {})
      expect(() => registry.defaultEditable()).toThrow(NoEditableTargetError)
    })
  })
})

describe('listEditableTargets', () => {
  it('filters to editable targets in declaration order', () => {
    const configs: Record<string, TargetConfig> = {
      local: { storage: mockProvider(), publicStorage: false },
      staging: { storage: mockProvider(), environment: 'staging' },
      prod: { storage: mockProvider(), environment: 'production', editable: true, publicStorage: false },
      secondLocal: { storage: mockProvider(), publicStorage: false },
      // Public storage defaults to not editable, even with environment unset.
      bucket: { storage: mockProvider() },
    }
    expect(listEditableTargets(configs)).toEqual(['local', 'prod', 'secondLocal'])
  })

  it('returns empty when none editable', () => {
    expect(listEditableTargets({})).toEqual([])
    expect(
      listEditableTargets({
        staging: { storage: mockProvider(), environment: 'staging' },
      }),
    ).toEqual([])
  })
})

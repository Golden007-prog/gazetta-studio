/**
 * Built-in storage factories report their `kind`, which `isPublicStorage`
 * reads. The cloud factories return lazy proxies: reading `kind` must not
 * load the SDK, so a missing optional dependency only fails on first use.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('../src/providers/s3.js')
  vi.doUnmock('../src/providers/azure-blob.js')
  vi.resetModules()
})

describe('storage kind', () => {
  it('filesystemStorage reports filesystem', async () => {
    const { filesystemStorage } = await import('../src/providers/factories.js')
    expect(filesystemStorage({ path: '/tmp/gazetta-kind-test' }).kind).toBe('filesystem')
  })

  it.each([
    ['r2', 'r2'],
    ['s3', 's3'],
    ['azure', 'azure'],
  ] as const)('%s factory reports %s without loading its SDK', async (factory, kind) => {
    const sdkLoads = vi.fn()
    vi.doMock('../src/providers/s3.js', () => {
      sdkLoads('s3')
      return { createS3Provider: () => ({}) }
    })
    vi.doMock('../src/providers/azure-blob.js', () => {
      sdkLoads('azure')
      return { createAzureBlobProvider: () => ({}) }
    })
    const { r2Storage, s3Storage, azureBlobStorage } = await import('../src/providers/factories.js')
    const storage =
      factory === 'r2'
        ? r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
        : factory === 's3'
          ? s3Storage({ endpoint: 'http://localhost:9000', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
          : azureBlobStorage({ connectionString: 'UseDevelopmentStorage=true', container: 'c' })
    expect(storage.kind).toBe(kind)
    // Proves the mocks are wired: a method call does load the SDK module.
    expect(sdkLoads).not.toHaveBeenCalled()
    await (storage as unknown as { init(): Promise<void> }).init()
    expect(sdkLoads).toHaveBeenCalledTimes(1)
  })
})

import { DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createS3Provider } from '../src/providers/s3.js'

// Pagination needs >1000 objects to exercise against a real store, and
// writing that many to MinIO in CI drops connections (#903 follow-up).
// A fake client drives the same code paths deterministically; the
// folder-boundary behaviour is still covered against MinIO and Azure in
// apps/admin/tests/_helpers/provider-conformance.ts.

function provider() {
  return createS3Provider({ endpoint: 'http://fake', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
}

/** Fake bucket: `send` answers List with pages of `pageSize` and records deletes. */
function fakeBucket(keys: string[], pageSize: number, deleteErrors: { Key: string; Message: string }[] = []) {
  const listed: (string | undefined)[] = []
  const batches: string[][] = []
  vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof ListObjectsV2Command) {
      const { Prefix = '', ContinuationToken } = cmd.input
      listed.push(Prefix)
      const matching = keys.filter(k => k.startsWith(Prefix))
      const start = ContinuationToken ? Number(ContinuationToken) : 0
      const page = matching.slice(start, start + pageSize)
      const next = start + pageSize
      return {
        Contents: page.map(Key => ({ Key })),
        IsTruncated: next < matching.length,
        NextContinuationToken: next < matching.length ? String(next) : undefined,
      }
    }
    if (cmd instanceof DeleteObjectsCommand) {
      batches.push((cmd.input.Delete?.Objects ?? []).map(o => o.Key!))
      return { Errors: deleteErrors }
    }
    if (cmd instanceof DeleteObjectCommand) return {}
    throw new Error(`unexpected command ${(cmd as object).constructor.name}`)
  })
  return { listed, batches }
}

afterEach(() => vi.restoreAllMocks())

describe('S3 provider rm', () => {
  it('deletes every listing page, one batch per page', async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `dir/f${i}`)
    const { batches } = fakeBucket(keys, 1000)
    await provider().rm('dir')
    expect(batches.map(b => b.length)).toEqual([1000, 1000, 500])
    expect(batches.flat().sort()).toEqual([...keys].sort())
  })

  it('lists with the folder boundary, so same-prefix siblings are never candidates', async () => {
    const { listed, batches } = fakeBucket(['pages/home/a', 'pages/homepage/b', 'pages/home.bak'], 1000)
    await provider().rm('pages/home')
    expect(listed).toEqual(['pages/home/'])
    expect(batches).toEqual([['pages/home/a']])
  })

  it('throws when the store reports per-key delete failures', async () => {
    fakeBucket(['dir/a', 'dir/b'], 1000, [{ Key: 'dir/b', Message: 'AccessDenied' }])
    await expect(provider().rm('dir')).rejects.toThrow(/dir\/b.*AccessDenied/)
  })

  it('never lists the whole bucket for rm("")', async () => {
    const { listed } = fakeBucket(['anything'], 1000)
    await provider().rm('')
    expect(listed).toEqual([])
  })
})

/**
 * Shared storage-provider conformance suite — the canonical "does this
 * provider satisfy StorageProvider?" test battery, extracted so every
 * provider (filesystem, S3, Azure Blob, R2) runs the same assertions.
 *
 * Closes testing-plan.md Priority 2.1: Azure had only 3 publish-level
 * tests, S3 had 8 direct CRUD tests. Parity now enforced by running
 * the same function against both.
 *
 * SRP: this module owns the conformance contract, nothing else. New
 * providers opt in by calling `runProviderConformance(...)` from their
 * docker.test.ts describe block with a factory that returns an
 * initialized StorageProvider.
 *
 * Why a factory rather than a plain instance: providers need different
 * buckets/containers per test batch (to keep parallel test runs from
 * colliding), so the caller supplies a "give me a provider named X"
 * callback. The helper calls it once at suite start.
 */
import { beforeAll, describe, it, expect } from 'vitest'
import type { StorageProvider } from 'gazetta'

export interface ProviderFactory {
  /** Human-readable name, used in the describe() label. */
  name: string
  /**
   * Create an initialized provider bound to a unique namespace (bucket /
   * container / dir). Caller decides the naming scheme; helper only
   * requires that successive calls with different names don't collide.
   */
  make(namespace: string): Promise<StorageProvider>
}

/**
 * Register the storage-provider conformance battery under its own
 * describe() block. Call once per provider from docker.test.ts.
 *
 * Each test uses fresh keys so ordering doesn't matter, but the test
 * suite itself shares one provider (one bucket/container) because
 * per-test provision would triple Azurite/MinIO setup time.
 */
export function runProviderConformance(factory: ProviderFactory): void {
  describe(`${factory.name} — StorageProvider conformance`, () => {
    let provider: StorageProvider

    beforeAll(async () => {
      // A stable namespace per provider; tests use unique file paths
      // within it so state doesn't leak between tests.
      provider = await factory.make('conformance')
    })

    it('writes and reads a file', async () => {
      await provider.writeFile('rw/hello.txt', 'hello world')
      expect(await provider.readFile('rw/hello.txt')).toBe('hello world')
    })

    it('exists returns true for a written file and false for a missing one', async () => {
      await provider.writeFile('exists/yes.txt', 'yes')
      expect(await provider.exists('exists/yes.txt')).toBe(true)
      expect(await provider.exists('exists/nope.txt')).toBe(false)
    })

    it('reads a directory and distinguishes files vs subdirectories', async () => {
      await provider.writeFile('readdir/a.txt', 'a')
      await provider.writeFile('readdir/b.txt', 'b')
      await provider.writeFile('readdir/sub/c.txt', 'c')

      const entries = await provider.readDir('readdir')
      const names = entries.map(e => e.name)
      expect(names).toContain('a.txt')
      expect(names).toContain('b.txt')
      expect(names).toContain('sub')
      expect(entries.find(e => e.name === 'sub')?.isDirectory).toBe(true)
      expect(entries.find(e => e.name === 'a.txt')?.isDirectory).toBe(false)
    })

    it('exists on a directory prefix returns true, on a missing prefix returns false', async () => {
      await provider.writeFile('existsdir/file.txt', 'content')
      expect(await provider.exists('existsdir')).toBe(true)
      expect(await provider.exists('existsdir-missing')).toBe(false)
    })

    it('readFile throws on a missing file', async () => {
      await expect(provider.readFile('never/written.txt')).rejects.toThrow()
    })

    it('rm deletes a single file', async () => {
      await provider.writeFile('rm-file/bye.txt', 'bye')
      await provider.rm('rm-file/bye.txt')
      expect(await provider.exists('rm-file/bye.txt')).toBe(false)
    })

    it('rm deletes a directory recursively', async () => {
      await provider.writeFile('rm-dir/a.txt', 'a')
      await provider.writeFile('rm-dir/b.txt', 'b')
      await provider.writeFile('rm-dir/sub/c.txt', 'c')
      await provider.rm('rm-dir')
      expect(await provider.exists('rm-dir/a.txt')).toBe(false)
      expect(await provider.exists('rm-dir/b.txt')).toBe(false)
      expect(await provider.exists('rm-dir/sub/c.txt')).toBe(false)
    })

    // Object stores have no real directories: a folder delete is "delete every
    // key under the folder". It must stop at the folder boundary. S3's rm
    // listed keys by the bare prefix, so rm('…/home') also deleted
    // '…/homepage/…' and '…/home.bak' — and a file rm of '.ab12.hash' took
    // '.ab12.hash.fr' with it. Found by the Opus 5.5 reviewer check on #881.
    it('rm on a directory leaves same-prefix siblings alone', async () => {
      await provider.writeFile('rm-sib/home/state.json', 'home')
      await provider.writeFile('rm-sib/home/approvers/alice', '')
      await provider.writeFile('rm-sib/homepage/state.json', 'homepage')
      await provider.writeFile('rm-sib/home.bak', 'backup')
      await provider.rm('rm-sib/home')
      expect(await provider.exists('rm-sib/home/state.json')).toBe(false)
      expect(await provider.exists('rm-sib/home/approvers/alice')).toBe(false)
      expect(await provider.readFile('rm-sib/homepage/state.json')).toBe('homepage')
      expect(await provider.readFile('rm-sib/home.bak')).toBe('backup')
    })

    it('rm on a file leaves same-prefix sibling files alone', async () => {
      await provider.writeFile('rm-sib-file/.ab12cd34.hash', '')
      await provider.writeFile('rm-sib-file/.ab12cd34.hash.fr', 'fr')
      await provider.rm('rm-sib-file/.ab12cd34.hash')
      expect(await provider.exists('rm-sib-file/.ab12cd34.hash')).toBe(false)
      expect(await provider.readFile('rm-sib-file/.ab12cd34.hash.fr')).toBe('fr')
    })

    it('mkdir is safe to call (no-op on object stores, creates on fs)', async () => {
      // No assertion beyond "doesn't throw" — object stores have no
      // real directories, filesystem does but we don't need to verify
      // that here (filesystem-provider.test.ts covers the fs-specific
      // behavior). The contract is: mkdir must be idempotent and safe.
      await provider.mkdir('mkdir-safe/a/b/c')
      await provider.mkdir('mkdir-safe/a/b/c') // second call, same path
    })

    // ---- Binary streaming (part of the StorageProvider contract) ----

    it('writeStream + readStream round-trip identical bytes', async () => {
      const path = 'binary/roundtrip.bin'
      const expected = makeBytes(2048)
      await provider.writeStream(path, oneShotStream(expected))
      const actual = await drainStream(await provider.readStream(path))
      expect(actual.length).toBe(expected.length)
      expect(actual).toEqual(expected)
    })

    it('readStream honors a byte range (HTTP Range semantics, inclusive)', async () => {
      const path = 'binary/range.bin'
      // 256 unique bytes — easy to assert per-byte after slicing.
      const full = new Uint8Array(256)
      for (let i = 0; i < 256; i++) full[i] = i
      await provider.writeStream(path, oneShotStream(full))

      // Inclusive range — bytes[10..19] is 10 bytes.
      const slice = await drainStream(await provider.readStream(path, { start: 10, end: 19 }))
      expect(slice.length).toBe(10)
      expect(Array.from(slice)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
    })

    it('readStream throws on a missing path', async () => {
      await expect(provider.readStream('binary/nope.bin')).rejects.toThrow()
    })

    it('writeStream overwrites an existing object atomically', async () => {
      const path = 'binary/overwrite.bin'
      await provider.writeStream(path, oneShotStream(makeBytes(512)))
      const replacement = makeBytes(2048, 0xff)
      await provider.writeStream(path, oneShotStream(replacement))
      const actual = await drainStream(await provider.readStream(path))
      expect(actual).toEqual(replacement)
    })
  })
}

/** Produce a single-chunk ReadableStream from a Uint8Array. */
function oneShotStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(bytes)
      ctrl.close()
    },
  })
}

/** Drain a ReadableStream into a single Uint8Array. */
async function drainStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/** Make N deterministic bytes — repeating pattern based on index, optional seed. */
function makeBytes(n: number, seed = 0): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i + seed) & 0xff
  return out
}

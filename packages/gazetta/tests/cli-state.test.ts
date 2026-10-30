import { afterEach, describe, expect, it, vi } from 'vitest'
import { runStateRemove } from '../src/cli/state.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const sensitive = {
  '.gazetta/history/revisions/r.json': '{}',
  '.gazetta/review/x.json': '{}',
}
const kept = { '.gazetta/publish-generation': 'g', 'pages/home/index.html': '<html></html>' }

function setup(entries: Record<string, string> = { ...sensitive, ...kept }) {
  const storage = memoryStorage()
  storage.seed(entries)
  const lines: string[] = []
  const questions: string[] = []
  const ctx = { targetName: 'production', config: { storage } }
  const keys = () => [...storage.dump().keys()].sort()
  return { storage, lines, questions, ctx, keys, log: (l: string) => lines.push(l) }
}

afterEach(() => vi.unstubAllEnvs())

describe('gazetta state remove', () => {
  it('removes the sensitive folders with --yes, leaving everything else', async () => {
    vi.stubEnv('CI', 'true')
    const t = setup()
    await runStateRemove(t.ctx, { yes: true, log: t.log })
    expect(t.keys()).toEqual(Object.keys(kept).sort())
    expect(t.lines.join('\n')).toContain('Removed history and review from `production`')
  })

  it('names exactly the folders present in the question, and removes them on yes', async () => {
    vi.stubEnv('CI', '')
    const t = setup()
    await runStateRemove(t.ctx, {
      log: t.log,
      confirm: async q => {
        t.questions.push(q)
        return true
      },
    })
    expect(t.questions).toEqual(["Delete history and review from `production`'s storage? This can't be undone."])
    expect(t.keys()).toEqual(Object.keys(kept).sort())
  })

  it('removes nothing when the confirmation is declined', async () => {
    vi.stubEnv('CI', '')
    const t = setup()
    await runStateRemove(t.ctx, { log: t.log, confirm: async () => false })
    expect(t.keys()).toEqual(Object.keys({ ...sensitive, ...kept }).sort())
    expect(t.lines.join('\n')).toContain('Nothing was removed')
  })

  it('refuses in CI without --yes and removes nothing', async () => {
    vi.stubEnv('CI', 'true')
    const t = setup()
    const confirm = vi.fn(async () => true)
    await expect(runStateRemove(t.ctx, { log: t.log, confirm })).rejects.toThrow('requires --yes')
    expect(confirm).not.toHaveBeenCalled()
    expect(t.keys()).toEqual(Object.keys({ ...sensitive, ...kept }).sort())
  })

  it('says there is nothing to remove without asking', async () => {
    vi.stubEnv('CI', '')
    const t = setup(kept)
    const confirm = vi.fn(async () => true)
    await runStateRemove(t.ctx, { log: t.log, confirm })
    expect(confirm).not.toHaveBeenCalled()
    expect(t.lines.join('\n')).toContain('Nothing to remove')
    expect(t.keys()).toEqual(Object.keys(kept).sort())
  })
})

/**
 * Review-workflow Cut 5 — save-handler integration.
 *
 * Drives the real PUT routes through `createAdminApp` so the gate is
 * exercised where `manifest-save.ts` actually runs it, for both the
 * page and the fragment kind. Review state is seeded and read back
 * through the Cut 3 sidecar module, never by path literals, so the
 * test pins behavior rather than storage layout.
 *
 * Per rule 26: every test builds a fresh `memoryStorage()` + app.
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import {
  readApprovers,
  readReviewSidecar,
  writeApproverSidecar,
  writeReviewSidecar,
  type ReviewSidecar,
  type ReviewStateKind,
} from '../src/review/index.js'
import type { ReviewWorkflowConfig } from '../src/types.js'
import { createValidatorRegistry } from '../src/validation/registry.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

const COMPONENTS = [{ id: 'hero-001', template: 'hero', content: { title: 'Hi' } }]

interface Harness {
  app: Hono
  storage: MemoryStorage
  contentRoot: ReturnType<typeof createSourceContext>['contentRoot']
}

function setup(reviewWorkflow: ReviewWorkflowConfig | undefined): Harness {
  const storage = memoryStorage()
  storage.seed({
    'pages/home/page.json': JSON.stringify({
      template: 'page-default',
      content: { title: 'Home' },
      components: COMPONENTS,
    }),
    'fragments/header/fragment.json': JSON.stringify({
      template: 'header-layout',
      content: { title: 'Header' },
      components: COMPONENTS,
    }),
  })
  const targetConfigs = {
    local: {
      storage,
      type: 'esi' as const,
      environment: 'local' as const,
      editable: true,
      ...(reviewWorkflow ? { reviewWorkflow } : {}),
    },
  }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    // No templates exist in memory storage; ref-existence validators are not under test.
    validators: createValidatorRegistry([]),
  })
  return { app, storage, contentRoot: source.contentRoot }
}

const KINDS = [
  { kind: 'page' as ReviewStateKind, name: 'home', url: '/api/pages/home', file: 'pages/home/page.json' },
  {
    kind: 'fragment' as ReviewStateKind,
    name: 'header',
    url: '/api/fragments/header',
    file: 'fragments/header/fragment.json',
  },
]

const now = '2026-10-01T00:00:00.000Z'
const PENDING: ReviewSidecar = {
  state: 'pending-review',
  submitter: 'alice',
  requiredApprovers: 1,
  submittedAt: now,
  updatedAt: now,
}
const APPROVED: ReviewSidecar = {
  state: 'approved',
  submitter: 'alice',
  requiredApprovers: 1,
  submittedAt: now,
  approvedAt: now,
  updatedAt: now,
}

async function seedState(h: Harness, kind: ReviewStateKind, name: string, sidecar: ReviewSidecar): Promise<void> {
  await writeReviewSidecar(h.contentRoot, kind, name, sidecar)
  if (sidecar.state === 'approved') await writeApproverSidecar(h.contentRoot, kind, name, 'bob')
}

function put(h: Harness, url: string, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(
    h.app.request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  )
}

const unchangedBody = (title: string) => ({ content: { title }, components: COMPONENTS })
const changedBody = { content: { title: 'Edited' }, components: COMPONENTS }
const titleOf = { page: 'Home', fragment: 'Header' } as const

describe.each(KINDS)('save-handler review gate — $kind', ({ kind, name, url, file }) => {
  it('pending-review → 409 EDIT_LOCKED with the withdraw message, and nothing is written', async () => {
    const h = setup({ enabled: true })
    await seedState(h, kind, name, PENDING)
    const before = await h.storage.readFile(file)

    const res = await put(h, url, changedBody)

    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; message: string }
    expect(body.code).toBe('EDIT_LOCKED')
    expect(body.message).toBe('Withdraw submission to edit')
    expect(await h.storage.readFile(file)).toBe(before)
    expect((await readReviewSidecar(h.contentRoot, kind, name))?.state).toBe('pending-review')
  })

  it.each([
    { policy: 'content-diff' as const, body: changedBody, expected: 'draft', label: 'content changed' },
    { policy: 'always' as const, body: changedBody, expected: 'draft', label: 'content changed' },
    { policy: 'always' as const, body: 'unchanged', expected: 'draft', label: 'content unchanged' },
    { policy: 'content-diff' as const, body: 'unchanged', expected: 'approved', label: 'content unchanged' },
  ])('approved + $policy + $label → $expected', async ({ policy, body, expected }) => {
    const h = setup({ enabled: true, invalidateOnSave: policy })
    await seedState(h, kind, name, APPROVED)

    const res = await put(h, url, body === 'unchanged' ? unchangedBody(titleOf[kind]) : body)

    expect(res.status).toBe(200)
    const sidecar = await readReviewSidecar(h.contentRoot, kind, name)
    expect(sidecar?.state).toBe(expected)
    const approvers = await readApprovers(h.contentRoot, kind, name)
    expect(approvers).toEqual(expected === 'draft' ? [] : ['bob'])
  })

  it('invalidateOnSave defaults to content-diff when the block omits it', async () => {
    const h = setup({ enabled: true })
    await seedState(h, kind, name, APPROVED)

    const unchanged = await put(h, url, unchangedBody(titleOf[kind]))
    expect(unchanged.status).toBe(200)
    expect((await readReviewSidecar(h.contentRoot, kind, name))?.state).toBe('approved')

    const changed = await put(h, url, changedBody)
    expect(changed.status).toBe(200)
    expect((await readReviewSidecar(h.contentRoot, kind, name))?.state).toBe('draft')
  })

  it('draft and no-state items save normally and get no review state', async () => {
    const h = setup({ enabled: true, invalidateOnSave: 'always' })
    expect((await put(h, url, changedBody)).status).toBe(200)
    expect(await readReviewSidecar(h.contentRoot, kind, name)).toBeNull()

    await writeReviewSidecar(h.contentRoot, kind, name, { state: 'draft', updatedAt: now })
    expect((await put(h, url, changedBody)).status).toBe(200)
    expect((await readReviewSidecar(h.contentRoot, kind, name))?.state).toBe('draft')
  })

  it.each([
    { label: 'no reviewWorkflow block', config: undefined },
    { label: 'enabled: false', config: { enabled: false, invalidateOnSave: 'always' as const } },
  ])('$label → pending-review and approved state are ignored', async ({ config }) => {
    const h = setup(config)
    await seedState(h, kind, name, PENDING)
    const locked = await put(h, url, changedBody)
    expect(locked.status).toBe(200)
    expect((await readReviewSidecar(h.contentRoot, kind, name))?.state).toBe('pending-review')

    await seedState(h, kind, name, APPROVED)
    expect((await put(h, url, { content: { title: 'Again' }, components: COMPONENTS })).status).toBe(200)
    expect((await readReviewSidecar(h.contentRoot, kind, name))?.state).toBe('approved')
    expect(await readApprovers(h.contentRoot, kind, name)).toEqual(['bob'])
  })
})

describe('save-handler review gate — scope', () => {
  it('only the saved item is invalidated', async () => {
    const h = setup({ enabled: true, invalidateOnSave: 'always' })
    await seedState(h, 'page', 'home', APPROVED)
    await seedState(h, 'fragment', 'header', APPROVED)

    expect((await put(h, '/api/pages/home', changedBody)).status).toBe(200)

    expect((await readReviewSidecar(h.contentRoot, 'page', 'home'))?.state).toBe('draft')
    expect((await readReviewSidecar(h.contentRoot, 'fragment', 'header'))?.state).toBe('approved')
  })
})

/**
 * The client's request() maps a non-OK response to an Error. The 409
 * bodies from the save routes carry `message` ("Archived. Restore to
 * edit.", "EDIT_LOCKED" conflicts) but no `error` field, so the admin
 * used to show the generic "Request failed: 409" instead of the
 * server's explanation (corker's review on #1502). The mapping now
 * falls back to `message` before the status text.
 *
 * Uses `vi.spyOn(global, 'fetch')` to mock the server response so
 * tests run without a real admin process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, setActiveTargetProvider } from '../src/client/api/client.js'

afterEach(() => {
  vi.restoreAllMocks()
  setActiveTargetProvider(null)
})

function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Response): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(input, init))
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) },
  })
}

describe('request() error message mapping', () => {
  it('surfaces the server message for a 409 ARCHIVED save refusal', async () => {
    // A draft saved after the item was archived elsewhere (another tab
    // or a restored draft) hits this response.
    mockFetch(() => jsonResponse({ code: 'ARCHIVED', message: 'Archived. Restore to edit.' }, { status: 409 }))
    await expect(api.updatePage('home', { content: {} })).rejects.toThrow('Archived. Restore to edit.')
  })

  it('surfaces the server message for a 409 EDIT_LOCKED save refusal', async () => {
    mockFetch(() => jsonResponse({ code: 'EDIT_LOCKED', message: 'Locked by a review session.' }, { status: 409 }))
    await expect(api.updateFragment('header', { content: {} })).rejects.toThrow('Locked by a review session.')
  })

  it('keeps the explicit error field first when both are present', async () => {
    mockFetch(() => jsonResponse({ error: 'boom', message: 'ignored' }, { status: 500 }))
    await expect(api.updatePage('home', { content: {} })).rejects.toThrow('boom')
  })

  it('falls back to the status text when the body explains nothing', async () => {
    mockFetch(() => jsonResponse({}, { status: 409 }))
    await expect(api.updatePage('home', { content: {} })).rejects.toThrow('Request failed: 409')
  })
})

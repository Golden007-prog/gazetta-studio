/**
 * Unit tests for `alt/anthropic.ts` — first real provider adapter.
 *
 * Uses `msw` (Mock Service Worker) to intercept the Anthropic API at
 * the network layer. Adapter sends a real request via the SDK; msw
 * returns canned responses. No real API calls; deterministic;
 * no API key required.
 *
 * Per the test infrastructure plan:
 *   - Happy path: request shape correctness, response parsing
 *   - Refusal: structured signal flows through the adapter
 *   - Errors: typed AI errors with the right cause
 *   - Abort: AbortSignal forwarded; aborts surface correctly
 *   - max_tokens: derived from request.maxChars
 *   - System prompt: composed prompt routes to the system parameter
 *   - Image content: base64-encoded, correct media_type
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { AIAdapterFailedError, AIInvalidResponseError } from '../src/ai/errors.js'
import { type AltGenerateInput, DEFAULT_ALT_REQUEST } from '../src/alt/adapter.js'
import { createAnthropicAltAdapter } from '../src/alt/anthropic.js'

const API_URL = 'https://api.anthropic.com/v1/messages'

interface CapturedRequest {
  body: {
    model: string
    max_tokens: number
    system?: string
    messages: Array<{
      role: string
      content: Array<
        | { type: 'text'; text: string }
        | {
            type: 'image'
            source: { type: string; media_type: string; data: string }
          }
      >
    }>
  }
  headers: Headers
}

let captured: CapturedRequest[] = []

const server = setupServer()

beforeAll(() => server.listen())
afterEach(() => {
  server.resetHandlers()
  captured = []
})
afterAll(() => server.close())

function mockResponse(text: string, status = 200): void {
  server.use(
    http.post(API_URL, async ({ request }) => {
      captured.push({
        body: (await request.json()) as CapturedRequest['body'],
        headers: request.headers,
      })
      if (status !== 200) {
        return HttpResponse.json({ error: { type: 'api_error', message: text } }, { status })
      }
      return HttpResponse.json({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      })
    }),
  )
}

function mockNetworkError(): void {
  server.use(
    http.post(API_URL, () => {
      return HttpResponse.error()
    }),
  )
}

function makeInput(overrides: Partial<AltGenerateInput> = {}): AltGenerateInput {
  return {
    bytes: new Uint8Array([0xff, 0xd8, 0xff]), // arbitrary
    mime: 'image/jpeg',
    request: { ...DEFAULT_ALT_REQUEST },
    prompt: 'You are writing alt text.',
    ...overrides,
  }
}

describe('createAnthropicAltAdapter — basic', () => {
  it('exposes name "anthropic"', () => {
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    expect(adapter.name).toBe('anthropic')
  })

  it('supports image MIMEs Anthropic accepts', () => {
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    expect(adapter.supports('image/jpeg')).toBe(true)
    expect(adapter.supports('image/png')).toBe(true)
    expect(adapter.supports('image/gif')).toBe(true)
    expect(adapter.supports('image/webp')).toBe(true)
  })

  it('rejects unsupported MIMEs', () => {
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    expect(adapter.supports('image/svg+xml')).toBe(false)
    expect(adapter.supports('audio/mpeg')).toBe(false)
    expect(adapter.supports('application/pdf')).toBe(false)
  })
})

describe('createAnthropicAltAdapter — happy path', () => {
  it('returns the model output verbatim', async () => {
    mockResponse('Mountain peak at sunset')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.text).toBe('Mountain peak at sunset')
    expect(result.refused).toBe(false)
    expect(result.refusalReason).toBeNull()
  })

  it('trims whitespace from the model output', async () => {
    mockResponse('   Trees in autumn.\n  ')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.text).toBe('Trees in autumn.')
  })

  it('uses the configured model in the request', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0, model: 'claude-sonnet-4-5' })
    await adapter.generate(makeInput())
    expect(captured[0].body.model).toBe('claude-sonnet-4-5')
  })

  it('defaults to claude-haiku-4-5 when no model is provided', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(makeInput())
    expect(captured[0].body.model).toBe('claude-haiku-4-5')
  })

  it('routes the composed prompt to the system parameter', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(makeInput({ prompt: 'Custom system prompt here.' }))
    expect(captured[0].body.system).toBe('Custom system prompt here.')
  })

  it('derives max_tokens from request.maxChars (≈4 chars/token)', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(
      makeInput({
        request: { ...DEFAULT_ALT_REQUEST, maxChars: 400 },
      }),
    )
    // 400 chars / 4 = 100 tokens (above the 64 floor).
    expect(captured[0].body.max_tokens).toBe(100)
  })

  it('floors max_tokens to give the model headroom for short maxChars', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(
      makeInput({
        request: { ...DEFAULT_ALT_REQUEST, maxChars: 50 },
      }),
    )
    // 50 / 4 = 13, but the floor is 64.
    expect(captured[0].body.max_tokens).toBe(64)
  })

  it('encodes image bytes as base64', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    await adapter.generate(makeInput({ bytes }))
    const block = captured[0].body.messages[0].content[0]
    expect(block.type).toBe('image')
    if (block.type === 'image') {
      expect(block.source.type).toBe('base64')
      expect(block.source.media_type).toBe('image/jpeg')
      expect(block.source.data).toBe(Buffer.from(bytes).toString('base64'))
    }
  })

  it('passes the asset MIME through as media_type', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await adapter.generate(makeInput({ mime: 'image/png' }))
    const block = captured[0].body.messages[0].content[0]
    if (block.type === 'image') {
      expect(block.source.media_type).toBe('image/png')
    }
  })
})

describe('createAnthropicAltAdapter — refusal', () => {
  it('detects shared refusal markers via detectRefusal', async () => {
    mockResponse("I can't describe this image.")
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(true)
    expect(result.refusalReason).not.toBeNull()
  })

  it('detects Anthropic-specific refusal markers', async () => {
    mockResponse('I cannot create captions for this image because of content concerns.')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(true)
  })

  it('passes through normal descriptions as not-refused', async () => {
    mockResponse('A cat sitting on a windowsill in the morning sun.')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const result = await adapter.generate(makeInput())
    expect(result.refused).toBe(false)
  })
})

describe('createAnthropicAltAdapter — errors', () => {
  it('translates 401 auth errors to AIAdapterFailedError', async () => {
    mockResponse('invalid api key', 401)
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-bad' })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('translates 429 rate-limit errors to AIAdapterFailedError', async () => {
    mockResponse('rate limited', 429)
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('translates 500 errors to AIAdapterFailedError', async () => {
    mockResponse('internal error', 500)
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('translates network errors to AIAdapterFailedError', async () => {
    mockNetworkError()
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIAdapterFailedError)
  })

  it('preserves the underlying SDK error as cause', async () => {
    mockResponse('rate limited', 429)
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    try {
      await adapter.generate(makeInput())
      throw new Error('expected to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(AIAdapterFailedError)
      if (err instanceof AIAdapterFailedError) {
        expect(err.cause).toBeDefined()
        expect((err.cause as Error).message.length).toBeGreaterThan(0)
      }
    }
  })

  it('throws AIInvalidResponseError when response has no text block', async () => {
    server.use(
      http.post(API_URL, () => {
        return HttpResponse.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [], // no blocks at all
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 0 },
        })
      }),
    )
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    await expect(adapter.generate(makeInput())).rejects.toBeInstanceOf(AIInvalidResponseError)
  })
})

describe('createAnthropicAltAdapter — AbortSignal', () => {
  it('aborts an in-flight request when the signal fires', async () => {
    server.use(
      http.post(API_URL, async () => {
        // Hold the response long enough for abort to fire.
        await new Promise(resolve => setTimeout(resolve, 1000))
        return HttpResponse.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'late response' }],
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 5 },
        })
      }),
    )
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const controller = new AbortController()
    const promise = adapter.generate(makeInput(), controller.signal)
    // Abort after a tick to ensure the SDK has started the fetch.
    setTimeout(() => controller.abort(), 10)
    // Adapter throws on abort — the suggester layer translates this
    // to null via its `signal.aborted` check.
    await expect(promise).rejects.toThrow()
  })

  it('does not start a request when the signal is already aborted', async () => {
    const requestSpy = vi.fn()
    server.use(
      http.post(API_URL, () => {
        requestSpy()
        return HttpResponse.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'should not see this' }],
          model: 'claude-haiku-4-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 5 },
        })
      }),
    )
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-test', maxRetries: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.generate(makeInput(), controller.signal)).rejects.toThrow()
    expect(requestSpy).not.toHaveBeenCalled()
  })
})

describe('createAnthropicAltAdapter — auth', () => {
  it('sends the API key as a bearer token', async () => {
    mockResponse('ok')
    const adapter = createAnthropicAltAdapter({ apiKey: 'sk-mytestkey' })
    await adapter.generate(makeInput())
    expect(captured[0].headers.get('authorization')).toBe('Bearer sk-mytestkey')
  })
})

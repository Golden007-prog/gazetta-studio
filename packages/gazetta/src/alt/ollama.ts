/**
 * Ollama adapter — alt-text via the local `/api/chat` endpoint.
 *
 * # Why no SDK
 *
 * Ollama's API is a single endpoint, no auth, no streaming negotiation,
 * no schema beyond simple JSON. The official `ollama` npm SDK exists
 * but adds little value over raw `fetch` for this single-call use case.
 * Skipping the SDK keeps adapter dependencies minimal.
 *
 * # Defaults
 *
 *   - Base URL: `http://localhost:11434` (Ollama's documented default).
 *     Operators running Ollama on a different host configure via
 *     `baseUrl` on the transport.
 *   - Model: `llama3.2-vision:11b`. The 11B variant is the entry-level
 *     size; `:90b` is also available for operators who want better
 *     description quality at higher GPU/RAM cost.
 *
 * # API contract details (verified against Ollama API docs)
 *
 *   - Endpoint: `POST /api/chat` (chat-style fits the system+user pattern).
 *   - Images are base64 strings in the per-message `images` array.
 *     Different from Anthropic and OpenAI shapes — same adapter
 *     abstraction holds via the scaffold.
 *   - Response: `{ message: { content: "..." }, done: true, ... }`
 *   - Auth: none for local install
 *   - AbortSignal: standard fetch — `fetch(url, { signal })`. Errors
 *     surface as `Error` with `name: 'AbortError'`.
 *
 * # SOLID
 *
 *   - Same lenses as Anthropic / OpenAI — orchestration via
 *     `ai/adapter-scaffold.ts`, Ollama-specific request/response/error
 *     shape here only.
 */
import { AIAdapterFailedError, AIInvalidResponseError } from '../ai/errors.js'
import type { AIProvider, AltTextTaskConfig } from '../ai/provider.js'
import { buildAltAdapterFromScaffold } from '../ai/adapter-scaffold.js'
import type { AltTextAdapter } from './adapter.js'
import { trimTrailingSlashes } from '../url.js'

const OLLAMA_REFUSAL_MARKERS: readonly string[] = [
  // llama3.2-vision tends to refuse with these patterns more than
  // saas providers; markers maintained per [refusal.ts] convention.
  "i'm not able to process this image",
  'i am not able to process this image',
  'sorry, i cannot',
]

/** Default base URL when running Ollama locally with default settings. */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434'

/** Default model. Ollama Library publishes 11B and 90B variants of llama3.2-vision. */
export const OLLAMA_DEFAULT_MODEL = 'llama3.2-vision:11b'

const OLLAMA_SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png'])

/**
 * Ollama transport-only options. Per Path X (transport-vs-task split).
 * Ollama needs no API key; baseUrl is the only transport knob.
 */
export interface OllamaTransportOptions {
  /** Base URL of the Ollama server. Defaults to {@link OLLAMA_DEFAULT_BASE_URL}. */
  baseUrl?: string
}

/**
 * Internal type for `createOllamaAltAdapter` callers (tests). Combines
 * transport with per-task config; new code goes through
 * `ollamaProvider(transport).altText(taskConfig)`.
 */
export interface OllamaAltAdapterOptions extends OllamaTransportOptions {
  /** Model ID. Defaults to {@link OLLAMA_DEFAULT_MODEL}. */
  model?: string
  /** Operator-supplied system prompt; prepended to system-composed prompt. */
  systemPrompt?: string
  /** Generation token cap. Ollama doesn't expose it directly, but the
   *  scaffold passes it through to keep the contract uniform. */
  maxTokens?: number
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string }
  done?: boolean
  error?: string
}

/**
 * Construct the Ollama alt-text adapter. Internal factory — kept public
 * for tests + advanced wiring. Operator-facing config goes through
 * `ollamaProvider(transport).altText(taskConfig)` (Path X).
 */
export function createOllamaAltAdapter(opts: OllamaAltAdapterOptions = {}): AltTextAdapter {
  const baseUrl = trimTrailingSlashes(opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL)
  const model = opts.model ?? OLLAMA_DEFAULT_MODEL
  const endpoint = `${baseUrl}/api/chat`

  return buildAltAdapterFromScaffold({
    name: 'ollama',
    supportedMimes: OLLAMA_SUPPORTED_MIMES,
    operatorSystemPrompt: opts.systemPrompt,
    operatorMaxTokens: opts.maxTokens,
    refusalMarkers: OLLAMA_REFUSAL_MARKERS,
    isAbortError: err => err instanceof Error && err.name === 'AbortError',
    errorContextSuffix: `Is Ollama running at ${baseUrl}?`,
    async callProvider({ bytes, mime: _mime, systemPrompt, signal }) {
      const imageB64 = Buffer.from(bytes).toString('base64')
      const body = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: 'Describe this image for use as alt text.',
            images: [imageB64],
          },
        ],
        stream: false,
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })

      if (!res.ok) {
        // Ollama returns plain-text errors for connection-level issues
        // and JSON `{ error: "..." }` for model-level issues. Surface
        // both as AIAdapterFailedError; the message includes status
        // code so logs can disambiguate (404 → model not pulled, 400
        // → malformed request, etc.).
        let detail = `HTTP ${res.status}`
        try {
          const errorBody = await res.text()
          if (errorBody) detail += `: ${errorBody.slice(0, 200)}`
        } catch {
          // Body unreadable; status code alone is the diagnostic.
        }
        throw new AIAdapterFailedError(`Ollama HTTP error: ${detail}`)
      }

      let parsed: OllamaChatResponse
      try {
        parsed = (await res.json()) as OllamaChatResponse
      } catch (err) {
        throw new AIInvalidResponseError(
          `Ollama returned non-JSON response: ${err instanceof Error ? err.message : 'unknown'}`,
        )
      }

      if (parsed.error) {
        throw new AIAdapterFailedError(`Ollama: ${parsed.error}`)
      }
      if (typeof parsed.message?.content !== 'string') {
        throw new AIInvalidResponseError('Ollama response had no message.content')
      }
      return parsed.message.content
    },
  })
}

/**
 * Operator-facing Ollama provider. See `anthropicProvider` for the full
 * Path X rationale. Ollama needs no API key; transport is just baseUrl.
 */
export function ollamaProvider(transport: OllamaTransportOptions = {}): AIProvider {
  return {
    name: 'ollama',
    altText(taskConfig: AltTextTaskConfig): AltTextAdapter {
      return createOllamaAltAdapter({
        ...transport,
        model: taskConfig.model,
        systemPrompt: taskConfig.systemPrompt,
        maxTokens: taskConfig.maxTokens,
      })
    },
  }
}

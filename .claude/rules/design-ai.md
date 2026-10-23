# AI Integration

How the CMS integrates AI capabilities — alt-text generation in v1.5, with translation, summarization, and tag suggestion as anticipated future tasks. Designed as a layered abstraction so each new task adds to a shared infrastructure rather than reimplementing it.

**This doc covers the design:** layered architecture, configuration model, alt-text task in detail, refusal handling, image preprocessing, prompt composition, runtime model, security, and distinctive choices.

**Companion docs:**
- [design-ai-implementation.md](design-ai-implementation.md) — v1.5 commit sequence, scope, deferred items, migration path.

## Scope

**In v1.5:**
- Alt-text generation as the first AI task
- Three providers: Anthropic Claude, OpenAI gpt-4o, Ollama llama3.2-vision (self-hosted)
- Two-axis split per [`design-provider-config.md`](design-provider-config.md) Exception B: provider transport (factory call) + task config (data literal)
- Three-rung inheritance (gazetta → site → target) for both provider/model and per-task config
- Cross-task `ai:` block carries `provider` (factory call) + `model` (data literal); per-task `altText:` block carries `systemPrompt` + `maxTokens` (data literals)
- Per-target `altText.ai` data-literal sub-block accepts full per-task override (provider/model/systemPrompt/maxTokens)
- Per-target behavior fields (`auto`, `maxImageEdge`) at the root of `altText:` (Exception C — runtime knobs, not adapter construction)
- Operator `systemPrompt` prepends to system-composed WCAG-grounded prompt
- Credentials via `process.env.X` passed to provider constructors (no literals in config)
- Auto-fill on upload (default) + on-demand from detail pane
- Structured refusal detection (provider says no → don't auto-fill, show reason)
- Direct multilingual generation (model writes in target locale; no separate translation pass)

**Out of v1.5 (explicit):**
- Translation task (designed for; not implemented)
- Tag suggestion, summarization, image generation
- Capability interface formalization (`AltTextCapableProvider`) — deferred until translation v1.6 proves the abstraction
- Custom prompt policies (full replacement of WCAG-grounded base) — `composePrompt(req, customPolicies)` already supports it; operator-facing config field deferred
- Distributed cache for suggestions (suggester is stateless; multi-replica correct)
- Confidence scoring (the field doesn't exist on the contract)
- Cost monitoring / budget caps
- Admin-side rate-limit throttling (provider SDKs handle their own backoff)
- AI safety/content moderation (provider's own policies apply; we surface refusals structurally)

**Non-goals:**
- Replacing author judgment. AI alt is a suggestion the author can accept, edit, or clear. The author is always the final word.
- Provider-specific quality optimization. We ship neutral prompts that work across Claude, gpt-4o, and llama3.2-vision. Operators tune `model` per task if they want a specific provider's strengths.

## Architecture: three orthogonal layers

AI in Gazetta is **three concerns at three lifetimes**, each with its own home:

| Layer | What it owns | Where it lives | Lifetime |
|---|---|---|---|
| **Provider transport** | API keys, base URLs, organization IDs, timeout, retry policy | `.env.local` (values) → provider constructor in `gazetta.config.ts`/`site.config.ts` | Process |
| **Task configuration** | Per-task model, systemPrompt, maxTokens, behavior flags, sizing | `gazetta.config.ts`/`site.config.ts` data-literal blocks (`ai:` cross-task, `altText:` per-task, target overrides) | Boot lifetime |
| **Cross-task infrastructure** | Refusal detection, prompt composition, vision preprocessing | Code modules under `packages/gazetta/src/ai/` | Code, not config |

These layers don't bleed into each other. Credentials never appear as literals in config files (only as `process.env.X`). Cross-task code never reads config directly — it operates on resolved literal arguments supplied by the resolver. Provider transport (`AIProvider` constructor) carries credentials only; per-task config (data literals) carries operational tuning. Three-rung inheritance (gazetta → site → target) for both transport and task config — see "Three-rung inheritance" below.

### Why two axes, not one big config block

Earlier drafts of this design merged transport and operational config on the provider constructor (`anthropicProvider({apiKey, defaultModel})`). That bundled "where to call" (transport) with "what to ask for" (task config), forcing operators to construct a new provider for every model change.

The locked design splits at the right SOLID seams:

- **Transport** (provider constructor) — fields that bind to "which AI account at which endpoint": apiKey, baseUrl, organizationId, timeout, retryPolicy. Constructed once; reused across tasks.
- **Cross-task fields** (`ai:` block, data literal) — fields that ALL AI tasks legitimately use: provider (the constructed instance), model
- **Per-task fields** (`altText:` / future `translation:` blocks, data literals) — fields that one task uses: systemPrompt, maxTokens, future task-specific knobs
- **Vision-specific fields** stay on vision-using task blocks — `maxImageEdge` is on `altText:`, would also be on a future tag-suggestion task that processes images, never on `translation:`

This split makes one provider instance reusable across N tasks (one Anthropic account serves alt-text, translation, summarization with different per-task model + prompt + token budget). Avoids inventing a "vision tasks" sub-grouping (ISP violation — would mean some tasks implement an interface they don't fully use).

## Configuration model

### Env (`.env.local`)

Process-level credentials only. Gitignored. Never in `site.config.ts`.

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
# OLLAMA_BASE_URL=http://localhost:11434  (optional; default shown)
```

If a provider's adapter is selected but its key is missing, `isAltAdapterConfigured(target)` returns false, the UI hides AI affordances, and any direct route call returns `503 alt_adapter_unavailable` with a structured error. No throw at admin boot — process starts always; per-task features fail at first invocation, where the failure is in context.

### Two-axis split: transport (factory) vs task config (data literal)

Per [`design-provider-config.md`](design-provider-config.md) Path X + Exception B, AI config splits along two axes:

- **Transport** — credentials, base URL, organization ID, timeout, retry policy. Bound to "which AI account at which endpoint." Always a factory call returning an `AIProvider` instance.
- **Task config** — model, systemPrompt, maxTokens. Bound to "what we're asking this provider to do." Always a data literal at the task block.

The provider is **transport-only** by design — it does NOT carry model or prompt. Per-task adapters are constructed by the resolver from `(provider, taskConfig)` at boot. This makes one provider instance reusable across tasks (alt-text, translation, summarization) with different per-task tuning.

### Three-rung inheritance: gazetta → site → target

Both axes inherit through three rungs. Each rung carries documented operator value:

- **Gazetta-level** (`gazetta.config.ts`) — cross-site defaults; useful when one operator runs many sites with shared editorial voice + cost ceilings.
- **Site-level** (`site.config.ts` top-level) — per-site overrides; the dominant rung for solo operators.
- **Target-level** (`site.config.ts` per target) — per-environment tuning (prod uses higher-quality model; staging cheaper).

### Gazetta-level (`gazetta.config.ts`)

```ts
import { defineGazetta, anthropicProvider } from 'gazetta'

export default defineGazetta({
  ai: {
    provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    model: 'claude-haiku-4-5',
  },
  altText: {
    systemPrompt: 'agency editorial voice — concise, descriptive, screen-reader-friendly',
    maxTokens: 300,
  },
  // Future: translation: { systemPrompt: '...', maxTokens: 500 }
})
```

### Site-level (`site.config.ts` top-level)

```ts
import { defineSite, openaiProvider, anthropicProvider } from 'gazetta'

const anthropic = anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! })

export default defineSite({
  name: 'main',
  locales: { default: 'en', supported: ['en', 'fr', 'ja'] },

  // Cross-task transport + model (overrides gazetta-level if set there)
  ai: { provider: anthropic, model: 'claude-haiku-4-5' },

  // Per-task config: alt-text-specific systemPrompt + maxTokens
  altText: {
    systemPrompt: 'descriptive, screen-reader-friendly',
    maxTokens: 300,
  },

  // Behavior fields (auto, maxImageEdge) live at target level — see Exception C below
})
```

**Field inheritance per axis:**

| Field | Chain (most specific first) |
|---|---|
| `provider` | `target.altText.ai.provider ?? site.ai.provider ?? gazetta.ai.provider` |
| `model` | `target.altText.ai.model ?? site.ai.model ?? gazetta.ai.model ?? PROVIDER_DEFAULT_MODELS[provider.name]` |
| `systemPrompt` | `target.altText.ai.systemPrompt ?? site.altText.systemPrompt ?? gazetta.altText.systemPrompt ?? null` |
| `maxTokens` | `target.altText.ai.maxTokens ?? site.altText.maxTokens ?? gazetta.altText.maxTokens` |

The resolver function `resolveAltAdapter(gazetta, site, target)` walks the chain per field and constructs the per-target `AltTextAdapter` via `provider.altText({ model, systemPrompt, maxTokens })`. Per-field inheritance — not per-block — so a site overriding only `altText.systemPrompt` inherits gazetta's `ai.provider`, `ai.model`, and `altText.maxTokens` unchanged.

**`PROVIDER_DEFAULT_MODELS`** (in `packages/gazetta/src/ai/provider.ts`):
```ts
export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.2-vision',
}
```

The resolver always supplies a model to `provider.altText({...})` — either resolved from the chain or the per-provider default. Eliminates two-place defaulting.

### Target-level (`site.config.ts` per target)

Per-target overrides take two shapes:

**Behavior fields (`auto`, `maxImageEdge`)** — at the root of `altText:`. Don't affect adapter construction; the suggester reads them per call.

**Task config (`ai` sub-block)** — accepts `provider`, `model`, `systemPrompt`, `maxTokens` as data literals. Per-field overrides on the inherited chain.

```ts
export default defineSite({
  // ... site-level config above ...

  targets: {
    staging: {
      storage: filesystemStorage(),
      altText: {
        auto: true,                                    // behavior — auto-fire on upload
        maxImageEdge: 1024,                            // behavior — vision-call sizing
        // Inherits ai.provider, ai.model, altText.systemPrompt, altText.maxTokens from site
      },
    },
    production: {
      storage: r2Storage({ /* ... */ }),
      altText: {
        auto: false,                                   // behavior — review-first on prod
        ai: {                                          // task config override
          model: 'claude-sonnet-4-5',                  // higher-quality model for prod
          systemPrompt: 'descriptive, brand-aligned, screen-reader-friendly',
          maxTokens: 400,
          // provider inherits from site.ai.provider (anthropic)
        },
      },
    },
  },
})
```

**Provider override per target.** Operators wanting a different provider on a specific target write the full factory call inside `ai: { provider: ... }`:

```ts
const openai = openaiProvider({ apiKey: process.env.OPENAI_API_KEY! })

targets: {
  production: {
    altText: {
      auto: false,
      ai: { provider: openai, model: 'gpt-4o' },       // OpenAI on prod, Anthropic elsewhere
    },
  },
}
```

This was theoretical in earlier drafts; the data-literal `ai` sub-block at target level makes it concrete. Per-target provider-switching is now a documented capability, not "schema-permits-but-no-UI."

### The capability flag the UI sees

The `/api/targets` endpoint returns `TargetInfo.altText: { available, auto }` per target. The UI renders affordances based on this resolved capability — not on raw config.

```ts
interface AltTextCapability {
  available: boolean    // resolved adapter exists + credentials present
  auto: boolean         // resolved auto flag (post-merge)
}

interface TargetInfo {
  // ... existing fields
  altText: AltTextCapability
}
```

`available` is a process-global truth in v1.5 (one adapter for the admin). It varies per-target only when target-level provider override lands in a future version. The shape is right for now; expansion is additive.

## Code organization

```
packages/gazetta/src/
  ai/                              # cross-task infrastructure
    refusal.ts                     # refusal detection — provider patterns
    compose-prompt.ts              # prompt assembly from typed AltRequest
    prompt-policies.ts             # per-dimension prompt-policy modules
    vision-prep.ts                 # sharp-based resize-to-768 for vision calls
    provider.ts                    # AIProvider type + ResolvedAIBase + resolveAIBase
    errors.ts                      # AI-specific error taxonomy
  alt/                             # alt-text task
    adapter.ts                     # AltTextAdapter interface + AltSuggestion type
    suggester.ts                   # AltSuggester orchestration (cancellation, errors, events)
    null-adapter.ts                # safe default; supports() = false everywhere
    anthropic.ts                   # provider impl
    openai.ts
    ollama.ts
    config.ts                      # ResolvedAltConfig + resolveAltConfig
    index.ts                       # buildAltAdapter factory
```

**`ai/` is a code library, not an inheritance hierarchy.** Tasks compose `ai/` utilities; they don't extend a base class. `alt/` imports `ai/refusal.ts`, `ai/compose-prompt.ts`, `ai/vision-prep.ts`. A future `translate/` directory will import `ai/refusal.ts`, `ai/compose-prompt.ts` (different policies, same composer), and contribute its own task-specific code.

This is composition over inheritance from the start, per [team-preferences.md](team-preferences.md): "Prefer composition over inheritance — use static helpers or injected services, not base classes."

## Alt-text task

### The contract

```ts
// ai/provider.ts — transport-only interface
export interface AIProvider {
  readonly name: string                                              // 'anthropic' | 'openai' | 'ollama' | plugin name
  /** Per-task builder method. Returns a configured adapter. */
  altText(taskConfig: AltTextTaskConfig): AltTextAdapter
  // Future: translation(taskConfig: TranslationTaskConfig): TranslationAdapter
  // Future: summarization(taskConfig: SummarizationTaskConfig): SummarizationAdapter
}

// alt/adapter.ts — task config (data literal) + adapter (factory result)
export interface AltTextTaskConfig {
  /** Resolver always supplies (chain falls back to PROVIDER_DEFAULT_MODELS). */
  model: string
  /** Operator's voice/style override; null/undefined = system default only. */
  systemPrompt?: string
  /** Generation token cap; null/undefined = provider default. */
  maxTokens?: number
}

export interface AltTextAdapter {
  readonly name: string
  /** True when the adapter can describe this MIME (images-only in v1.5). */
  supports(mime: string): boolean
  /** Returns suggestion + structured refusal info; throws on transport / API failure. */
  generate(input: AltGenerateInput, signal?: AbortSignal): Promise<AltSuggestion>
}

export interface AltGenerateInput {
  bytes: Uint8Array
  mime: string
  request: AltRequest               // structured params (locale, maxChars, style)
  prompt: string                    // composed prompt for adapters that inject a string
}

export interface AltRequest {
  locale: string                    // 'en', 'fr', etc. — direct generation, not translate
  maxChars: number                  // 125 default per WAI-ARIA convention
  style: AltStyle
}

export type AltStyle = 'descriptive'  // closed enum; future: 'marketing', 'technical'

export interface AltSuggestion {
  text: string
  /** True when the model declined or couldn't describe the image. */
  refused: boolean
  /** Human-readable reason when refused; null otherwise. */
  refusalReason: string | null
}
```

**No `confidence` field.** Considered and rejected — providers don't expose calibrated confidence for free-form generation; a hardcoded null would be a stub-on-the-interface (LSP violation per [team-preferences.md rule 18](team-preferences.md)). Refusal is the structured signal that earns its place.

**`AltGenerateInput` carries both structured request AND composed prompt.** Adapters that have native parameters (Anthropic's `max_tokens` derivable from `request.maxChars`) use the structured form; adapters that just need a prompt string use the composed form. Both are computed once by the suggester; adapters consume what suits them.

### The orchestration layer

```ts
// alt/suggester.ts
export interface AltSuggester {
  /** True when adapter is configured AND adapter.supports(mime) is true. */
  available(mime: string): boolean
  /** Returns structured suggestion or null when call couldn't complete. */
  suggest(input: SuggestInput, signal?: AbortSignal): Promise<AltSuggestion | null>
}

export interface SuggestInput {
  bytes: Uint8Array
  mime: string
  hash: string                      // identifies asset; used for diagnostics, not cache
  locale: string
  /** When the source is animated, callers pass the analyzer's first-frame poster. */
  posterBytes?: Uint8Array
}
```

The suggester:
- Builds the typed `AltRequest` from inputs + defaults.
- Composes the prompt via `composePrompt(request, policies)`.
- Calls `prepareForVision(bytes, posterBytes, mime, maxImageEdge)` to resize before the adapter call.
- Forwards `AbortSignal` to the adapter.
- Catches transport errors → returns null + emits structured event for UI toast.
- Returns the adapter's `AltSuggestion` directly (including `refused`).

**Stateless** — no memoization. Multi-replica admin scales horizontally without divergent caches. If memoization later proves operationally necessary, it lands as a `CachedAltSuggester` decorator wrapping the base — additive, multi-replica-correct via shared storage. The contract stays cache-free.

### Why no cache

Considered: per-replica `Map<(hash, locale), Promise<AltSuggestion>>` to avoid re-billing for the same image across an auto-suggest + on-demand-click pair. Rejected because:

1. **Multi-replica admin is a documented constraint** ([design-media-implementation.md](design-media-implementation.md) explicitly rejected in-memory designs for the asset-refs index for the same reason).
2. **Real hit rate is low.** Auto-suggest + immediate-click is rare. Auto-suggest + days-later-click is common, but admin processes restart between sessions — a per-replica cache wouldn't help anyway.
3. **The orchestration responsibilities that DO belong on the suggester** (cancellation, error handling, refusal events) don't depend on caching. Removing caching doesn't impair the abstraction; it makes it leaner.

When caching genuinely earns its keep (operationally measured, not speculatively designed), the decorator pattern lands additively.

### Refusal detection

Lives at `ai/refusal.ts` because it's cross-task: a translation refusal looks the same as an alt-text refusal (provider says "I can't comply" via 200 OK with refusal text in the content field).

```ts
// ai/refusal.ts
const SHARED_REFUSAL_MARKERS = [
  "i can't describe",
  "i'm not able to describe",
  "i cannot describe",
  "i'm unable to provide",
  // ... maintained list of cross-provider refusal phrases
]

export function detectRefusal(
  text: string,
  adapterMarkers: readonly string[] = [],
): { refused: boolean; reason: string | null } {
  const lower = text.toLowerCase()
  const allMarkers = [...SHARED_REFUSAL_MARKERS, ...adapterMarkers]
  for (const marker of allMarkers) {
    if (lower.includes(marker)) {
      return { refused: true, reason: text.slice(0, 200) }
    }
  }
  if (text.trim().length < 5) {
    return { refused: true, reason: 'Empty or unusably short response' }
  }
  return { refused: false, reason: null }
}
```

Each adapter calls `detectRefusal(rawText, ANTHROPIC_SPECIFIC_MARKERS)` (or its provider's equivalent) and constructs the `AltSuggestion` with structured fields. The UI consumes the structured signal directly — never inspects `text` for refusal substrings (DIP violation prevented).

### Vision preprocessing

```ts
// ai/vision-prep.ts
export interface PreparedImage {
  bytes: Uint8Array
  mime: string                      // 'image/jpeg' | 'image/png' (post-prep)
}

export async function prepareForVision(input: {
  bytes: Uint8Array
  mime: string
  posterBytes?: Uint8Array          // animated-image first-frame, when applicable
  maxEdge?: number                  // default 768
}): Promise<PreparedImage>
```

**Default 768 max edge.** Smallest size that fits all three v1.5 providers natively without quality loss:

| Provider | Native input | At 768 |
|---|---|---|
| Ollama llama3.2-vision | 1120×1120 | Fits, no downsample |
| Anthropic Claude (non-Opus) | 1568px long edge | ~786 tokens (well under 1568 ceiling) |
| OpenAI gpt-4o (high detail) | 768 short-edge target | Exactly 4 tiles + base = 765 tokens |

768 is also where OpenAI's high-detail mode targets the short edge — chosen by OpenAI because it's where text in images remains legible for their model. Below 768 starts trading documented quality for cost.

**`maxImageEdge` is per-task** because vision tasks may want different sizes (a future tag-suggestion task on detailed product shots might want 1024). Default 768; per-task site-level override; per-target task-level override.

**Animated images use the analyzer-extracted poster.** The animated-image analyzer (shipped in media v1 step 31) already extracts a first-frame PNG poster. The suggester passes those bytes to `prepareForVision` instead of re-rasterizing. Cross-feature reuse, no duplication.

**SVG rasterizes to PNG** at MAX_EDGE before the vision call (sharp via SVG renderer at 144 dpi). OpenAI doesn't accept SVG natively; uniform handling beats per-adapter SVG fallback.

**Skip resize when source ≤ MAX_EDGE.** No re-encode; original bytes pass through.

### Prompt composition

The prompt is **policy**, not a string. Composing it from typed dimensions per [team-preferences.md rule 18](team-preferences.md) ("build structurally right from the start").

```ts
// ai/prompt-policies.ts — each policy contributes one paragraph
export function taskFramingPolicy(req: AltRequest): string
export function styleGuidancePolicy(req: AltRequest): string
export function lengthPolicy(req: AltRequest): string
export function localePolicy(req: AltRequest): string
export function outputDisciplinePolicy(req: AltRequest): string

// ai/compose-prompt.ts
export type PromptPolicy = (req: AltRequest) => string

export function composePrompt(
  req: AltRequest,
  policies: readonly PromptPolicy[] = DEFAULT_POLICIES,
): string
```

**Why typed policies, not a single string constant:**
- SRP: each policy changes for one reason. Locale strategy change → `localePolicy` only. WCAG guidance update → `styleGuidancePolicy` only.
- OCP: new style (e.g., `'marketing'`, `'technical'`) extends the `AltStyle` enum + adds a switch arm. Other policies untouched.
- Testability: each policy unit-tests independently; the composer tests assembly.

**Locale-aware generation, not translation.** `localePolicy` adds "Write the description in {locale}." when locale ≠ 'en'. Modern vision models are competently multilingual. Translation as a separate pipeline (vision → English → translate) was rejected: more API calls, translation artifacts (e.g., translating UI text like button labels that should stay in source language), and a parallel `TranslationAdapter` system before its second consumer exists.

If Ollama's non-English quality proves insufficient in real use, an opt-in `translateFrom: 'en'` per-task field activates a translation pipeline. Additive; no v1.5 design cost.

**Operator's `systemPrompt` prepends to the system-composed prompt.** The resolved task config carries an optional `systemPrompt` (chained from gazetta → site → target per Exception B). When present, the suggester prepends it to the system-composed output:

```ts
// In suggester.ts
const operatorPrompt = adapter.config.systemPrompt  // string | null from chain resolution
const systemComposed = composePrompt(request, DEFAULT_POLICIES)
const finalPrompt = [operatorPrompt, systemComposed].filter(Boolean).join('\n\n')
```

Operator extends, never replaces. WCAG guidance, length constraints, locale handling, output discipline stay under system control via the typed policies. Operator adds voice/style on top.

**Custom prompt policies** (full replacement of the WCAG-grounded base) remains a v1.6+ deferred capability. The current `composePrompt(req, policies)` signature already accepts a custom policy array — when v1.6 ships custom policies, it becomes a per-site or per-task config field threaded through the resolver. v1.5 surface stays at "operator prepends voice; system owns the rest."

## Provider adapters

### What each adapter owns

- Provider SDK construction (with transport from `AIProvider` constructor: apiKey, baseUrl, etc.)
- Per-task config storage (model, systemPrompt, maxTokens — supplied by resolver via `provider.altText({...})`)
- Request shape: convert `AltGenerateInput` + stored task config → provider-specific request body
- Response parsing: extract text from provider response shape
- Refusal detection: call `detectRefusal` with provider-specific markers
- AbortSignal forwarding
- Provider-specific error → `AltAdapterError` translation

### What no adapter owns

- Reading env vars (operator passes via `process.env.X` to provider constructor)
- Resolving the per-task config chain (resolver does this; adapter receives final values)
- Image preprocessing (`vision-prep.ts` does this)
- Prompt composition (`compose-prompt.ts` does this; operator's `systemPrompt` prepended by suggester)
- Memoization (the suggester is stateless; no memoization in v1.5)
- UI concerns (consumers handle errors and refusals)

### Three providers in v1.5

| Provider | API | Auth | Default model (`PROVIDER_DEFAULT_MODELS`) | Why ship |
|---|---|---|---|---|
| **Anthropic** | `messages.create` with image content block | `ANTHROPIC_API_KEY` (transport-only at constructor) | `claude-haiku-4-5` | Aligned with the codebase's tooling; well-priced; multilingually competent |
| **OpenAI** | `chat.completions` with `image_url` (base64 data URL) | `OPENAI_API_KEY` | `gpt-4o-mini` | Wide adoption; cheapest paid SaaS; required for substitution proof |
| **Ollama** | HTTP to `/api/generate` (or `/api/chat`) | None (local; `OLLAMA_BASE_URL` optional) | `llama3.2-vision` | Self-hosted; zero-cost; bytes never leave operator infra; required for self-hosted parity |

Provider constructors take **transport only** — apiKey, baseUrl, organizationId, timeout, retryPolicy. They do NOT take `model` or `defaultModel` (removed; lived on the constructor in earlier drafts). Default models live in the resolver's chain fallback (`PROVIDER_DEFAULT_MODELS[provider.name]`); per-provider `.altText({...})` receives a non-optional model from the resolver.

Three providers prove the abstraction holds (one paid, one paid alternative, one self-hosted). Future adapters (Gemini, Cloudflare Workers AI) land additively.

### Why three, not one

If only Anthropic shipped, we'd be guessing whether the interface generalizes. Two adapters force real generalization (auth shape, request shape, response parsing, error taxonomy). Three confirms — and importantly, gives self-hosted operators a path that doesn't depend on cloud SaaS.

## Runtime model

### When AI runs

| Trigger | Where | Decision |
|---|---|---|
| Asset uploaded, `auto: true`, target has adapter, MIME supported | `AssetUploadZone.vue` upload-list row | Auto-fire `POST /api/assets/:name/suggest-alt` after upload completes |
| Author clicks "✨ Suggest" in detail pane | `AssetAltEditor.vue` | Fire suggest call on demand, regardless of `auto` |
| Author types into alt input while suggest is in flight | `AssetUploadZone.vue` row | Abort the suggest call; author intent wins |

**Auto-suggest is post-upload, client-driven, one extra HTTP round-trip.** Folding the AI call into the upload pipeline (server-side at upload time) was rejected: AI failure would fail the upload itself; latency on bulk uploads stacks unacceptably; SRP violation in `ingest.ts`.

### The route

```
POST /api/assets/:name/suggest-alt?target=&locale=
→ 200 { text: "...", refused: false, refusalReason: null }
→ 200 { text: "I can't describe this image.", refused: true, refusalReason: "..." }
→ 503 { code: 'alt_adapter_unavailable' }
→ 502 { code: 'alt_suggestion_failed' }
→ 404 { code: 'asset_not_found' }
→ 400 { code: 'invalid_request' }
```

**Refusal returns 200 with `refused: true`.** The API call succeeded; the model declined. This matches the existing pattern (`POST /api/publish` returns 200 with `{ ok: false, errors }` when content validation fails). HTTP status reflects API success/failure; body fields reflect domain results.

**Server fetches bytes from storage.** Upload-list row passes `name`; server reads bytes via the existing storage abstraction. Doesn't accept fresh bytes in the POST body — that would either duplicate the upload route's contract or split the surface (one route accepting name, another accepting bytes; ISP violation). The "saved storage read" optimization is sub-perceptible (~50ms hot cache hit for fresh writes).

### How the UI knows

`/api/targets` reports `TargetInfo.altText: { available, auto }` per target. The UI reads this on admin load and on `site.config.ts` reload (existing SSE infrastructure). No probe-by-failure; no separate capability endpoint.

```vue
<!-- AssetUploadZone.vue (excerpt) -->
<script setup>
async function onUploadComplete(result) {
  if (activeTarget.value.altText.available && activeTarget.value.altText.auto) {
    fireSuggestAlt(result.name)  // background, non-blocking
  }
}
</script>

<!-- AssetAltEditor.vue (excerpt) -->
<Button v-if="activeTarget.altText.available" @click="suggest">
  ✨ Suggest
</Button>
```

## Security

### Provider trust boundary

Bytes leave the admin process when the suggester calls a SaaS adapter. Operators choosing Anthropic/OpenAI accept that asset bytes are sent to those providers' servers, subject to those providers' data-handling policies. Ollama operators keep bytes local.

**Documented prominently** in `docs/content-assets.md` (AI alt section): "When using Anthropic or OpenAI, asset bytes are sent to the provider for description. Use Ollama for self-hosted privacy."

### Content moderation

We do **not** add a moderation layer. Provider safety policies apply (Claude refuses certain content; gpt-4o has its own categories; Ollama has minimal filtering). Refusals surface structurally so authors see why their image wasn't described. We don't second-guess provider decisions.

### API key exposure

Keys live in `.env.local` (gitignored, per [operations.md](operations.md)). Operators pass `process.env.X_API_KEY` to provider constructors in `gazetta.config.ts` or `site.config.ts`. Never logged. Never returned in API responses. Never embedded as literals in config files.

If a key is missing for a configured provider, the provider constructor throws at config-eval (operator's `process.env.X!` non-null assertion is the explicit failure point). `isAltAdapterConfigured(target)` returns false at the capability check; the route returns `503 alt_adapter_unavailable`; the UI hides affordances. No leak path.

### Prompt injection

User-uploaded images could theoretically contain text that influences the model's response. The current prompt structure (model receives image + instruction) makes prompt-injection-via-image hard but not impossible. Mitigations:

- The composed prompt is explicit about the task ("Output the description only, no preamble or quotes") which the model treats as system-level guidance.
- Refusal detection catches "I won't follow these new instructions" responses.
- The output is alt text shown to the author for review (unless `auto: true` AND no refusal, in which case it pre-fills the input — author can still edit before save).

For sites uploading user-generated content (future use case), authors should review AI-suggested alt before publish. The `altText.auto: false` flag puts review-first mode in operator control.

## Distinctive choices

### Compared to other CMSes

- **Strapi Growth** — built-in AI alt, but coupled to Strapi's specific deployment model. Gazetta's adapter abstraction is provider-agnostic and admin-process-local.
- **Storyblok** — AI alt text included from the Growth plan up, not on Starter ([pricing](https://www.storyblok.com/pricing), checked 2026-10-23). Gazetta ships it in v1.5 for every site.
- **Directus 11.16** — a three-provider adapter (OpenAI, Anthropic, Gemini) for image and PDF uploads to its AI assistant, not alt-text generation ([release notes](https://github.com/directus/directus/releases/tag/v11.16.0)); a similar architectural choice. Gazetta's pattern is similar but explicitly cross-task-ready (the `ai:` block + `ai/` infrastructure code anticipates translation, summarization, etc.).
- **Sanity / Contentful / Payload** — no shipped AI alt as of design time. Operators wire their own integrations.

### Architectural choices

**Two-axis split: transport (factory) vs task config (data literal).** Provider constructors carry transport only (apiKey, baseUrl, etc.); per-task data-literal blocks (`ai:`, `altText:`) carry model + systemPrompt + maxTokens. One provider instance is reusable across tasks (alt-text, translation, summarization) with different per-task tuning. The split is the natural ISP boundary — provider is "where to call," task config is "what to ask for."

**Three-rung inheritance (gazetta → site → target).** Each rung has documented operator value: gazetta-level for agency multi-site setups; site-level for per-site brand voice; target-level for environment-specific tuning (prod higher quality, staging cheaper). Per [`design-provider-config.md`](design-provider-config.md) Exception B; AI is the only Pattern-A surface that earns three rungs because it's the only one where each rung carries independent value.

**Per-task config blocks, not a single AI block.** Each AI capability has its own concerns; bundling them creates SRP violations. Cross-task fields (`provider`, `model`) live in the shared `ai:` block; per-task fields (`systemPrompt`, `maxTokens`) live in per-task blocks (`altText:`, future `translation:`).

**Cross-task code under `ai/` from the start.** Not after the second consumer materializes. Refusal detection, prompt composition, vision preprocessing are conceptually cross-task even with one consumer in v1.5. Right structure now beats right structure later, because translation is on the documented roadmap.

**Stateless suggester (no memoization).** Multi-replica admin correctness over per-replica optimization. Caching is a future decorator, additive.

**Direct multilingual generation, not translation pipeline.** Lower latency, lower cost, better idiomatic output, and avoids designing a `TranslationAdapter` system before its second consumer exists.

**Refusal as structured signal, not confidence number.** The honest categorical: did the model decline? Not a fake graduated score. Consumers branch on `refused`, not `confidence < threshold`.

**Operator's `systemPrompt` prepends to system-composed prompt.** Operator extends WCAG-grounded base; never replaces. Custom prompt policies (full replacement) deferred to v1.6+. Keeps accessibility floor under system control.

## Migration

### Existing sites

`site.config.ts` files without `ai:` or `altText:` blocks continue to work — AI alt is a v1.5 feature behind explicit config. Operators opt in by adding the blocks.

### Existing assets

The detail-pane "✨ Suggest" button works on assets uploaded before AI alt was configured. Backfill is per-asset, on-demand. No bulk-suggest in v1.5; deferred to a CLI command (`gazetta assets suggest-alt --all`) when the use case surfaces.

### Provider switching

Changing the cross-task default provider:

```ts
// Before
ai: { provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }), model: 'claude-haiku-4-5' }

// After
ai: { provider: openaiProvider({ apiKey: process.env.OPENAI_API_KEY! }), model: 'gpt-4o-mini' }
```

Operator updates `.env.local` to provide the new credentials and the config file to point at the new factory. Restarts the admin process (production) or relies on hot reload (`gazetta dev`).

No data migration. Existing alt text on assets is unchanged. New suggestions come from the new provider.

### Schema migration from v1.5 transport+model conflated shape

Earlier v1.5 drafts conflated transport and model on the provider constructor (`anthropicProvider({ apiKey, defaultModel })`). The locked design splits them. Operators with the conflated shape migrate by:

```ts
// Before (conflated)
ai: anthropicProvider({ apiKey: '...', defaultModel: 'claude-haiku-4-5' })

// After (split)
ai: { provider: anthropicProvider({ apiKey: '...' }), model: 'claude-haiku-4-5' }
```

`AltTextSiteConfig.model` (was a top-level site field) → `site.ai.model`.
`AltTextTargetConfig.model` (was a top-level target field) → `targets.X.altText.ai.model`.
`AIConfig.defaultModel` (cross-task site field) → `site.ai.model` (same name across rungs).

Hard cutover per ADR-0005 / ADR-0008 precedent. Pre-1.0 product; operators absorb the rewrite.

# Content Authoring with Assets

How to use the asset library as a content author. Upload, organize,
override per locale, set focal points, fix alt text — what each
affordance does and when to use it.

For the design model, see [`.claude/rules/design-media.md`](../.claude/rules/design-media.md).

## Opening the library

Three entry points, all stay synced with the active target:

| Where | When |
|---|---|
| **`Cmd+L` / `Ctrl+L`** | Anywhere in the admin |
| **Asset picker** in a page editor | A schema field declares `embeddedAsset()` / `downloadable()` / `fontAsset()` |
| **Active-target menu → Asset library** | Manual entry from the top bar |

The library shows assets on the **active target** — switch targets in
the top bar and the library refreshes.

## Uploading

Drag-and-drop into the upload zone or click to pick files. Image
uploads (JPEG, PNG, SVG) get responsive variants generated in the
background; SVGs are sanitized before storage (script tags, event
handlers, external `href`s, CSS that loads from another site, and
oversized embedded base64 are all stripped or rejected).

Each upload becomes one **history revision** — `Cmd+Z`-equivalent
undo via the history panel. Bulk drops produce one revision per file
so you can selectively roll back.

### Alt text at upload (optional)

When an image upload finishes, the row in the upload list shows an
inline alt-text input:

```
hero.jpg                              Done
[ Describe the image ........ ] ☐ Decorative
```

Three behaviors:
- **Type alt + tab away** → meaningful alt saved
- **Check "Decorative"** → alt set to `""` (screen readers skip it)
- **Skip / close library** → alt stays `null`; the library card shows
  an amber "ALT" badge so you can fix it later

Alt is non-blocking at upload — fill it now, fill it later via the
detail pane, or override per-use on each page that references the asset.

If AI alt-text is configured for the target (see "AI alt-text"
below), the input pre-fills with a model-generated description after
upload. Type into the input to override; the in-flight suggestion
aborts when you start typing.

### Locale-bytes upload (when active locale ≠ default)

If the **active locale** is not the site's default locale, and you
drag a file whose name matches an existing asset, the admin asks:

| Choice | What happens |
|---|---|
| **Replace default bytes** | The new bytes become the canonical asset. Every locale that doesn't have its own override now uses these. |
| **Add {locale} bytes override** *(recommended)* | The default stays. The new bytes are used only when this locale is active. |
| **Cancel** | Abort. |

The "Add override" branch creates a new manifest variant
(`hero.asset.fr.json`) and stores the bytes under
`hero-{hash}.fr.jpg`. When a different locale is active, the resolver
falls back through `(active locale, active theme) → (active locale,
default theme) → (default locale, …)` so French pages get the French
bytes and English pages get the default.

## The detail pane

Click a card. The right pane shows:

```
[thumbnail]
hero
─────────────────
Kind         embedded
Type         image/jpeg
Size         245 KB
Dimensions   1920 × 1080
Alt          [ Mountain sunset ] ☐ Decorative
Focal point  [ ⊕ ]                  50% × 30%   Reset
             ▢ ▢ ▢ ▢                            (1:1, 16:9, 4:5, 9:16 previews)
─────────────────
LOCALE BYTES
[Default]    en    245 KB · 1920×1080
[fr]         override                       Remove override
+ Add ar version
─────────────────
Uploaded     2026-04-22 14:23
[ Delete ]
```

### Editing alt

Inline three-state input + "Decorative" checkbox. Commits on blur.

When AI alt-text is configured for the active target, a `✨ Suggest`
button appears below the alt editor. Clicking it asks the configured
provider to describe the image; the suggestion fills the alt input
and commits to the manifest. Edit and tab away to override the
suggestion. See "AI alt-text" below for setup.

### AI alt-text (optional)

When the active target has `altText:` configured (see "Configuring
AI alt-text" below), the asset library and upload list gain AI
suggestions:

- **At upload time** (when `auto: true`, the default): every
  successful image upload triggers a suggestion in the background.
  The alt input pre-fills with the model's description and the
  hint `✨ AI suggested — edit or accept` appears. Type into the
  input to override; the in-flight suggestion aborts.
- **On demand** (always available when AI is configured): the
  detail pane's `✨ Suggest` button generates alt for any image
  asset, regardless of the `auto` setting. Useful for assets
  uploaded before AI was configured, or when a previous suggestion
  was rejected.

Multilingual: the model writes alt directly in the active locale.
Switching to French in the locale picker and clicking `✨ Suggest`
returns French alt text.

When the model declines (some images trigger provider safety
filters), the alt stays empty and an inline `✨ AI declined — please
write alt manually` hint appears. Refusal is rare for typical
content; uploads always succeed regardless.

#### Configuring AI alt-text

Two layers in `site.config.ts`. The provider transport is a factory
call (carries credentials); per-task knobs are data literals:

```ts
import { defineSite, anthropicProvider } from 'gazetta'

export default defineSite({
  // Cross-task AI configuration — provider transport (factory call) + cross-task model
  ai: {
    provider: anthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    model: 'claude-haiku-4-5',        // optional; per-provider sensible default
  },

  // Per-task config — alt-text behavior + tuning
  altText: {
    systemPrompt: 'descriptive, screen-reader-friendly',  // optional voice override
    maxTokens: 300,                   // optional; provider default otherwise
  },
})
```

API credentials live in `.env.local` (gitignored, never as literals
in `site.config.ts` — the factory call references `process.env.X`):

```
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
# OLLAMA_BASE_URL=http://localhost:11434  (optional; default shown)
```

**Per-target overrides** — behavior fields (`auto`, `maxImageEdge`)
sit at the root of `altText:`; task-config and provider overrides
live in the per-target `altText.ai` sub-block:

```ts
import { openaiProvider } from 'gazetta'

targets: {
  production: {
    altText: {
      auto: false,                   // behavior — require explicit click on prod
      maxImageEdge: 1024,            // behavior — vision-call image-resize cap
      ai: {                          // task-config override (Exception A)
        provider: openaiProvider({ apiKey: process.env.OPENAI_API_KEY! }),
        model: 'gpt-4o',             // higher-quality model for prod
        systemPrompt: 'descriptive, brand-aligned, screen-reader-friendly',
        maxTokens: 400,
      },
    },
  },
}
```

Behavior fields (`auto`, `maxImageEdge`) live at the root of
`altText:` because they don't affect adapter construction. Task
config (`provider`, `model`, `systemPrompt`, `maxTokens`) goes inside
`altText.ai` and inherits the gazetta → site → target chain
per-field.

#### Provider choice

| Provider | What it costs | What's it good for |
|---|---|---|
| `anthropic` | ~$0.003/image (Haiku); higher for Sonnet/Opus | Default SaaS choice. Strong multilingual quality. |
| `openai` | Varies — gpt-4o-mini's vision pricing differs from text. Benchmark against your asset library before optimizing | Wide adoption; easy if your team already has an OpenAI account |
| `ollama` | Zero (self-hosted) | Privacy-first or air-gapped deployments. Bytes never leave the server running Ollama. Slower on CPU; needs `ollama pull llama3.2-vision:11b` first |

#### Privacy considerations

When using Anthropic or OpenAI, asset bytes are sent to the
provider's servers for description. Each provider has its own data-
handling and retention policy — review them before configuring AI
alt-text on a target with sensitive imagery. Use `ollama` for
fully self-hosted workflows where no asset data leaves your
infrastructure.

The model's response (alt text) is stored in the asset's manifest
in the same target storage as the rest of your content. No AI-
specific data is recorded outside the asset manifest.

### Setting a focal point

Click anywhere on the focal-point preview. The marker locks in;
drag to fine-tune. The four aspect-ratio thumbnails (1:1, 16:9,
4:5, 9:16) update live so you can see what the crop will look like
in different contexts.

`Reset` returns to the default (no preference set; templates render
at center). The x/y badge shows the current focal as a percentage.

### Locale bytes section

Always visible when the site has more than one locale. Shows:
- **Default** row (always present, shows the canonical bytes)
- One row per existing locale-bytes override
- `+ Add {locale} version` button for every site-supported locale
  that doesn't have an override

Click `+ Add fr version` → file picker → upload. The new bytes are
used for French content; English content keeps using the default.

`Remove override` deletes one locale-bytes variant; that locale falls
back to the default bytes after removal.

### Library card coverage badge

Each card in the grid shows a chip strip:

```
en (default — primary color)
fr (override — blue)
ar (fallback — dashed border)
```

At a glance: which locales have their own bytes, which fall back to
default, and where the missing-alt nag (separate amber "ALT" pill on
the thumbnail) needs attention.

## Replace, rename, delete

### Replace

When you want to swap one asset for another *without* breaking any
references — author picks a replacement asset from the library, the
admin rewrites every reference (across pages, fragments, every
locale variant) to point at the new asset, then deletes the old one.
One history revision covers the whole operation.

Compatibility: replace requires the same kind + same MIME category.
Image → image (JPEG → PNG is fine), but image → PDF is rejected.

### Rename

Like replace but the asset's identity stays the same — bytes and
manifest move from `hero` to `banner`, every reference rewritten,
old paths cleaned up. One history revision.

**v1 limitation:** rename refuses on assets that have locale-bytes
overrides. Remove the overrides first, then rename. (Override-aware
rename is tracked for v1.5.)

### Delete

| State | Behavior |
|---|---|
| 0 references | Confirm + delete |
| 1+ references | Blocked. Detail pane shows the "in use" panel — click a referenced page to fix it, OR pick a replacement |

When an asset has locale-bytes overrides, deleting the asset cascades
through all overrides — bytes, variants, locale manifests all removed
in one history revision.

## Picking assets in the page editor

When a template field declares an asset reference (`embeddedAsset`,
`downloadable`, `fontAsset`), the page editor renders an asset-picker
button. Clicking opens the library modal with the field's `accept`
filter applied — only compatible assets are shown.

Confirm picks the asset. The reference-options step (when the field
allows alt or focal-point overrides) shows the chain explicitly:

```
Alt text
[ Page-specific alt for this hero ]
   Falls back to: "Mountain sunset" (asset's alt)

Focal point
[focal picker, defaults to asset's focal]
```

Per-reference values live on the page manifest — they don't change
the asset itself. Useful when the same hero image needs different
alt text on the homepage vs. the about page, or different framing
in different layouts.

## Per-asset history

Every asset operation (upload, replace, rename, delete, alt edit,
focal edit, locale-bytes override) records a history revision on
the active target. Open the history panel from the top-bar target
menu to undo individual changes or restore an earlier revision.

History is per-target — undo on a non-default target (e.g. staging)
doesn't affect production.

## Locale and theme model recap

Two override dimensions:

| Dimension | Drives | Examples |
|---|---|---|
| **Locale** | Language-specific bytes | French version of a hero with text baked in |
| **Theme** | Presentation-specific bytes | Dark-mode logo |

Either can be overridden, both, or neither. The resolver picks at
render time using the **locale-priority fallback chain**: when
serving `(fr, dark)` and a French dark variant doesn't exist, try
French light; only fall through to default-locale variants when no
French variant exists at all.

In v1 the asset library exposes locale overrides; theme overrides
are a v1.5 UX surface (the data model already supports them).

## See also

- [`.claude/rules/design-media.md`](../.claude/rules/design-media.md) — full design model
- [`.claude/rules/design-editor-ux.md`](../.claude/rules/design-editor-ux.md) — active-target UX, switching, undo
- [`.claude/rules/design-ai.md`](../.claude/rules/design-ai.md) — AI integration design (alt-text + future tasks)
- [template-assets.md](template-assets.md) — for template developers

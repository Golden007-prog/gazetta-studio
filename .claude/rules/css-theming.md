# CSS and Theming (apps/admin)

How the admin SPA handles colors, dark mode, and design tokens. Audit snapshot + target shape.

## Current state (as of 2026-04-14)

- **20 style blocks** across 15 Vue components (14 `<style scoped>`, 6 unscoped)
- **74 unique hex values**, **273 total occurrences** — heavy duplication (e.g. `#450a0a` appears 6× for error backgrounds across 3 components)
- **No formal methodology** — BEM-adjacent naming (`.publish-warning`, `.changes-state`), no utility layer, no spacing/radius scale
- **No `var(--p-*)` usage** — PrimeVue emits 595 design tokens but the admin consumes zero of them

## PrimeVue design tokens (Aura)

PrimeVue v4 + Aura emits semantic + primitive tokens to `:root`. Verified live:

The admin uses `adminPreset` (`apps/admin/src/client/assets/preset.ts`), Aura with light-mode primary moved to emerald-700 and the danger button to red-600 (red-700 for text/outlined), so white-on-fill and coloured text meet WCAG AA (#863). Dark mode is stock Aura. Both `main.ts` and `.storybook/preview.ts` import it; the Storybook gate runs axe `color-contrast` against it in both light and dark (`vitest.storybook.config.ts`, one project per theme). Page-level `body` styles live in `assets/base.css`, shared by both, so stories render on the same themed page as the admin.

**Semantic tokens — auto-flip on `.dark` class:**

| Token | Light | Dark |
|---|---|---|
| `--p-text-color` | `#334155` | `#ffffff` |
| `--p-text-muted-color` | `#64748b` | `#a1a1aa` |
| `--p-content-background` | `#ffffff` | `#18181b` |
| `--p-content-hover-background` | `#f1f5f9` | `#27272a` |
| `--p-content-border-color` | `#e2e8f0` | `#3f3f46` |
| `--p-form-field-background` | `#ffffff` | `#09090b` |
| `--p-form-field-border-color` | `#cbd5e1` | `#52525b` |
| `--p-primary-color` | `#047857` (emerald-700, admin preset) | `#34d399` |

**Primitive palette — does NOT flip:**

`--p-red-50..950`, `--p-green-*`, `--p-amber-*`, `--p-blue-*`, `--p-gray-*`, `--p-slate-*`, `--p-zinc-*`, etc. Each palette goes 50→950 (eleven shades). Stable across modes.

**Radii:** `--p-border-radius-none/xs/sm/md/lg/xl` (six variants). Reuse these — do not invent new radius tokens.

## Theme switching

`useThemeStore.apply()` toggles BOTH `dark` and `light` classes on `<html>` (commit 773248f). PrimeVue is configured with `darkModeSelector: '.dark'`, so `--p-*` semantic tokens flip automatically.

**Important:** `.light` selectors in component CSS ARE live. `.dark` selectors ARE live. Only one class is ever active at a time.

## Target token structure

When refactoring, layer app-level semantic tokens on top of PrimeVue primitives in a single `apps/admin/src/client/assets/tokens.css`:

```css
/* Auto-flip aliases of PrimeVue semantic tokens — no explicit .dark needed */
:root {
  --color-bg: var(--p-content-background);
  --color-fg: var(--p-text-color);
  --color-muted: var(--p-text-muted-color);
  --color-border: var(--p-content-border-color);
  --color-hover-bg: var(--p-content-hover-background);
  --color-input-bg: var(--p-form-field-background);
  --color-input-border: var(--p-form-field-border-color);
  --color-primary: var(--p-primary-color);
}

/* Status tokens — explicit light/dark since palette primitives don't flip */
:root {
  --color-danger-bg: var(--p-red-50);
  --color-danger-fg: var(--p-red-700);
  --color-success-bg: var(--p-green-50);
  --color-success-fg: var(--p-green-700);
  --color-warning-bg: var(--p-amber-50);
  --color-warning-fg: var(--p-amber-900);
  --color-info-bg: var(--p-blue-50);
  --color-info-fg: var(--p-blue-900);
  --color-env-prod-bg: var(--p-red-100);
  --color-env-prod-fg: var(--p-red-800);
  --color-env-staging-bg: var(--p-amber-100);
  --color-env-staging-fg: var(--p-amber-800);
}
.dark {
  --color-danger-bg: var(--p-red-950);
  --color-danger-fg: var(--p-red-300);
  --color-success-bg: var(--p-green-950);
  --color-success-fg: var(--p-green-400);
  --color-warning-bg: var(--p-amber-950);
  --color-warning-fg: var(--p-amber-300);
  --color-info-bg: var(--p-blue-950);
  --color-info-fg: var(--p-blue-300);
  --color-env-prod-bg: var(--p-red-950);
  --color-env-prod-fg: var(--p-red-300);
  --color-env-staging-bg: var(--p-amber-950);
  --color-env-staging-fg: var(--p-amber-300);
}
```

~50 LOC, ~20 custom tokens. Aliases (8) need no dual definition. Status + env (12) need `:root` + `.dark`.

## Do and don't

**Do:**
- Consume PrimeVue semantic tokens (`var(--p-text-color)` etc.) directly in component CSS when the intent matches
- Use `var(--p-border-radius-sm/md/lg)` instead of raw `4px/6px/8px`
- Use `var(--p-red-*)` and siblings as primitive references inside `tokens.css`
- Add new semantic tokens (`--color-nav-active-bg`) when a color appears in 3+ places

**Don't:**
- Apply theme tokens via JS runtime (`:style="themeVars"`). The current `themeVars` blocks in EditorPanel.vue and DevPlayground.vue are **tech debt** — 54 LOC of duplicated JS — slated for removal
- Invent `--app-*` or `--theme-*` prefixes. Use `--color-*` for colors; reuse `--p-*` directly for structural primitives (radii, spacing)
- Hard-code hex values for status/semantic concepts (error, success, info) — always via tokens
- Add `.dark .foo` / `.light .foo` overrides when a token would flip automatically (use `var(--color-*)` instead)

## Specificity and scoping

Vue SFC `<style scoped>` adds `[data-v-xxx]` attribute selectors. `.dark` and `.light` selectors in a scoped block keep their specificity — they work. But for simplicity, put `.dark .foo` overrides in an unscoped `<style>` block at the bottom of the SFC (existing convention in PublishDialog, ChangesDrawer).

Only 8 `:global(.dark)` uses in the entire codebase — not a systemic pattern. Avoid adding more.

## `--gz-*` legacy tokens

14 `--gz-*` tokens (`--gz-bg-input`, `--gz-text`, `--gz-border`, `--gz-accent`, etc.) are defined twice — once in EditorPanel.vue, once in DevPlayground.vue, both via JS `themeVars` computed applied to `:style`. They're consumed by:

- [packages/gazetta/src/editor/mount.tsx](packages/gazetta/src/editor/mount.tsx) — the `.gz-editor` stylesheet for the rjsf editor shell
- [examples/starter/admin/fields/brand-color.tsx](examples/starter/admin/fields/brand-color.tsx) — custom field using `var(--gz-accent, fallback)` pattern

When refactoring, move these to `tokens.css` with the new `--color-*` names; rewrite mount.tsx and brand-color.tsx to use the new names. No backwards-compat constraint.

## User theming

`admin/theme.css` shipped: site authors customize colors with **static CSS overrides, no API** — simplest path, defers the JS preset layer until the product is mature enough to justify it.

Shape:

```
my-project/
  admin/
    theme.css          # optional, user-authored
```

Load order: PrimeVue Aura CSS → our `tokens.css` → user's `theme.css` (last, wins cascade). The admin appends the `theme.css` link right after `app.mount()` (`apps/admin/src/client/main.ts`) so it lands after PrimeVue's runtime-injected styles; the server answers an empty stylesheet when the file doesn't exist. Component-scoped PrimeVue tokens (`--p-button-*`) are order-dependent: they inject when each component first appears — before `theme.css` for first-screen components (a `theme.css` override wins there), after it for components that first mount later, like badges (the override loses at equal specificity; use a more specific selector).

User overrides any `--p-*` or `--color-*` token in `:root` and `.dark`, and/or declares custom tokens for their own editors/fields:

```css
/* admin/theme.css */

/* Override Gazetta tokens */
:root {
  --p-primary-color: #7c3aed;
  --color-danger-bg: #fef2f2;
}
.dark { --p-primary-color: #a78bfa; --color-danger-bg: #2a0a0a; }

/* Custom tokens for user's editors/fields — use a prefix you own */
:root {
  --myapp-json-key: #6366f1;
  --myapp-json-string: #10b981;
}
.dark {
  --myapp-json-key: #a5b4fc;
  --myapp-json-string: #4ade80;
}
```

**Reserved prefixes — users must not invent new tokens in these namespaces:**
- `--p-*` — PrimeVue (override existing, don't add new)
- `--color-*` — Gazetta semantic layer (override existing, don't add new)

Users pick their own prefix for custom tokens. One file, one place to look.

**Known limitation:** derived tokens are `var()` references to the primary palette's shades, not to `--p-primary-color` and not literal hex. Which shade depends on the preset and the mode — the admin ships `adminPreset` (`apps/admin/src/client/assets/preset.ts`), which moves light mode's primary for WCAG AA:

| Token | Light (`:root`) | Dark (`.dark`) |
|---|---|---|
| `--p-primary-hover-color` | `var(--p-primary-800)` | `var(--p-primary-300)` |
| `--p-primary-active-color` | `var(--p-primary-900)` | `var(--p-primary-200)` |
| `--p-primary-contrast-color` | `#ffffff` | `var(--p-surface-900)` |

(Verified in `preset.ts` for light and in stock Aura for the untouched dark side; matches corker's read from a running admin in #1493.) Overriding `--p-primary-color` cascades to direct consumers (`--p-button-primary-background` resolves via chained `var()`) but not to hover/active, which keep tracking those shades.

For a full palette swap, the user must override the shade tokens or each derived token explicitly. Document this as a known tradeoff of the no-API approach. A future `admin/theme.ts` JS preset bridge (using PrimeVue's `definePreset`) would fix this — deferred until product maturity warrants the added surface area.

## Don't use

- **Tailwind / UnoCSS** — overkill for ~350 LOC of component CSS
- **CSS Modules** — Vue `<style scoped>` is equivalent
- **Pinia-driven runtime theming** — JS-applied styles can't participate in `:hover`, `@media`, or CSS animations cheaply, and they duplicate what PrimeVue's `.dark` class already does
- **Custom radius/spacing scales** — PrimeVue's are fine

## Verification notes

All PrimeVue token behaviors in this doc were verified live against the running dev server (chromium + `getComputedStyle(document.documentElement)`), not from documentation. If PrimeVue upgrades change token emission, re-run the check.

## Visual testing (deferred)

We tried a Playwright `toHaveScreenshot` baseline for PublishDialog and dropped it. Reasons to revisit later, not now:

**Why we dropped it:**
- Baselines are per-platform. CI is Linux, local dev is macOS — every dev needs docker to regenerate before commit, or only CI can update baselines (friction either way).
- Every intentional visual change requires re-baselining. For a prototype UI moving fast, the maintenance tax outpaces the regression-catching value.
- Catches pixel-level regressions but misses semantic regressions (a button moved to the wrong place but still renders). A11y / semantic tests catch more real bugs.
- Site developers using Gazetta as an npm dependency never run our e2e suite — the snapshots only protect Gazetta core development, not their projects.

**Alternatives when we need visual regression:**

| Need | Tool |
|---|---|
| Catch unintended visual changes in core admin | Playwright `toHaveScreenshot` with CI-generated baselines. Gate to `process.platform === 'linux'` and commit only Linux PNGs. Regenerate via `docker run mcr.microsoft.com/playwright:vX.Y.Z-jammy ... --update-snapshots` |
| Explore component variants while designing | The existing `/admin/dev` playground. Extend with fixture props if needed. |
| Design-system-level visual review | **Storybook is installed** (`@storybook/vue3-vite`, `npm run storybook`, existing `.stories.ts` files) — this "not worth the setup until 40+ components" note is stale; disregard it. Storybook's role + the DevPlayground-vs-Storybook coherence split are defined in [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md) (stories as bot-executable UX specs). Dedicated *visual-regression* (`toHaveScreenshot`) testing remains deferred per the rows above — that's a separate concern from component stories. |
| Site developers catching their own regressions | They write their own Playwright tests against the running admin using our `data-testid` attributes |

**When to reintroduce:**
- Core admin stabilizes and visual changes are intentional, rare
- Gazetta core gains a contributor who needs design-review workflows
- A specific visual regression is found in the wild and warrants a regression test

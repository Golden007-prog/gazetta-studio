import type { Preview } from '@storybook/vue3-vite'
import { setup } from '@storybook/vue3-vite'
import { withThemeByClassName } from '@storybook/addon-themes'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'

// App-level CSS tokens (--color-*). Defined in apps/admin/src/client/assets/
// tokens.css; layered on top of PrimeVue Aura semantic tokens. See
// .claude/rules/css-theming.md for the token model.
import 'primeicons/primeicons.css'
import '../apps/admin/src/client/assets/tokens.css'
import '../apps/admin/src/client/assets/base.css'
import { adminPreset } from '../apps/admin/src/client/assets/preset'

// Register Pinia + PrimeVue once per preview boot. Matches apps/admin/src/
// client/main.ts's plugin install order (Pinia first, then PrimeVue) so
// stories see the same plugin context as the running admin. VueQuery /
// Router / service worker / IndexedDB persistence are intentionally
// omitted — stories that need router or store data mock per-story.
//
// PrimeVue's darkModeSelector: '.dark' matches main.ts AND the
// withThemeByClassName decorator below — toggling the toolbar theme flips
// the same class the running app uses, so the entire Aura semantic-token
// set (--p-text-color, --p-content-background, --p-primary-color, etc.)
// re-resolves to dark values. See .claude/rules/css-theming.md for the
// verified light/dark token table.
setup(app => {
  app.use(createPinia())
  app.use(PrimeVue, {
    theme: {
      preset: adminPreset,
      options: { darkModeSelector: '.dark' },
    },
  })
})

const preview: Preview = {
  decorators: [
    // Both light + dark land an explicit class on <html>. Per team-
    // preferences rule 12 the running app applies both classes (only one
    // active at a time); the decorator mirrors that so stories render
    // identically to the deployed admin.
    withThemeByClassName({
      themes: { light: 'light', dark: 'dark' },
      defaultTheme: 'light',
      parentSelector: 'html',
    }),
  ],
  parameters: {
    // Fail the story run on axe violations (#524, ADR-0016), color-contrast
    // included (#863). The addon's default only reports them, which would
    // leave the a11y half of the story gate advisory.
    a11y: { test: 'error' },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
}

export default preview

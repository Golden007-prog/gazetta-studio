import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // `virtual:pwa-register/vue` is created at build time by
      // vite-plugin-pwa; vitest's dev resolver doesn't see it.
      // Alias to a stub so modules importing the virtual specifier
      // load cleanly during tests. Tests that drive the update
      // flow override via `vi.mock('virtual:pwa-register/vue')`.
      'virtual:pwa-register/vue': fileURLToPath(
        new URL('./tests/_setup/virtual-pwa-register-stub.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    // Node 25's built-in Web Storage globals shadow jsdom's and lack clear().
    execArgv: ['--no-experimental-webstorage'],
  },
})

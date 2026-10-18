/**
 * Smoke story — proves the Storybook wiring boots and the Aura theme
 * tokens resolve in both light and dark modes. Renders a PrimeVue Button
 * with no admin component dependency, so a regression here means the
 * Storybook setup itself is broken (preview.ts decorators, plugin
 * registration, theme decorator), not an admin component.
 *
 * Real component stories live next to their `.vue` source — see
 * STORYBOOK.md for the convention.
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import Button, { type ButtonProps } from 'primevue/button'

// Typed by props and rendered from a template: PrimeVue declares Button
// with its own DefineComponent helper, which `Meta<typeof Button>` rejects.
const meta: Meta<ButtonProps> = {
  title: 'Smoke/PrimeVue Button',
  render: args => ({ components: { Button }, setup: () => ({ args }), template: '<Button v-bind="args" />' }),
}

export default meta

type Story = StoryObj<ButtonProps>

export const Primary: Story = {
  args: { label: 'Primary', severity: 'primary' },
}

export const Secondary: Story = {
  args: { label: 'Secondary', severity: 'secondary' },
}

export const Danger: Story = {
  args: { label: 'Delete', severity: 'danger', icon: 'pi pi-trash' },
}

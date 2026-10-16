/**
 * Stories for Banner — the presentational frame extracted per
 * design-review-workflow.md "UX implementation foundation". ReviewBanner
 * composes it, so these stories are the visual + a11y contract for every
 * severity it can paint.
 *
 * Prop + slot driven; no store seeding. Each story runs in light and
 * dark under `npm run test:storybook` with axe as a hard gate (ADR-0016).
 */
import type { Meta, StoryObj } from '@storybook/vue3-vite'
import Button from 'primevue/button'
import Banner from './Banner.vue'

const meta: Meta<typeof Banner> = {
  title: 'Primitives / Banner',
  component: Banner,
  argTypes: {
    severity: { control: 'select', options: ['danger', 'warning', 'info', 'success'] },
    role: { control: 'select', options: [undefined, 'alert', 'status'] },
    icon: { control: 'text' },
    dismissible: { control: 'boolean' },
    onDismiss: { action: 'dismiss' },
  },
}

export default meta
type Story = StoryObj<typeof Banner>

/** Message-only render: the default slot carries the copy. */
function withMessage(message: string): Story['render'] {
  return args => ({
    components: { Banner },
    setup: () => ({ args, message }),
    template: '<Banner v-bind="args">{{ message }}</Banner>',
  })
}

/** Render with the `#actions` slot filled by PrimeVue Buttons. */
function withActions(message: string): Story['render'] {
  return args => ({
    components: { Banner, Button },
    setup: () => ({ args, message }),
    template: `
      <Banner v-bind="args">
        {{ message }}
        <template #actions>
          <Button label="Approve" icon="pi pi-check" size="small" data-testid="story-approve" />
          <Button label="Reject" icon="pi pi-times" size="small" text severity="danger" data-testid="story-reject" />
        </template>
      </Banner>`,
  })
}

export const Danger: Story = {
  args: { severity: 'danger' },
  render: withMessage('Save failed — 2 references point at missing assets.'),
}

export const Warning: Story = {
  args: { severity: 'warning' },
  render: withMessage('Pending review — 0 of 1 approvals.'),
}

export const Info: Story = {
  args: { severity: 'info' },
  render: withMessage('Draft — not yet submitted for review.'),
}

export const Success: Story = {
  args: { severity: 'success' },
  render: withMessage('Approved 2 hours ago by alice@example.com.'),
}

/** `#actions` slot — the shape ReviewBanner's PendingAsApprover uses. */
export const WithActions: Story = {
  args: { severity: 'warning' },
  render: withActions('Pending review — 0 of 1 approvals.'),
}

/** Dismiss button; clicking it emits `dismiss` (consumer owns visibility). */
export const Dismissible: Story = {
  args: { severity: 'info', dismissible: true },
  render: withMessage('Template `hero` changed — 2 items affected.'),
}

/** Actions and dismiss together: dismiss sits after the actions. */
export const WithActionsAndDismiss: Story = {
  args: { severity: 'danger', dismissible: true },
  render: withActions('Changes requested by bob@example.com.'),
}

/** `icon` overrides the per-severity default. */
export const CustomIcon: Story = {
  args: { severity: 'warning', icon: 'pi pi-archive' },
  render: withMessage('Archived. Pure soft-delete — old URL returns 410 Gone.'),
}

/** `role` overrides the per-severity default (here: a non-interrupting warning). */
export const StatusRoleOverride: Story = {
  args: { severity: 'warning', role: 'status' },
  render: withMessage('Pending review — submitted 5 minutes ago.'),
}

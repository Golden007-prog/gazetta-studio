// @vitest-environment jsdom
/**
 * #1345: asset fields are `type: object` in JSON Schema, and rjsf
 * ignores `ui:widget` on object schemas - the editor showed a raw
 * `_asset` text input instead of the asset picker. mount.tsx now marks
 * asset fields with `ui:field: 'embedded-asset'` at any depth and
 * AssetEmbeddedField adapts the widget to the field props.
 *
 * Verified fail-unfixed before commit: on main's code the picker
 * button is absent and a `root_...__asset` text input renders for the
 * top-level, array-item and nested-object cases.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { embeddedAsset } from '../src/schema/helpers.js'
import { DefaultEditorForm } from '../src/editor/mount.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // The widget fetches a summary whenever an asset is selected; tests
  // stub it so rendering does not depend on a server.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function renderForm(
  schema: z.ZodType,
  content: Record<string, unknown>,
  onChange = () => {},
  onPickAsset: () => Promise<{ _asset: string } | null> = async () => null,
) {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>
  act(() => {
    root.render(
      React.createElement(DefaultEditorForm, {
        schema: jsonSchema,
        content,
        onChange,
        onPickAsset,
      }),
    )
  })
  return container
}

function pickButton() {
  return container.querySelector('[data-testid="asset-widget-pick"]')
}

function rawAssetInputs() {
  return [...container.querySelectorAll('input')].filter(el => el.id.endsWith('__asset') || el.id.endsWith('_asset'))
}

describe('editor embedded-asset field (#1345)', () => {
  it('renders the picker for a top-level embeddedAsset field, not a raw _asset input', () => {
    renderForm(z.object({ hero: embeddedAsset() }), {})
    expect(pickButton()).not.toBeNull()
    expect(rawAssetInputs()).toHaveLength(0)
  })

  it('renders the picker for an embeddedAsset inside z.array(...)', () => {
    renderForm(z.object({ slides: z.array(embeddedAsset()) }), { slides: [{}] })
    expect(pickButton()).not.toBeNull()
    expect(rawAssetInputs()).toHaveLength(0)
  })

  it('renders the picker for an embeddedAsset inside a nested z.object(...)', () => {
    renderForm(z.object({ section: z.object({ pic: embeddedAsset() }) }), { section: {} })
    expect(pickButton()).not.toBeNull()
    expect(rawAssetInputs()).toHaveLength(0)
  })

  it('clears an optional asset field via the Clear action', () => {
    let latest: Record<string, unknown> = {}
    renderForm(z.object({ hero: embeddedAsset().optional() }), { hero: { _asset: 'old-pic' } }, c => {
      latest = c
    })
    const clear = container.querySelector('[data-testid="asset-widget-clear"]') as HTMLButtonElement | null
    expect(clear).not.toBeNull()
    act(() => {
      clear!.click()
    })
    expect(latest).toEqual({ hero: {} })
  })

  it('propagates a picked asset to the field, not the form root', async () => {
    let latest: Record<string, unknown> = {}
    renderForm(
      z.object({ hero: embeddedAsset().optional() }),
      { hero: { _asset: 'old-pic' } },
      c => {
        latest = c
      },
      async () => ({ _asset: 'new-pic' }),
    )
    const pick = container.querySelector('[data-testid="asset-widget-pick"]') as HTMLButtonElement
    expect(pick).not.toBeNull()
    await act(async () => {
      pick.click()
      await new Promise(r => setTimeout(r, 50))
    })
    expect(latest).toEqual({ hero: { _asset: 'new-pic' } })
  })
})

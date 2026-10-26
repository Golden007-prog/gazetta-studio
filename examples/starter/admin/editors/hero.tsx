/**
 * Custom editor for the "hero" template.
 * Demonstrates: live preview + embedded DefaultEditorForm + theme-aware styling.
 */
import React, { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DefaultEditorForm } from 'gazetta/editor'
import type { EditorMount } from 'gazetta/types'

interface HeroContent {
  title?: string
  subtitle?: string
}

function HeroEditor(props: {
  content: HeroContent
  schema: Record<string, unknown>
  onChange: (content: Record<string, unknown>) => void
  theme: 'dark' | 'light'
  fieldsBaseUrl?: string
  onPickAsset?: (options: { accept?: string[]; currentAssetName?: string | null }) => Promise<{ _asset: string } | null>
}) {
  const [data, setData] = useState<HeroContent>(props.content)

  const handleChange = (c: Record<string, unknown>) => {
    setData(c as HeroContent)
    props.onChange(c)
  }

  return (
    <div>
      {/* Live preview */}
      <div
        style={{
          padding: '1.5rem',
          background: 'linear-gradient(135deg, #667eea, #764ba2)',
          borderRadius: '8px',
          marginBottom: '1rem',
          color: '#fff',
          textAlign: 'center' as const,
        }}
      >
        <h2 style={{ fontSize: '1.5rem', fontWeight: 700, margin: '0 0 0.5rem' }}>{data.title || 'Untitled'}</h2>
        {data.subtitle && <p style={{ fontSize: '1rem', opacity: 0.85, margin: 0 }}>{data.subtitle}</p>}
      </div>

      {/* Default form below. Forward every prop so custom fields
          (fieldsBaseUrl) and the asset picker (onPickAsset) keep
          working inside it. */}
      <DefaultEditorForm
        {...props}
        schema={props.schema}
        content={data as Record<string, unknown>}
        onChange={handleChange}
      />
    </div>
  )
}

const roots = new WeakMap<HTMLElement, Root>()

const editor: EditorMount = {
  mount(el, props) {
    const root = createRoot(el)
    roots.set(el, root)
    root.render(
      <HeroEditor
        content={props.content as HeroContent}
        schema={props.schema}
        onChange={props.onChange}
        theme={props.theme}
        fieldsBaseUrl={props.fieldsBaseUrl}
        onPickAsset={props.onPickAsset}
      />,
    )
  },
  unmount(el) {
    roots.get(el)?.unmount()
    roots.delete(el)
  },
}

export default editor

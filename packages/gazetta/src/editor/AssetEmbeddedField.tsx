/**
 * React rjsf field for an embedded-asset schema field (#1345).
 *
 * Asset fields are `type: object` in JSON Schema, and rjsf renders
 * ObjectField for any object schema: `ui:widget` is ignored there,
 * only `ui:field` replaces it (SchemaField's getFieldComponent).
 * mount.tsx marks every asset field with `'ui:field': 'embedded-asset'`
 * at any depth (top level, inside arrays, inside nested objects) and
 * this field adapts the existing AssetEmbeddedWidget to the field
 * props shape, so the whole object ({_asset, alt, focalPoint}) is
 * rendered by the widget instead of a raw _asset text input.
 */
import React from 'react'
import type { FieldProps, WidgetProps } from '@rjsf/utils'
import { AssetEmbeddedWidget } from './AssetEmbeddedWidget.js'

export function AssetEmbeddedField(props: FieldProps) {
  const widgetProps = {
    id: props.idSchema?.$id ?? props.name,
    schema: props.schema,
    uiSchema: props.uiSchema,
    value: props.formData,
    required: props.required,
    disabled: props.disabled,
    readonly: props.readonly,
    autofocus: props.autofocus,
    rawErrors: props.rawErrors,
    formContext: props.registry?.formContext,
    registry: props.registry,
    options: {},
    multiple: false,
    label: (props.schema?.title as string | undefined) ?? props.name,
    placeholder: '',
    // rjsf 6 wants the field's own absolute path here (see StringField):
    // a wrong path replaces the wrong level of the form data.
    onChange: (value: unknown) => props.onChange(value, props.fieldPathId?.path ?? []),
    onBlur: () => {},
    onFocus: () => {},
  } as unknown as WidgetProps
  return <AssetEmbeddedWidget {...widgetProps} />
}

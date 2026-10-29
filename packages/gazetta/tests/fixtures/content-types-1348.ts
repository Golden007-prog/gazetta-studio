import { z } from 'zod'
import { embeddedAsset, downloadable, fontAsset } from '../../src/schema/helpers.js'
import type {
  Content,
  ResolvedEmbeddedAsset,
  ResolvedDownloadableAsset,
  ResolvedFontAsset,
} from '../../src/schema/types.js'
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
const schema = z.object({
  image: embeddedAsset().optional(),
  nullable: embeddedAsset().nullable(),
  nullish: embeddedAsset().nullish(),
  gallery: z.array(embeddedAsset()),
  files: z.array(downloadable().optional()).optional(),
  font: fontAsset().nullable(),
  nested: z.object({ image: embeddedAsset().optional(), title: z.string() }),
  title: z.string().optional(),
})
type R = Content<z.infer<typeof schema>>
type Same = Assert<Equal<Content<typeof schema>, R>>
type Optional = Assert<Equal<R['image'], ResolvedEmbeddedAsset | undefined>>
type Nullable = Assert<Equal<R['nullable'], ResolvedEmbeddedAsset | null>>
type Nullish = Assert<Equal<R['nullish'], ResolvedEmbeddedAsset | null | undefined>>
type Array = Assert<Equal<R['gallery'], ReadonlyArray<ResolvedEmbeddedAsset>>>
type OptionalArray = Assert<Equal<R['files'], ReadonlyArray<ResolvedDownloadableAsset | undefined> | undefined>>
type Font = Assert<Equal<R['font'], ResolvedFontAsset | null>>
type Nested = Assert<Equal<R['nested'], { image?: ResolvedEmbeddedAsset; title: string }>>
type Primitive = Assert<Equal<R['title'], string | undefined>>
type Unbranded = Assert<Equal<Content<{ _asset: string }>, { _asset: string }>>
type Union = Assert<Equal<Content<z.infer<ReturnType<typeof embeddedAsset>> | string>, ResolvedEmbeddedAsset | string>>
export type Checks =
  | Same
  | Optional
  | Nullable
  | Nullish
  | Array
  | OptionalArray
  | Font
  | Nested
  | Primitive
  | Unbranded
  | Union

const anySchema = z.any()
const anyFieldSchema = z.object({ value: z.any() })
type AnyInput = Assert<Equal<Content<any>, any>>
type AnySchema = Assert<Equal<Content<typeof anySchema>, any>>
type AnyField = Assert<Equal<Content<typeof anyFieldSchema>, { value: any }>>
export type AnyChecks = AnyInput | AnySchema | AnyField
